// Synthetic agent events shared by the viewer test and local preview.
export const message = (text) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
export const call = (id, name, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
export const result = (id, content) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
export const user = (text) => `2026-06-01T10:00:00Z [run] message: ${text}`;
const answer = [
  "The viewer now keeps your place when new output arrives. It only follows the agent when you're already at the bottom.",
  "## Keep the conversation in view",
  "The transcript and composer have separate space, so longer messages don't cover the agent's response.",
  "- **Read at your own pace.** Scroll back without being pulled to the latest output.\n- **Pick up where you left off.** Tap the down arrow to follow the agent again.",
  "```js\nconst follow = () => {\n  if (pinned) scrollToLatest();\n};\n```",
  "The same behavior applies to **Claude Code**, **Codex**, and **Pi**. OpenCode still opens its own app.",
].join("\n\n");
export const fixture = [
  user("Keep the mobile viewer easy to follow while the agent is working."),
  message("I'll separate the transcript from the composer and keep the controls out of the way."),
  call("read-1", "Read", { file_path: "/workspace/remote/watch.mjs" }),
  result("read-1", "The transcript scrolls inside the session panel."),
  call("edit-1", "Edit", { file_path: "/workspace/remote/watch.mjs", old_string: "scrollToLatest();", new_string: "if (pinned) scrollToLatest();" }),
  result("edit-1", "Updated remote/watch.mjs"),
  call("run-1", "Bash", { command: "npm run typecheck" }),
  result("run-1", "> agent-handoff@0.2.0 typecheck\n> tsc -p tsconfig.json --noEmit\n\nNo type errors."),
  message(answer),
];
