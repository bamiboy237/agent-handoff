// Hero demo: a Claude Code session hands its task off, then the sandbox
// picks it up and finishes with a draft pull request. It plays when scrolled
// into view, loops, and can be interrupted with the tabs or the replay button.
// With reduced motion it shows the finished story without typing or movement.

const PROMPT = "I have to close my laptop. Keep going in the cloud.";
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]; // Claude Code's glyph cycle
const SPINNER_FRAME_MS = 120;
const HOLD_BEFORE_LOOP_MS = 5000;

const LAPTOP_SCRIPT = [
  { kind: "assistant", text: "I'll hand this off to a cloud sandbox so the work keeps going." },
  {
    kind: "tool",
    name: "agent-handoff - handoff_prepare (MCP)",
    args: '(brief: {"title": "Add multiply and tests", …})',
    result: "Handoff h3k9 warming on daytona. codex will continue the task.",
    runMs: 1100,
  },
  {
    kind: "tool",
    name: "agent-handoff - handoff_start (MCP)",
    args: '(handoffId: "h3k9")',
    result: "h3k9 is starting. End your turn now.",
    runMs: 800,
  },
  { kind: "assistant", text: "Moving to the cloud. You can close your laptop." },
];

// Boot steps carry real timings; the agent and finish steps are paced for reading.
const SANDBOX_BOOT = [
  [0.21, "sandbox started from cache"],
  [0.58, "codex 0.163.0 ready"],
  [1.02, "cloned handoff/h3k9  ·  3 files"],
  [1.71, "npm ci"],
  [1.84, "codex resumed from the brief"],
];
const SANDBOX_AGENT = [
  "reading the brief",
  "edited src/math.js  +4",
  "created test/math.test.js  +44",
  "ran npm test  ✓ 6 passed",
  "committed “Add multiply and tests”",
];
const SANDBOX_DONE = ["pushed handoff/h3k9-result", "draft PR #12 opened  →  github.com/you/billing-api/pull/12"];

