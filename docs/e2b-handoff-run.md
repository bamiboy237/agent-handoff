# E2B handoff run

Handoff `hmvkimy8h656b` continues “Fix E2B runtime and Codex credentials” in E2B. Codex receives the handoff brief and repository snapshot; this is a brief-based continuation, not an imported local Codex session. The existing OpenAI API key is used. OpenCode's default model key had expired, so this continuation uses Codex without further model trials.

## Observed runtime

Recorded in the continuation sandbox, with the runner's tool directories on PATH:

| Command | Output |
| --- | --- |
| `node --version` | `v22.23.4` |
| `codex --version` | `codex-cli 0.163.0` |
| `git branch --show-current` | `handoff/hmvkimy8h656b-result` |

The versions above were obtained from `$HOME/.npm-global/bin/node` and `$HOME/.npm-global/bin/codex`. The initial shell PATH instead reported Node `v20.9.0` and `codex: command not found`; the runner adds the user tool directories to PATH.

## Preparation and transfer

Configure E2B, a GitHub token with repository read, branch push, and pull-request write access, and Codex credentials. Save editor buffers before transferring. `handoff_prepare` checks the repository and credentials and starts a detached helper to warm the sandbox and install the agent. E2B can restore a reusable cache; its adapter provides no SSH access, defaults to a 60-minute lifetime, and pauses the sandbox at the time limit.

`handoff_start` signals the helper. The workspace transfer captures committed, staged, unstaged, and nonignored new files in a snapshot commit using a temporary Git index, preserving the local working tree, index, and branch. The snapshot is pushed as `handoff/hmvkimy8h656b`. The runner clones it (or fetches into a cached checkout), then creates `handoff/hmvkimy8h656b-result`. This snapshot already includes the runtime and credential fixes described below.

## Runtime fixes and dependency setup

In `remote/runner.sh`, `ensure_node` accepts Node 22.19 or newer (including later major versions), otherwise installs `node@22`. Global npm tools use the explicit user-owned prefix `$HOME/.npm-global`, whose `bin` directory is on the runner's PATH. This avoids the old image Node and inconsistent npm installation locations. Codex is installed as `@openai/codex`, pinned to the detected local agent version when available.

The setup phase runs the generated `setup.sh` in the checkout. Dependency commands are selected from root lockfiles, such as `npm ci` for `package-lock.json`; project `.handoff.json` setup commands follow the detected installs. A supported provider can then save a cache of the prepared sandbox.

In `src/agents/remote.ts`, Codex credential selection prefers `CODEX_API_KEY`, falls back to `OPENAI_API_KEY`, and exports the selected value as `CODEX_API_KEY` for `codex exec`. Passing only `OPENAI_API_KEY` was insufficient for that execution path. Credentials travel through the sandbox environment, separately from the snapshot and brief; no credential values are recorded here.

## Background execution and watching

The E2B adapter launches the runner with `background: true` and `timeoutMs: 0`, removing the SDK's default per-command timeout that would otherwise kill background work. The sandbox lifetime still applies. The runner invokes `codex exec --json` with sandbox approvals bypassed, the brief as its prompt, and stdin closed with `/dev/null`. Output goes to the runner log. Queued messages are processed between turns using `codex exec resume --last`.

The watch server runs separately under Node and exposes live agent output and a message box through E2B's public port host. Access is authenticated by a secret key carried in the watch link; possession of that link grants watch and messaging access. The link lasts while the sandbox exists. Neither the watch URL nor its key is included in this guide.

## Publishing the result

This documentation change is committed on the current result branch. When Codex exits, the runner commits any remaining changes, pushes `handoff/hmvkimy8h656b-result`, and creates a draft GitHub pull request against the original base branch. It also attempts publication after an agent failure so partial work is preserved. The runner handles the push and draft PR; this continuation does not merge or push main.

Verification for this documentation-only continuation is review of the guide and `git diff --check`. No tests are added or run, and the existing source fixes remain unchanged.
