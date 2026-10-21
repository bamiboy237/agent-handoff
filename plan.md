# Agent Handoff plan

## Goal

- Move an active coding-agent session and unfinished work from a local machine to a managed cloud sandbox.
- Expose MCP (Model Context Protocol) tools and skills so the model infers handoff intent from normal language.
- Require no special phrase or manual terminal workflow.
- Continue the task remotely after the laptop disconnects.
- Use OpenCode for the agent session, Daytona for the managed sandbox, and Zed for workspace access.

## Scope

- Version 1 supports OpenCode, Daytona, and Zed only.
- Agent and sandbox access go through adapter interfaces.
- Codex, Claude Code, and SSH hosts can be added later as new adapters.

## Handoff flow

1. The model calls `handoff_prepare` when it infers handoff intent.
2. `handoff_prepare` checks authentication and repository state, and starts warming a sandbox.
3. The model calls `handoff_start`. The tool returns a handoff ID immediately.
4. The local agent ends its turn.
5. A detached local helper waits for the session to become idle, then exports it.
6. The helper pushes a snapshot branch and uploads the session to the sandbox.
7. The remote OpenCode session continues the task.
8. When the task is complete, the remote agent pushes a result branch and opens a draft pull request.
9. The sandbox stops after an idle timeout.

## Implementation plan

- [x] **Define the handoff contract**
  - Record the handoff ID, session, project directory, task, base branch, snapshot branch, and sandbox ID.
  - Define clear progress states and tool results.
  - Include a failed state that names the failing step.

- [x] **Build the MCP server**
  - Implement the server in TypeScript.
  - Expose `handoff_prepare`, `handoff_start`, `handoff_status`, and `handoff_stop`.
  - Connect the tools to OpenCode and Daytona through adapter interfaces.

- [x] **Write the skill**
  - Explain when handoff fits the user's intent and how to use the tools.
  - Let the model infer intent without a required phrase or manual command.
  - Tell the model to call `handoff_prepare` first, then `handoff_start`, then end its turn.

- [x] **Connect the active session**
  - Use an OpenCode adapter to identify the calling session.
  - Return from `handoff_start` immediately so the agent can end its turn.
  - Start a detached local helper that outlives the tool call.
  - In the helper, wait until the session is idle, then export the complete session.

- [x] **Transfer the workspace**
  - Preserve local commits, staged changes, unstaged changes, and new files.
  - Build one snapshot commit with a temporary Git index.
  - Leave the working tree, the real index, and the current branch unchanged.
  - Push the snapshot commit to the Git remote as `handoff/<id>`.
  - Do not transfer gitignored files.

- [x] **Pass credentials as environment variables**
  - Read model provider API keys locally.
  - Parse local `.env` files.
  - Read `GITHUB_TOKEN` from the user's environment or `.env` file.
  - Pass all values to Daytona as sandbox environment variables.
  - Never write credentials into the workspace, the snapshot commit, or the exported session.
  - Warn in `handoff_prepare` when `GITHUB_TOKEN` is missing.

- [x] **Recreate the development setup**
  - Start the sandbox from a cached Daytona snapshot for the project when one exists.
  - Start the sandbox during `handoff_prepare` to reduce handoff latency.
  - Clone the `handoff/<id>` branch in the sandbox.
  - Detect and install dependencies from lockfiles, such as `package-lock.json`, `pnpm-lock.yaml`, `uv.lock`, `Cargo.lock`, and `go.sum`.
  - Run extra setup commands from an optional `.handoff.json` file.
  - Rebuild the cached snapshot when a lockfile changes.

- [x] **Continue remotely**
  - Import the OpenCode session and map project paths.
  - Run the OpenCode background service (`opencode serve --service`) so the session survives local disconnection.
  - Auto-approve all agent permission requests inside the sandbox.
  - Let the user attach to the remote session to watch or steer it.
  - After the import, treat the local session as read-only. Only the remote session changes code.

- [x] **Return the result**
  - When the task is complete, push the result branch `handoff/<id>-result`.
  - Open a draft pull request against the original branch.
  - Stop the sandbox after an idle timeout and keep its disk.

- [x] **Expose progress and reconnection**
  - Persist the handoff and sandbox IDs.
  - Return status, logs, and connection details.
  - Return the SSH details and a ready `zed ssh://...` command so the user can open the remote workspace in Zed.
  - Let the agent stop remote execution through MCP.

- [x] **Document the workflow**
  - Update the README and setup instructions to match the implementation.
  - Cover MCP, skills, authentication, `GITHUB_TOKEN`, `.handoff.json`, and Zed integration.

## Deferred

- Email notifications. The first planned email is a "sandbox ready" notice with the SSH and Zed details.
- Codex and Claude Code adapters.
- SSH hosts as a bring-your-own-cloud target.
- Other editors.

## Implementation instruction

- Do not add or run tests.
