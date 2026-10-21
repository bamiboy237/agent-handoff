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

## Phase 2: agent-agnostic handoff

### Goal

- Hand off from any MCP-capable agent to a remote agent of the user's choice.
- Run on a sandbox provider the user picks at setup, or on the user's own SSH host.
- Work from any editor or terminal. No editor is the target.
- Build and test on free tiers only.

### Design decisions

- **The model writes a handoff brief.** The brief holds the task, what is done, decisions, files touched, the next step, and how to verify. It works for every agent and is the default continuation context.
- **The handoff ID is the handle.** MCP has no standard caller session ID, and the 2026-07-28 MCP revision drops protocol sessions. Tools return a handoff ID and accept it on later calls.
- **Snapshot timing depends on what the agent exposes.** When an adapter can identify the calling session, the helper waits for the turn to end, as today. Otherwise `handoff_start` takes the snapshot immediately and tells the model to stop editing.
- **Native session transfer is an upgrade, not a requirement.** Each local agent adapter may export its session. The remote adapter resumes it when it can, and falls back to the brief.
- **The remote agent is a separate choice.** `handoff_start` accepts `targetAgent`. The default is the calling agent when a remote adapter exists for it.
- **One MCP server, two transports.** Keep stdio, and add streamable HTTP for agents that connect by URL.
- **Providers declare capabilities.** Each sandbox adapter reports SSH support, snapshot support, its keep-alive strategy, and its maximum lifetime. The tools return only the features the provider supports.

### Agent reference

| Agent | Headless run on the sandbox | Model credentials | Native session resume | MCP config |
| --- | --- | --- | --- | --- |
| OpenCode 2 | `opencode run --session <id> --auto "<prompt>" < /dev/null` | Credential store, registered through `integration.connect.key` | `session export` and `session import --directory` (verified) | `opencode.jsonc`, `mcp.servers` |
| Claude Code | `claude -p --dangerously-skip-permissions "<prompt>" < /dev/null` | `ANTHROPIC_API_KEY` | `claude -p --resume <file.jsonl> "<prompt>"` | `.mcp.json`, `mcpServers` |
| Codex | `codex exec --dangerously-bypass-approvals-and-sandbox "<prompt>" < /dev/null` | `CODEX_API_KEY`, or `~/.codex/auth.json` | `codex exec resume <id>`. Session file location unverified | `~/.codex/config.toml`, `[mcp_servers.<name>]` |
| Pi | `pi -p "<prompt>" < /dev/null` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | `pi --session <file>` | `~/.pi/agent/mcp.json`, `mcpServers` |
| Prime Agent | No documented headless mode | In-app `/login` | `prime-agent --resume <path or id>` | In-app `/mcp` |

Prime Agent can call the handoff tools as a local agent. It cannot run as a remote agent until a headless mode exists.

### Provider reference

| Provider | Access from TypeScript | Background process | Keep-alive | SSH for an editor | Free tier for testing |
| --- | --- | --- | --- | --- | --- |
| Daytona | `@daytonaio/sdk` (done) | Session command with `runAsync` | Heartbeat through a preview URL | Yes, SSH tokens | Existing account |
| Plain SSH host | System `ssh` binary | `setsid nohup ... &` with a PID file | Not needed | Yes | The user's own machine |
| E2B | `e2b` npm SDK | `commands.run(cmd, { background: true, timeoutMs: 0 })`, reconnect by PID | `setTimeout` | Custom template with `openssh-server` and websocat | One-time $100 credit, 1-hour sessions |
| Vercel Sandbox | `@vercel/sandbox` | `runCommand({ detached: true })` | `extendTimeout` | Interactive shell through `sandbox ssh` only | Hobby, 45-minute sessions |
| Prime Intellect | `prime` CLI (SDK is Python only) | `start_background_job` | `timeout_minutes=-1` | `prime sandbox ssh` (interactive only) | No free tier found |

### Implementation plan

- [x] **Generalize the contract**
  - Add the handoff brief, `targetAgent`, and provider capabilities to the handoff record.
  - Keep the existing states.

- [x] **Split agent adapters into local and remote halves**
  - Local adapter: identify the calling session from `_meta` when possible, and optionally export the session.
  - Add a generic local adapter for agents that expose no session. It uses the brief and snapshots at call time.
  - Remote adapter: install command, headless run command, credential variables, and optional session resume.
  - Move the agent-specific parts of `remote/runner.sh` into one function per remote agent.

- [x] **Add remote agents**
  - Claude Code, Codex, and Pi, using the commands in the agent reference.
  - Close stdin on every headless run.
  - Pass each agent's credential variables only to its own sandbox.

- [x] **Make the tools brief-based**
  - `handoff_prepare` and `handoff_start` accept the brief as structured fields.
  - Update the skill so the model writes a complete brief.
  - Build the remote prompt from the brief for every agent.

- [x] **Add the streamable HTTP transport**
  - Start it with a flag, such as `agent-handoff --http 7878`.
  - Bind to localhost only.

- [x] **Add sandbox providers, in this order**
  - Plain SSH host: needs no account and is the simplest to test.
  - E2B: the most complete API, with free credits.
  - Vercel Sandbox: Hobby tier, with keep-alive through `extendTimeout`.
  - Prime Intellect: shells out to the `prime` CLI.

- [x] **Add a setup command**
  - `agent-handoff setup` lists the providers, checks credentials, and writes the provider choice to a config file.
  - Detect installed agents and offer to add the MCP server to each agent's config.

- [x] **Update the docs**
  - README sections for each agent and each provider.

### Verify while building

- Codex session file location, and whether `codex exec resume` works on another machine.
- Whether Claude Code and Pi sessions resume after moving to a different working directory.
- Whether any agent besides OpenCode sends a session ID in `_meta`.
- Vercel: the upload method, and whether detached commands survive client disconnect.
- E2B: the option name for environment variables at creation.
- Prime Intellect: the REST base URL, and whether the `prime` CLI reports state in JSON.

## Deferred

- Email notifications. The first planned email is a "sandbox ready" notice with the SSH details.
- Prime Agent as a remote agent, until it documents a headless mode.
- Modal, Runloop, and Cloudflare Sandbox providers.
- Returning work from the sandbox to the local machine, beyond the draft pull request.

## Implementation instruction

- Do not add or run tests.
