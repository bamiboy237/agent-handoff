# Agent Handoff

Move an active coding-agent session and its unfinished work from your machine to a cloud sandbox. The task keeps running after your laptop disconnects.

Tell your agent something like "I need to leave, keep going in the cloud." The agent infers the intent, warms a sandbox, and hands off. You do not need a special phrase or a terminal command.

Version 1 supports OpenCode, Daytona sandboxes, and Zed for remote access. Codex, Claude Code, and your own SSH hosts are planned as new adapters.

## Requirements

- OpenCode 2 on your machine, signed in to a model provider with an API key.
- A Daytona account and API key.
- A Git repository with an `origin` remote. GitHub is required for the draft pull request.
- A GitHub token that can read the repository, push branches, and create pull requests. For a fine-grained token:
  - Set **Repository access** to "All repositories" or select the repository. "Public repositories" is read-only and cannot push.
  - Set **Contents** and **Pull requests** to read and write. **Metadata** read-only is added automatically.
  - Add **Workflows** read and write only if the agent may edit files in `.github/workflows/`.
- Node.js 22 or later.
- Zed, if you want to open the remote workspace in an editor.

## Set up

1. Build the server:

   ```bash
   npm install
   ```

   ```bash
   npm run build
   ```

2. Add the MCP server to OpenCode. Replace the path and the key values:

   ```bash
   opencode mcp add agent-handoff --env DAYTONA_API_KEY=your-daytona-key --env GITHUB_TOKEN=your-github-token -- node /path/to/agent-handoff/dist/index.js
   ```

   The server reads `DAYTONA_API_KEY` and `GITHUB_TOKEN` from its environment. You can also put `GITHUB_TOKEN` in the project's `.env` file.

   The server reads its environment once, when OpenCode starts it. After you change a key, reload OpenCode so the server restarts. `handoff_prepare` refuses to start when GitHub rejects the token.

3. Install the skill so the model knows when and how to hand off:

   ```bash
   cp -R skills/handoff ~/.config/opencode/skills/
   ```

4. Reload OpenCode:

   ```bash
   opencode reload
   ```

## Use it

1. Work with OpenCode as usual.
2. Tell the agent you want the work to continue remotely.
3. The agent calls `handoff_prepare`, reports any warnings, and then calls `handoff_start`.
4. The agent ends its turn. The transfer starts after that.
5. Ask the agent for the handoff status to get progress, the SSH command, and the Zed command.
6. When the remote agent finishes, review the draft pull request on GitHub.

To open the remote workspace, run the Zed command from `handoff_status`. It looks like this:

```bash
zed ssh://token@ssh.app.daytona.io/home/daytona/workspace/your-repo
```

To watch or steer the remote agent, connect over SSH and run `opencode` in the remote workspace. The session is already imported there.

## Tools

| Tool | Purpose |
| --- | --- |
| `handoff_prepare` | Checks the repository and credentials, returns warnings, and warms a sandbox in the background. Takes `task`. |
| `handoff_start` | Starts the transfer after the current turn ends. Takes `handoffId`, or `task` to prepare and start in one call. Repeated calls never launch a second remote agent. |
| `handoff_status` | Returns the state, recent events, the remote log, the draft pull request, and the SSH and Zed details. |
| `handoff_stop` | Stops the helper and the sandbox. The sandbox keeps its disk. |

### Handoff states

| State | Meaning |
| --- | --- |
| `warming` | Creating the sandbox and installing OpenCode. |
| `warm` | The sandbox is ready and waits for `handoff_start`. |
| `waiting_for_idle` | Waiting for the local turn to end. |
| `transferring` | Pushing the snapshot branch and exporting the session. |
| `setting_up` | Cloning the project and installing dependencies in the sandbox. |
| `running` | The remote agent is working. |
| `completed` | The remote agent finished and the result branch is pushed. |
| `failed` | A step failed. `handoff_status` names the step. |
| `stopped` | Stopped with `handoff_stop`. |
| `abandoned` | `handoff_start` never came within 20 minutes. The warm sandbox was deleted. |

## Configure the sandbox setup

The server detects dependencies from these lockfiles at the repository root:

| Lockfile | Install command |
| --- | --- |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| `yarn.lock` | `yarn install --frozen-lockfile` |
| `bun.lock`, `bun.lockb` | `bun install --frozen-lockfile` |
| `package-lock.json` | `npm ci` |
| `uv.lock` | `uv sync --frozen` |
| `poetry.lock` | `poetry install` |
| `requirements.txt` | `pip install -r requirements.txt` |
| `Cargo.lock` | `cargo fetch --locked` |
| `go.sum` | `go mod download` |
| `Gemfile.lock` | `bundle install` |

To add system packages, services, or build steps, create `.handoff.json` at the repository root. The commands run in order after the detected installs:

```json
{
  "setup": [
    "sudo apt-get update && sudo apt-get install -y postgresql-client",
    "npm run build"
  ]
}
```

## Credentials

The sandbox receives these values as environment variables. They never go into the snapshot branch, the exported session, or the handoff record.

- Model provider API keys from OpenCode's credential store. The remote runner registers them with the remote OpenCode.
- Every value in the project's `.env` and `.env.local` files.
- `GITHUB_TOKEN`, from the server's environment or `.env`.

OpenCode integrations that use OAuth sign-in are not transferred. `handoff_prepare` warns about each one.

Untracked files that are not gitignored go into the snapshot branch. `handoff_prepare` warns when such a file looks like a secret, for example `.env.production`.

## How it works

1. `handoff_prepare` records the handoff and starts a detached helper process.
2. The helper creates a Daytona sandbox. When a cached snapshot exists for the same lockfiles, OpenCode version, and repository, the sandbox starts from it.
3. `handoff_start` signals the helper and returns. The agent ends its turn.
4. The helper waits for the local session to become idle, so the exported session includes the finished turn.
5. The helper builds one commit from committed, staged, unstaged, and new files. It uses a temporary Git index, so your working tree, index, and branch stay unchanged. It pushes the commit as `handoff/<id>`.
6. The helper exports the OpenCode session. In the sandbox it clones the branch, creates `handoff/<id>-result`, and runs the setup.
7. After the first successful setup, the helper saves a cached Daytona snapshot for later handoffs.
8. The remote runner starts OpenCode, imports the session into the remote directory, and continues the task with every permission auto-approved.
9. When the agent finishes, the runner commits leftover changes, pushes the result branch, and opens a draft pull request against your original branch.
10. The sandbox stops after 30 minutes without activity and keeps its disk.

Handoff records and helper logs live in `~/.local/state/agent-handoff/`.

## Limits

- The local session is read-only by convention only. The handoff renames it with a `[cloud <id>]` prefix but cannot block edits.
- Unsaved editor buffers are not transferred. Save files before you hand off.
- The remote runner installs OpenCode with the OpenCode 1 installer and then upgrades to your local version. This path depends on OpenCode's upgrade command.
- The runner pushes and opens the pull request once, when the first remote turn ends. If you continue the session remotely, push again yourself.
- Daytona stops idle sandboxes even while processes run. The runner sends a preview request every 4 minutes during the remote turn to stay alive.
