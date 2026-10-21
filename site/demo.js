// The hero demo: one continuous story that loops.
//   1 Claude Code on your machine hands the task to OpenCode in the cloud
//   2 OpenCode, running a Codex model, picks it up in the sandbox and finishes it
//   3 Back in the same Claude Code session, the draft pull request is waiting
// Plays only while visible. With reduced motion each scene appears finished,
// without typing, and scenes swap with a plain fade.

const PROMPT = "I have to go. Let OpenCode finish this in the cloud.";
const FOLLOW_UP = "How did the handoff go?";
const PR_URL = "https://github.com/you/billing-api/pull/12";
const CLAUDE_SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const HOLD_MS = 2400; // how long a finished scene stays before the next one
const SLOWDOWN = 2.5; // stretches every pause, keystroke, and hold, so the story reads at a calm pace

const root = document.querySelector(".demo");
if (root) {
  const screensEl = root.querySelector("[data-screens]");
  const screen = root.querySelector("[data-screen]");
  const titleEl = root.querySelector("[data-title]");
  const instant = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // While paused (off screen or tab hidden), waits freeze instead of ending,
  // so the story resumes where it was rather than restarting.
  const TICK_MS = 50;
  let paused = true;
  let spinnerTimer;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function wait(ms) {
    return new Promise((resolve) => {
      let left = ms * SLOWDOWN;
      const tick = () => {
        if (left <= 0) return resolve();
        const step = Math.min(left, TICK_MS);
        setTimeout(() => {
          if (!paused) left -= step;
          tick();
        }, step);
      };
      tick();
    });
  }

  // Typing and spinners only run with motion; reduced motion skips straight past them.
  const pace = (ms) => (instant ? Promise.resolve() : wait(ms));

  function show(parent, node, scroller) {
    if (!instant) {
      node.classList.add("enter");
      requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add("in")));
    }
    parent.append(node);
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    return node;
  }

  async function type(target, text) {
    for (let i = 0; i < text.length; i++) {
      target.textContent = text.slice(0, i + 1);
      const ch = text[i];
      await pace(ch === " " ? 65 : ch === "." ? 150 : 28 + ((text.charCodeAt(i) * 7) % 26));
    }
  }

  async function spin(ui, ms, render) {
    if (instant) return;
    const line = show(ui.transcript, el("p", "line"), ui.scroll);
    const started = performance.now();
    let frame = 0;
    const draw = () => render(line, frame++, Math.floor((performance.now() - started) / 1000));
    draw();
    spinnerTimer = setInterval(draw, 120);
    try {
      await wait(ms);
    } finally {
      clearInterval(spinnerTimer);
      line.remove();
    }
  }

  // A terminal frame: a header box, a transcript pinned to the bottom, an input box.
  function frame(header, inputMark) {
    const scroll = el("div", "scroll");
    const head = el("div", "welcome");
    head.append(header);
    const transcript = el("div", "transcript");
    scroll.append(head, transcript);
    const input = el("div", "input");
    const typed = el("span", "typed");
    input.append(el("span", "", inputMark), typed, el("span", "cursor"));
    screen.replaceChildren(scroll, input);
    return { scroll, transcript, typed };
  }

  async function submit(ui, text, className) {
    await pace(500);
    await type(ui.typed, text);
    await pace(350);
    ui.typed.textContent = "";
    return show(ui.transcript, el("p", `line ${className}`, `> ${text}`), ui.scroll);
  }

  // Claude Code
  function claudeFrame() {
    screen.classList.remove("oc");
    const head = el("p");
    head.append(el("span", "orange", "✻"), " Welcome to ", el("b", "", "Claude Code"), "!");
    return frame(head, ">");
  }

  const claudeSpin = (ui, label, ms) =>
    spin(ui, ms, (line, i, s) => {
      line.className = "line orange";
      line.textContent = `${CLAUDE_SPINNER[i % CLAUDE_SPINNER.length]} ${label}… (${s}s · esc to interrupt)`;
    });

  function claudeSays(ui, text) {
    const p = el("p", "line");
    p.append(el("span", "bullet", "●"), text);
    return show(ui.transcript, p, ui.scroll);
  }

  async function claudeTool(ui, name, args, runMs, ...output) {
    const call = el("p", "line running");
    call.append(el("span", "bullet", "●"), el("b", "", name), el("span", "dim", args));
    show(ui.transcript, call, ui.scroll);
    await pace(runMs);
    call.classList.replace("running", "ok");
    for (const parts of output) {
      const p = el("p", "line result");
      p.append(...parts);
      show(ui.transcript, p, ui.scroll);
    }
    await pace(420);
  }

  // OpenCode, in its default dark theme, running a Codex model
  function opencodeFrame() {
    const tabs = el("p", "oc-tabs");
    tabs.append(el("b", "", "Add multiply and tests"));
    const scroll = el("div", "scroll");
    const transcript = el("div", "transcript");
    scroll.append(transcript);
    const input = el("div", "oc-input");
    const prompt = el("p");
    prompt.append(el("span", "typed"), el("span", "cursor"));
    const mode = el("p", "oc-mode");
    const status = el("span", "oc-status");
    mode.append(el("span", "oc-accent", "Build"), el("span", "oc-muted", " · "), el("b", "", "GPT-5 Codex"), el("span", "oc-muted", " OpenAI"), status);
    input.append(prompt, mode);
    const footer = el("p", "oc-footer");
    const keys = el("span", "oc-keys");
    keys.append("shift+tab", el("span", "oc-muted", " agents  "), "ctrl+p", el("span", "oc-muted", " commands"));
    footer.append(el("span", "oc-muted", "~/workspace/billing-api:handoff/h3k9-result"), keys);
    screen.replaceChildren(tabs, scroll, input, footer);
    screen.classList.add("oc");
    return { scroll, transcript, status };
  }

  // OpenCode's working indicator: a block that sweeps back and forth under the prompt.
  async function opencodeWork(ui, ms) {
    if (instant) return;
    let frame = 0;
    const draw = () => {
      const at = Math.abs(((frame++ + 6) % 12) - 6);
      ui.status.textContent = `${"⬝".repeat(at)}■${"⬝".repeat(6 - at)}  esc interrupt`;
    };
    draw();
    spinnerTimer = setInterval(draw, 90);
    try {
      await wait(ms);
    } finally {
      clearInterval(spinnerTimer);
      ui.status.textContent = "";
    }
  }

  function opencodeTool(ui, mark, name, target, block) {
    const p = el("p", "line");
    p.append(el("span", "oc-muted", `${mark} `), name, " ", el("span", "oc-muted", target));
    show(ui.transcript, p, ui.scroll);
    if (block) show(ui.transcript, block, ui.scroll);
  }

  function opencodeBlock(...lines) {
    const block = el("div", "oc-block");
    for (const parts of lines) {
      const p = el("p", "line");
      p.append(...parts);
      block.append(p);
    }
    return block;
  }

  const SCENES = [
    {
      title: "~/code/billing-api",
      async play() {
        const ui = claudeFrame();
        await submit(ui, PROMPT, "user");
        await claudeSpin(ui, "Handing off", 1300);
        claudeSays(ui, "I'll hand this to OpenCode in a cloud sandbox.");
        await pace(500);
        await claudeTool(ui, "agent-handoff - handoff_prepare (MCP)", '(targetAgent: "opencode", brief: {…})', 1000, ["⎿  Sandbox warming on daytona."]);
        await claudeTool(ui, "agent-handoff - handoff_start (MCP)", '(handoffId: "h3k9")', 700, ["⎿  Handoff h3k9 is starting. opencode continues the work in the sandbox."]);
        claudeSays(ui, "Your uncommitted changes are on their way. You can close your laptop.");
        return ui;
      },
    },
    {
      title: "/home/daytona/workspace/billing-api",
      async play() {
        const ui = opencodeFrame();
        const brief = el("p", "line oc-user", "Continue the handoff from Claude Code: add multiply() with tests, then commit.");
        show(ui.transcript, brief, ui.scroll);
        await opencodeWork(ui, 1400);
        opencodeTool(ui, "←", "Edit", "src/math.js", opencodeBlock(
          [el("span", "green", "+export function multiply(a, b) {")],
          [el("span", "green", "+  return a * b;")],
          [el("span", "green", "+}")],
        ));
        await opencodeWork(ui, 700);
        opencodeTool(ui, "←", "Write", "test/math.test.js");
        await opencodeWork(ui, 1000);
        opencodeTool(ui, "$", "npm test", "", opencodeBlock([el("span", "green", "✔"), " 6 passed, 0 failed"]));
        await opencodeWork(ui, 700);
        opencodeTool(ui, "$", 'git commit -am "Add multiply and tests"', "", opencodeBlock(["[handoff/h3k9-result 817641d] Add multiply and tests"]));
        await opencodeWork(ui, 600);
        show(ui.transcript, el("p", "line", "Added multiply() with tests. All 6 pass, and the work is committed."), ui.scroll);
        show(ui.transcript, el("p", "line oc-muted", "Build · GPT-5 Codex · 41s"), ui.scroll);
      },
    },
    {
      title: "~/code/billing-api",
      async play(previous) {
        // The same session as scene one, so its last exchange is still on screen.
        const ui = claudeFrame();
        for (const node of previous.transcript.children) ui.transcript.append(node.cloneNode(true));
        ui.scroll.scrollTop = ui.scroll.scrollHeight;
        await submit(ui, FOLLOW_UP, "user");
        await claudeSpin(ui, "Checking", 900);
        await claudeTool(
          ui,
          "agent-handoff - handoff_status (MCP)",
          "",
          800,
          ["⎿  Handoff h3k9 completed."],
          ["   Draft pull request: ", el("u", "", PR_URL)],
        );
        const p = el("p", "line");
        p.append(el("span", "bullet", "●"), "OpenCode finished. The draft pull request adds multiply() with 6 passing tests: ", el("u", "", PR_URL));
        show(ui.transcript, p, ui.scroll);
      },
    },
  ];

  // Scenes change through a slow blur, so the cut reads as one motion.
  // Each scene draws its frame before its first wait, so the fade in starts on the new frame.
  const hidden = instant ? { opacity: 0 } : { opacity: 0, filter: "blur(4px)" };
  const shown = instant ? { opacity: 1 } : { opacity: 1, filter: "blur(0)" };

  async function playScene(index, session, cut) {
    if (cut) await screensEl.animate([shown, hidden], { duration: 400, easing: "ease" }).finished;
    titleEl.textContent = SCENES[index].title;
    const playing = SCENES[index].play(session);
    if (cut) screensEl.animate([hidden, shown], { duration: 640, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    return playing;
  }

  async function playForever() {
    for (let loop = 0; ; loop++) {
      let session;
      for (let i = 0; i < SCENES.length; i++) {
        const result = await playScene(i, session, loop > 0 || i > 0);
        if (i === 0) session = result;
        await wait(i === SCENES.length - 1 ? HOLD_MS * 2 : HOLD_MS);
      }
    }
  }

  // Draw the first frame now, so the window is never empty before it plays.
  titleEl.textContent = SCENES[0].title;
  claudeFrame();

  let visible = false;
  let started = false;
  const update = () => {
    paused = !visible || document.hidden;
    if (!paused && !started) {
      started = true;
      playForever();
    }
  };
  new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      update();
    },
    { threshold: 0.3 },
  ).observe(root);
  document.addEventListener("visibilitychange", update);
}
