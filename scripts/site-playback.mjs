// Serialized into the viewer by build-site.mjs. Keep browser dependencies local.
export function previewConnection(session) {
  const events = new EventTarget();
  const emit = (type, data) => events.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  let cursor = 0;
  let timer;
  let due = 0;
  let remaining;
  let ready = false;
  let active = parent === window;
  let replyCount = 0;
  const replies = [];
  const next = () => session.timeline[cursor] || replies[0];
  const status = () => emit("status", { state: next() ? "running" : "completed", title: session.title });
  const scroller = () => document.getElementById("scroll");
  const rowFor = (id) => document.querySelector('.tool[data-id="' + CSS.escape(id) + '"]');

  function expand(row) {
    if (!row?.classList.contains("has-detail")) return;
    const group = row.closest(".group");
    if (!group.classList.contains("open")) group.querySelector(".gtrig").click();
    if (!row.classList.contains("open")) row.querySelector(".trig").click();
    const diff = row.querySelector(".diff");
    const added = diff?.querySelector(".add");
    if (added) diff.scrollTop += added.getBoundingClientRect().top - diff.getBoundingClientRect().top - 20;
  }

  function append(step) {
    const scroll = scroller();
    const following = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 80;
    emit("log", step.entries);
    if (following) {
      const item = step.entries.findLast((item) => item.kind === "tool");
      if (item) {
        const row = rowFor(item.id);
        for (const open of document.querySelectorAll(".tool.open")) {
          if (open !== row) open.querySelector(".trig").click();
        }
        expand(row);
      }
      scroll.scrollTop = scroll.scrollHeight;
    }
  }

  function stop() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      remaining = Math.max(0, due - Date.now());
    }
  }

  function schedule() {
    document.body.dataset.previewActive = String(active && !document.hidden);
    if (!ready || !active || document.hidden || timer !== undefined || !next()) return;
    const delay = remaining ?? next().after;
    due = Date.now() + delay;
    timer = setTimeout(() => {
      timer = undefined;
      remaining = undefined;
      const step = session.timeline[cursor] ? session.timeline[cursor++] : replies.shift();
      append(step);
      status();
      schedule();
    }, delay);
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== parent) return;
    if (event.data?.type === "handoff-preview-active") {
      active = event.data.active === true;
      if (!active) stop();
      schedule();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    schedule();
  });

  setTimeout(() => {
    ready = true;
    events.onopen?.();
    append(session.timeline[cursor++]);
    status();
    schedule();
    parent.postMessage({ type: "handoff-preview-ready" }, location.origin);
  }, 0);

  return {
    events,
    async sendMessage(text) {
      if (text.length > 16_000) throw new Error("The message is too long.");
      const reply = session.followUps.find((reply) => new RegExp(reply.match, "i").test(text)) || session.fallback;
      const prefix = "reply-" + ++replyCount + "-";
      for (const step of reply.steps) {
        replies.push({
          ...step,
          entries: step.entries.map((item) => item.kind === "tool" ? { ...item, id: prefix + item.id } : item),
        });
      }
      // The composer adds its pending message before calling this connection.
      queueMicrotask(() => {
        emit("log", [`2026-06-01T10:00:00Z [run] message: ${text}`]);
        status();
        schedule();
      });
    },
  };
}
