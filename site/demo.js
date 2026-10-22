// The hero demo: one continuous story, started with the play button.
//   1 Claude Code on your machine hands the task to OpenCode in the cloud
//   2 OpenCode, running GPT-6.1 Sol, picks it up in the sandbox and finishes it
//   3 Back in the same Claude Code session, the draft pull request is waiting
// Pressing play also allows sound, which browsers block until a click. The
// story pauses while off screen. With reduced motion each scene appears
// finished, without typing, and scenes swap with a plain fade.

const PROMPT = "I have to go. Let OpenCode finish this in the cloud.";
const FOLLOW_UP = "How did the handoff go?";
const TASK = "Retry failed Stripe webhooks with backoff";
const PR_URL = "https://github.com/you/billing-api/pull/48";
const CLAUDE_SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const HOLD_MS = 2400; // how long a finished scene stays before the next one
const SLOWDOWN = 3.2; // stretches every pause, keystroke, and hold toward real-life pace
const LINE_TRAVEL_MS = 2400; // matches the diagram line's transition in styles.css

const root = document.querySelector(".demo");
if (root) {
  const screensEl = root.querySelector("[data-screens]");
  const screen = root.querySelector("[data-screen]");
  const titleEl = root.querySelector("[data-title]");
  const playButton = root.querySelector("[data-play]");
  const instant = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // While paused (off screen or tab hidden), waits freeze instead of ending,
  // so the story resumes where it was rather than restarting.
  const TICK_MS = 50;
  let paused = false;
  let playing = false;
  let spinnerTimer;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Sound, synthesized so the page ships no audio files. Everything is quiet
  // by design: it should sit under the visitor's attention, not on top of it.
  const sound = {
    context: undefined,
    start() {
      this.context ??= new AudioContext();
      void this.context.resume();
    },
    get ready() {
      return !paused && this.context?.state === "running";
    },
    // A filtered noise burst, close to a laptop key.
    key(low = false) {
      if (!this.ready) return;
      const ctx = this.context;
      const length = Math.floor(ctx.sampleRate * 0.03);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = (low ? 1200 : 2600) + Math.random() * 900;
      filter.Q.value = 1.4;
      const gain = ctx.createGain();
      gain.gain.value = low ? 0.22 : 0.14;
      source.connect(filter).connect(gain).connect(ctx.destination);
      source.start();
    },
    tone(frequency, at, duration, volume, type = "sine") {
      const ctx = this.context;
      const start = ctx.currentTime + at;
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = frequency;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    },
    // A short tick when a tool finishes.
    tick() {
      if (this.ready) this.tone(1320, 0, 0.07, 0.035);
    },
    // A soft rising sweep while the work travels along the diagram line.
    travel() {
      if (!this.ready) return;
      const ctx = this.context;
      const start = ctx.currentTime;
      const seconds = LINE_TRAVEL_MS / 1000;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(220, start);
      osc.frequency.exponentialRampToValueAtTime(440, start + seconds);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.03, start + seconds * 0.4);
      gain.gain.linearRampToValueAtTime(0, start + seconds);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + seconds + 0.05);
    },
    // Two notes when the pull request lands.
    chime() {
      if (!this.ready) return;
      this.tone(659.25, 0, 0.6, 0.05, "triangle");
      this.tone(987.77, 0.12, 0.9, 0.045, "triangle");
    },
  };

  // The handoff diagram above the window reads this: 0 laptop, 1 moving out,
  // 2 sandbox, 3 moving back, 4 pull request.
  function setStage(stage) {
    root.dataset.stage = String(stage);
    if (stage === 1 || stage === 3) sound.travel();
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
    if (instant) return;
    for (let i = 0; i < text.length; i++) {
      target.textContent = text.slice(0, i + 1);
      const ch = text[i];
      if (ch !== " ") sound.key();
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

  async function submit(ui, text) {
    await pace(500);
    await type(ui.typed, text);
    await pace(350);
    sound.key(true);
    ui.typed.textContent = "";
    return show(ui.transcript, el("p", "line user", `> ${text}`), ui.scroll);
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

  function claudeSays(ui, ...parts) {
    const p = el("p", "line");
    p.append(el("span", "bullet", "●"), ...parts);
    return show(ui.transcript, p, ui.scroll);
  }

  async function claudeTool(ui, name, args, runMs, ...output) {
    const call = el("p", "line running");
    call.append(el("span", "bullet", "●"), el("b", "", name), el("span", "dim", args));
    show(ui.transcript, call, ui.scroll);
    await pace(runMs);
    call.classList.replace("running", "ok");
    sound.tick();
    for (const parts of output) {
      const p = el("p", "line result");
      p.append(...parts);
      show(ui.transcript, p, ui.scroll);
    }
    await pace(420);
  }

  // OpenCode, in its default dark theme, running GPT-6.1 Sol
  function opencodeFrame() {
    const tabs = el("p", "oc-tabs");
    tabs.append(el("b", "", TASK));
    const scroll = el("div", "scroll");
    const transcript = el("div", "transcript");
    scroll.append(transcript);
    const input = el("div", "oc-input");
    const prompt = el("p");
    prompt.append(el("span", "typed"), el("span", "cursor"));
    const mode = el("p", "oc-mode");
    const status = el("span", "oc-status");
    mode.append(el("span", "oc-accent", "Build"), el("span", "oc-muted", " · "), el("b", "", "GPT-6.1 Sol"), el("span", "oc-muted", " OpenAI"), status);
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
      ui.status.replaceChildren(`${"⬝".repeat(at)}■${"⬝".repeat(6 - at)}`, el("span", "oc-hint", "  esc interrupt"));
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
    sound.tick();
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

  const added = (text) => [el("span", "green", `+${text}`)];
  const removed = (text) => [el("span", "red", `-${text}`)];

  const SCENES = [
    {
      title: "~/code/billing-api",
      async play() {
        const ui = claudeFrame();
        setStage(0);
        await submit(ui, PROMPT);
        await claudeSpin(ui, "Handing off", 1300);
        claudeSays(ui, "I'll hand this to OpenCode in a cloud sandbox. Your uncommitted retry work goes with it.");
        await pace(500);
        await claudeTool(
          ui,
          "agent-handoff - handoff_prepare (MCP)",
          `(targetAgent: "opencode", brief: {"title": "${TASK}", …})`,
          1000,
          ["⎿  Sandbox warming on daytona."],
        );
        await claudeTool(ui, "agent-handoff - handoff_start (MCP)", '(handoffId: "h3k9")', 700, [
          "⎿  Handoff h3k9 is starting. opencode continues the work in the sandbox.",
        ]);
        setStage(1);
        claudeSays(ui, "Your changes are on their way. You can close your laptop.");
        return ui;
      },
    },
    {
      title: "/home/daytona/workspace/billing-api",
      async play() {
        const ui = opencodeFrame();
        setStage(2);
        const brief = el(
          "p",
          "line oc-user",
          "Continue the handoff from Claude Code: wrap Stripe webhook processing in retries with exponential backoff, cover it with tests, then commit.",
        );
        show(ui.transcript, brief, ui.scroll);
        await opencodeWork(ui, 1200);
        opencodeTool(ui, "→", "Read", "src/webhooks/stripe.ts");
        await opencodeWork(ui, 900);
        opencodeTool(
          ui,
          "←",
          "Edit",
          "src/webhooks/retry.ts",
          opencodeBlock(
            added("export async function withBackoff<T>(run: () => Promise<T>, attempts = 5) {"),
            added("  for (let attempt = 1; ; attempt++) {"),
            added("    try { return await run(); }"),
            added("    catch (error) { if (attempt === attempts) throw error; }"),
            added("    await sleep(250 * 2 ** attempt);"),
          ),
        );
        await opencodeWork(ui, 900);
        opencodeTool(
          ui,
          "←",
          "Edit",
          "src/webhooks/stripe.ts",
          opencodeBlock(removed("  await processEvent(event);"), added("  await withBackoff(() => processEvent(event));")),
        );
        await opencodeWork(ui, 800);
        opencodeTool(ui, "←", "Write", "test/webhooks/retry.test.ts");
        await opencodeWork(ui, 1300);
        opencodeTool(ui, "$", "npm test", "", opencodeBlock([el("span", "green", "✔"), " 23 passed, 0 failed (4 files)"]));
        await opencodeWork(ui, 700);
        opencodeTool(
          ui,
          "$",
          `git commit -am "${TASK}"`,
          "",
          opencodeBlock([`[handoff/h3k9-result 3f2c1e9] ${TASK}`], [" 3 files changed, 64 insertions(+), 2 deletions(-)"]),
        );
        await opencodeWork(ui, 600);
        show(
          ui.transcript,
          el("p", "line", "Failed webhooks now retry up to 5 times with exponential backoff. Tests pass, and the work is committed."),
          ui.scroll,
        );
        show(ui.transcript, el("p", "line oc-muted", "Build · GPT-6.1 Sol · 6m 12s"), ui.scroll);
        setStage(3);
      },
    },
    {
      title: "~/code/billing-api",
      async play(previous) {
        // The same session as scene one, so its last exchange is still on screen.
        const ui = claudeFrame();
        setStage(4);
        for (const node of previous.transcript.children) ui.transcript.append(node.cloneNode(true));
        ui.scroll.scrollTop = ui.scroll.scrollHeight;
        await submit(ui, FOLLOW_UP);
        await claudeSpin(ui, "Checking", 900);
        await claudeTool(
          ui,
          "agent-handoff - handoff_status (MCP)",
          "",
          800,
          ["⎿  Handoff h3k9 completed."],
          ["   Draft pull request: ", el("u", "", PR_URL)],
        );
        sound.chime();
        claudeSays(ui, "OpenCode finished. Failed Stripe webhooks now retry with backoff, and the tests pass: ", el("u", "", PR_URL));
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

  // One play-through, like a video. It ends on the pull request and offers a replay.
  let played = false;
  async function playStory() {
    const replay = played;
    played = true;
    playing = true;
    root.dataset.state = "playing";
    let session;
    for (let i = 0; i < SCENES.length; i++) {
      const result = await playScene(i, session, replay || i > 0);
      if (i === 0) session = result;
      if (i < SCENES.length - 1) await wait(HOLD_MS);
    }
    playing = false;
    root.dataset.state = "ended";
    playButton.querySelector("[data-play-label]").textContent = "Replay";
  }

  playButton.addEventListener("click", () => {
    if (playing) return;
    sound.start();
    void playStory();
  });

  // The poster frame: the first scene with its prompt ready to send.
  titleEl.textContent = SCENES[0].title;
  claudeFrame().typed.textContent = PROMPT;

  let visible = true;
  const update = () => {
    paused = !visible || document.hidden;
    if (paused) void sound.context?.suspend();
    else if (playing) void sound.context?.resume();
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
