# Agent Handoff plan

## Goal

- Move an active coding-agent session and unfinished work from a local machine to a managed cloud sandbox.
- Expose MCP (Model Context Protocol) tools and skills so the model infers handoff intent from normal language.
- Require no special phrase or manual terminal workflow.
- Continue the task remotely after the laptop disconnects.
- Use OpenCode for the agent session, Daytona for the managed sandbox, and Zed for workspace access.

## Implementation plan

- [ ] **Define the handoff contract**
  - Record the active session, project directory, task, files, and development setup.
  - Define clear progress states and tool results.

- [ ] **Build the MCP server**
  - Implement the server in TypeScript.
  - Expose `handoff_prepare`, `handoff_start`, `handoff_status`, and `handoff_stop`.
  - Connect the tools to OpenCode and Daytona.

- [ ] **Write the skill**
  - Explain when handoff fits the user's intent and how to use the tools.
  - Let the model infer intent without a required phrase or manual command.

- [ ] **Connect the active session**
  - Use an OpenCode adapter to identify the calling session.
  - Export its context after active tool calls finish.

- [ ] **Transfer the workspace**
  - Preserve local commits, staged changes, unstaged changes, and new files.
  - Leave the local workspace unchanged.
  - Keep credentials out of the transfer.

- [ ] **Recreate the development setup**
  - Create the Daytona sandbox and restore the project.
  - Install dependencies from the project's manifests and lockfiles.
  - Apply the project's setup configuration.

- [ ] **Continue remotely**
  - Import the OpenCode session and map project paths.
  - Resume the task in a background process that survives local disconnection.

- [ ] **Expose progress and reconnection**
  - Persist the handoff and sandbox IDs.
  - Return status, logs, and connection details.
  - Let the user open the remote workspace in Zed.
  - Let the agent stop remote execution through MCP.

- [ ] **Document the workflow**
  - Update the README and setup instructions to match the implementation.
  - Cover MCP, skills, authentication, and Zed integration.

## Implementation instruction

- Do not add or run tests.
