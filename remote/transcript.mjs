// Turns one line of an agent's JSON event stream into transcript items.
// The watch page renders the items; `agent-handoff logs` prints them as text.
//   { kind: "text", text }
//   { kind: "tool", id, icon?, title?, meta?, detail?, state, output? }
//   { kind: "note", text, tone }
// A tool item is sent again by id when the call finishes, with its state and output.
// Runs in the sandbox with no dependencies.

const OUTPUT_CHARS = 6000; // the end of long output, where errors usually are
const DIFF_LINES = 120;

export function parseLine(agent, line, workdir = "") {
  if (!line.startsWith("{")) return undefined;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  const relative = (path = "") => (workdir && path.startsWith(`${workdir}/`) ? path.slice(workdir.length + 1) : path);
  if (agent === "claude") return claude(event, relative);
  if (agent === "codex") return codex(event, relative);
  if (agent === "pi") return pi(event, relative);
  return [];
}

function claude(event, relative) {
  // Subagent internals stay inside the Task call that started them.
  if (event.parent_tool_use_id) return [];
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  if (event.type === "assistant") {
    return blocks.flatMap((block) => {
      if (block.type === "text" && block.text.trim()) return [{ kind: "text", text: block.text.trim() }];
      if (block.type === "tool_use") return [{ kind: "tool", id: block.id, state: "running", ...describe(block.name, block.input, relative) }];
      return [];
    });
  }
  if (event.type === "user") {
    return blocks
      .filter((block) => block.type === "tool_result")
      .map((block) => ({ kind: "tool", id: block.tool_use_id, state: block.is_error ? "error" : "ok", output: tail(textOf(block.content)) }));
  }
  if (event.type === "result" && event.is_error) {
    return [{ kind: "note", tone: "bad", text: String(event.result || event.error || "The agent stopped with an error.") }];
  }
  return [];
}

function codex(event, relative) {
  if (event.type === "turn.failed") return [{ kind: "note", tone: "bad", text: event.error?.message ?? "The turn failed." }];
  // Codex reports a dropped stream it is retrying as an error; the turn goes on.
  if (event.type === "error") return /^Reconnecting/.test(event.message) ? [] : [{ kind: "note", tone: "bad", text: event.message }];
  const item = event.item;
  if (!item || !event.type?.startsWith("item.")) return [];
  const done = event.type === "item.completed";
  const state = !done ? "running" : item.status === "failed" ? "error" : "ok";
  switch (item.type) {
    case "agent_message":
      return item.text?.trim() ? [{ kind: "text", text: item.text.trim() }] : [];
    case "command_execution": {
      const finished = done ? { state: item.exit_code === 0 ? "ok" : "error", output: tail(item.aggregated_output ?? "") } : { state };
      return [{ kind: "tool", id: item.id, ...describe("bash", { command: unwrapShell(item.command) }, relative), ...finished }];
    }
    case "file_change": {
      const paths = (item.changes ?? []).map((change) => relative(change.path));
      return [{ kind: "tool", id: item.id, icon: "edit", title: paths.join(", "), detail: paths.length > 1 ? { list: paths } : undefined, state }];
    }
    case "mcp_tool_call":
      return [{ kind: "tool", id: item.id, icon: "tool", title: `${item.server} ${item.tool}`, state, ...(done ? { output: tail(item.error?.message ?? textOf(item.result?.content)) } : {}) }];
    case "web_search":
      return [{ kind: "tool", id: item.id, icon: "web", title: item.query, state }];
    case "todo_list":
      return [{ kind: "tool", id: item.id, ...plan((item.items ?? []).map((todo) => ({ text: todo.text, done: todo.completed }))), state: "ok" }];
    case "error":
      return [{ kind: "note", tone: "bad", text: item.message }];
    default:
      return [];
  }
}