const demo = document.querySelector("[data-demo]");
if (demo) {
  const tabs = [...demo.querySelectorAll("[role=tab]")];
  const panes = tabs.map((tab) => document.getElementById(tab.getAttribute("aria-controls")));
  const laptop = panes[0];
  const scroller = demo.querySelector("[data-scroll]");
  const transcript = demo.querySelector("[data-transcript]");
  const typed = demo.querySelector("[data-typed]");
  const hint = demo.querySelector("[data-hint]");
  const log = demo.querySelector("[data-log]");
  const timer = demo.querySelector("[data-timer]");
  const replay = demo.querySelector(".replay");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Each run gets a generation number; a newer run makes older waits reject.
  const CANCELLED = Symbol("cancelled");
  let generation = 0;
  let spinnerTimer;

  const wait = (ms, gen) =>
    new Promise((resolve, reject) =>
      setTimeout(() => (gen === generation ? resolve() : reject(CANCELLED)), reduceMotion ? 0 : ms),
    );

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // A terminal keeps the newest line in view.
  function pinToBottom() {
    scroller.scrollTop = scroller.scrollHeight;
  }

  // New lines fade up from just below, like terminal output.
  function show(parent, node) {
    node.classList.add("enter");
    parent.append(node);
    if (parent === transcript) pinToBottom();
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add("in")));
    return node;
  }

  function selectPane(index) {
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    panes.forEach((pane, i) => (pane.hidden = i !== index));
  }

  function assistantLine(text) {
    const line = el("p", "cc-line");
    line.append(el("span", "cc-bullet", "⏺"), text);
    return line;
  }

  function toolLine(step) {
    const line = el("p", "cc-line cc-pending");
    line.append(el("span", "cc-bullet", "⏺"), el("span", "cc-tool-name", step.name), el("span", "cc-dim", step.args));
    return line;
  }

  function resultLine(text) {
    return el("p", "cc-line cc-result", `⎿  ${text}`);
  }

  function sandboxLine(time, text, variant = "") {
    const line = el("p", `sb-line ${variant}`.trim());
    line.append(el("span", "sb-time", time), el("span", "sb-text", text));
    return line;
  }

  function reset() {
    clearInterval(spinnerTimer);
    transcript.replaceChildren();
    log.replaceChildren();
    typed.textContent = "";
    timer.textContent = "0.00s";
    hint.textContent = "  ? for shortcuts";
    laptop.classList.remove("handed-off");
    scroller.scrollTop = 0;
    selectPane(0);
  }

  // The finished story, for reduced motion and for a tab opened before its turn.
  function renderLaptopDone() {
    transcript.replaceChildren(el("p", "cc-line cc-user", `> ${PROMPT}`));
    for (const step of LAPTOP_SCRIPT) {
      if (step.kind === "assistant") transcript.append(assistantLine(step.text));
      else {
        const line = toolLine(step);
        line.classList.replace("cc-pending", "cc-ok");
        transcript.append(line, resultLine(step.result));
      }
    }
    typed.textContent = "";
    laptop.classList.add("handed-off");
    hint.textContent = "  handed off  ·  this session is now read-only";
    pinToBottom();
  }

  function renderSandboxDone() {
    log.replaceChildren(
      ...SANDBOX_BOOT.map(([t, text]) => sandboxLine(`${t.toFixed(2)}s`, text)),
      ...SANDBOX_AGENT.map((text) => sandboxLine("codex", text, "sb-agent")),
      ...SANDBOX_DONE.map((text) => sandboxLine("done", text, "sb-done")),
    );
    timer.textContent = "ready in 1.84s";
  }

  async function typePrompt(gen) {
    for (let i = 0; i < PROMPT.length; i++) {
      typed.textContent = PROMPT.slice(0, i + 1);
      // Deterministic jitter so the typing feels human without random flicker.
      const pause = PROMPT[i] === " " ? 70 : PROMPT[i] === "." ? 160 : 32 + ((PROMPT.charCodeAt(i) * 7) % 28);
      await wait(pause, gen);
    }
  }

  async function spin(gen, label, ms) {
    const line = show(transcript, el("p", "cc-line cc-spinner"));
    const started = performance.now();
    let frame = 0;
    const draw = () => {
      const seconds = Math.floor((performance.now() - started) / 1000);
      line.textContent = `${SPINNER[frame++ % SPINNER.length]} ${label}… (${seconds}s · esc to interrupt)`;
    };
    draw();
    spinnerTimer = setInterval(draw, SPINNER_FRAME_MS);
    try {
      await wait(ms, gen);
    } finally {
      clearInterval(spinnerTimer);
      line.remove();
    }
  }

  async function playLaptop(gen) {
    await wait(700, gen);
    await typePrompt(gen);
    await wait(380, gen);
    typed.textContent = "";
    show(transcript, el("p", "cc-line cc-user", `> ${PROMPT}`));
    await spin(gen, "Handing off", 1400);

    for (const step of LAPTOP_SCRIPT) {
      if (step.kind === "assistant") {
        show(transcript, assistantLine(step.text));
        await wait(600, gen);
        continue;
      }
      const line = show(transcript, toolLine(step));
      await wait(step.runMs, gen);
      line.classList.replace("cc-pending", "cc-ok");
      show(transcript, resultLine(step.result));
      await wait(500, gen);
    }

    await wait(500, gen);
    laptop.classList.add("handed-off");
    hint.textContent = "  handed off  ·  this session is now read-only";
    await wait(1500, gen);
  }

  async function playSandbox(gen) {
    selectPane(1);
    await wait(400, gen);
    // The boot log runs on its real clock, so the timer and lines stay in step.
    const started = performance.now();
    let next = 0;
    while (next < SANDBOX_BOOT.length) {
      const elapsed = (performance.now() - started) / 1000;
      timer.textContent = `${elapsed.toFixed(2)}s`;
      while (next < SANDBOX_BOOT.length && SANDBOX_BOOT[next][0] <= elapsed) {
        const [t, text] = SANDBOX_BOOT[next++];
        show(log, sandboxLine(`${t.toFixed(2)}s`, text));
      }
      await wait(16, gen);
    }
    timer.textContent = "ready in 1.84s";
    await wait(700, gen);
    for (const text of SANDBOX_AGENT) {
      show(log, sandboxLine("codex", text, "sb-agent"));
      await wait(750, gen);
    }
    for (const text of SANDBOX_DONE) {
      show(log, sandboxLine("done", text, "sb-done"));
      await wait(600, gen);
    }
  }

  async function play() {
    const gen = ++generation;
    reset();
    try {
      await playLaptop(gen);
      await playSandbox(gen);
      await wait(HOLD_BEFORE_LOOP_MS, gen);
      if (userControlled) return;
      if (isVisible) play();
      else pendingLoop = true;
    } catch (error) {
      if (error !== CANCELLED) throw error;
    }
  }

  // Picking a tab stops the story and shows that pane finished. The loop stays
  // stopped until replay, so scrolling away and back never wipes the pane.
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      userControlled = true;
      pendingLoop = false;
      generation++;
      clearInterval(spinnerTimer);
      renderLaptopDone();
      if (index === 1) renderSandboxDone();
      selectPane(index);
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const next = (index + 1) % tabs.length;
      tabs[next].click();
      tabs[next].focus();
    });
  });

  replay.addEventListener("click", () => {
    if (reduceMotion) return;
    userControlled = false;
    play();
  });

  let isVisible = false;
  let pendingLoop = false;
  let started = false;
  let userControlled = false;

  if (reduceMotion) {
    renderLaptopDone();
    renderSandboxDone();
    selectPane(0);
    replay.hidden = true;
  } else {
    new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
        if (!isVisible) return;
        if (!started || pendingLoop) {
          started = true;
          pendingLoop = false;
          play();
        }
      },
      { threshold: 0.35 },
    ).observe(demo);
  }
}