function pi(event, relative) {
  if (event.type === "tool_execution_start") {
    return [{ kind: "tool", id: event.toolCallId, state: "running", ...describe(event.toolName, event.args, relative) }];
  }
  if (event.type === "tool_execution_end") {
    return [{ kind: "tool", id: event.toolCallId, state: event.isError ? "error" : "ok", output: tail(textOf(event.result?.content)) }];
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const message = event.message;
    const items = (Array.isArray(message.content) ? message.content : [])
      .filter((part) => part.type === "text" && part.text.trim())
      .map((part) => ({ kind: "text", text: part.text.trim() }));
    if (message.stopReason === "error") items.push({ kind: "note", tone: "bad", text: message.errorMessage ?? "The model returned an error." });
    return items;
  }
  return [];
}

// What a tool call shows in one line: an icon for its kind and the thing it acts on.
function describe(name = "", input = {}, relative) {
  const tool = name.toLowerCase();
  const path = relative(input.file_path ?? input.path ?? input.notebook_path ?? "");
  if (tool === "bash") return { icon: "run", title: String(input.command ?? "").split("\n")[0] };
  if (tool === "read") return { icon: "read", title: path };
  if (["edit", "multiedit", "str_replace", "notebookedit"].includes(tool)) {
    const edits = input.edits ?? [{ oldText: input.old_string ?? input.oldText ?? "", newText: input.new_string ?? input.newText ?? input.new_source ?? "" }];
    return { icon: "edit", title: path, ...diff(edits.map((edit) => [edit.old_string ?? edit.oldText ?? "", edit.new_string ?? edit.newText ?? ""])) };
  }
  if (tool === "write") return { icon: "edit", title: path, ...diff([["", String(input.content ?? "")]]) };
  if (["grep", "glob", "find", "ls"].includes(tool)) return { icon: "search", title: input.pattern ?? path };
  if (["webfetch", "websearch", "web_search"].includes(tool)) return { icon: "web", title: input.url ?? input.query ?? "" };
  if (["task", "agent"].includes(tool)) return { icon: "agent", title: input.description ?? input.prompt?.split("\n")[0] ?? "" };
  if (tool === "todowrite") return plan((input.todos ?? []).map((todo) => ({ text: todo.content, done: todo.status === "completed" })));
  return { icon: "tool", title: name.replace(/^mcp__/, "").replaceAll("__", " ") };
}

// A plan shows the step in progress; the full list opens below it.
function plan(steps) {
  const current = steps.find((step) => !step.done) ?? steps.at(-1);
  return { icon: "plan", title: current?.text ?? "", meta: `${steps.filter((step) => step.done).length}/${steps.length}`, detail: { checklist: steps } };
}

// Each edit as removed and added lines, without the lines both sides share.
function diff(edits) {
  const lines = [];
  let added = 0;
  let removed = 0;
  for (const [before, after] of edits) {
    const old = before ? before.split("\n") : [];
    const next = after ? after.split("\n") : [];
    let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    let end = 0;
    while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++;
    const gone = old.slice(start, old.length - end);
    const come = next.slice(start, next.length - end);
    removed += gone.length;
    added += come.length;
    lines.push(...gone.map((text) => `-${text}`), ...come.map((text) => `+${text}`));
  }
  const meta = [added && `+${added}`, removed && `-${removed}`].filter(Boolean).join(" ");
  return { meta: meta || undefined, detail: lines.length ? { diff: lines.slice(0, DIFF_LINES) } : undefined };
}

// Codex runs each command through a login shell; the page shows the command itself.
function unwrapShell(command = "") {
  const match = /^\S*\/(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/.exec(command);
  if (!match) return command;
  return match[1] === "'" ? match[2].replaceAll(`'\\''`, "'") : match[2].replace(/\\(["\\$`])/g, "$1");
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function tail(text = "") {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed.length > OUTPUT_CHARS ? `…${trimmed.slice(-OUTPUT_CHARS)}` : trimmed;
}
