---
name: handoff
description: Move the current task and all local changes to a cloud sandbox so it keeps running after the user disconnects, optionally continued by a different agent. Use when the user wants work to continue without their machine, for example "move this to the cloud", "keep going while I'm away", "I need to close my laptop, finish this", "run this remotely", or "let Codex finish this in the cloud". Do not use for deploying an app or running a single remote command.
---

# Cloud handoff

The agent-handoff MCP server moves this task to a cloud sandbox or the
user's own SSH machine. The task continues there after the user's machine
disconnects. The user does not need a special phrase. Infer the intent
from what they say.

## When handoff fits

Hand off when the user wants the current task to keep going without them
or their machine. Typical signals:

- They are leaving, closing the laptop, or going offline.
- They ask for the work to run in the cloud or on a remote machine.
- The remaining work is long and they do not want to wait for it locally.

Ask one short question first when the intent is unclear. Do not hand off
for deploys, one-off remote commands, or questions about cloud services.

## Write the brief

The brief is often the only context the next agent gets. Write it for an
agent that has never seen this conversation.

- `title`: one line naming the work. It becomes the pull request title.
- `task`: the goal and any constraints the user gave.
- `done`: what is already finished, including uncommitted edits.
- `decisions`: choices made and why, so the next agent does not undo them.
- `files`: the files that matter for the next step.
- `nextStep`: the exact next action.
- `verification`: how to check the work, such as the test command.

## Steps

1. Call `handoff_prepare` with the brief as soon as you notice the intent.
   - Pass `targetAgent` only when the user names an agent to continue the
     work, such as `codex` or `claude`.
   - Pass `model` only when the user names a model, in the cloud agent's own
     format. For OpenCode that is provider/model, such as `opencode/big-pickle`.
   - Preparation warms the sandbox in the background. Keep working while it runs.
2. Read the result. Tell the user about each warning, such as a missing key,
   a short sandbox time limit, or files the snapshot branch would include.
3. When the user is ready to move, call `handoff_start` with the `handoffId`.
   - Pass an updated `brief` if the work moved on since step 1.
   - If the user wants to move right away, skip step 1. Call
     `handoff_start` with only the `brief`.
4. End your turn immediately after `handoff_start`.
   - Write one short message saying the task is moving to the cloud.
   - Do not call more tools. Do not edit files. Later edits are not transferred.

## After the handoff

- The remote agent owns the task. Treat this local session as read-only.
- Call `handoff_status` when the user asks about progress. It returns the
  state, the remote log, the draft pull request, and SSH details when the
  provider supports SSH. You cannot check in during the turn that started the
  handoff; check in a later turn.
- Call `handoff_work` when the user asks what the cloud agent has done. Set
  `diff` only when they want to read the changes themselves.
- Call `handoff_message` when the user wants to tell the cloud agent
  something, such as a correction or an extra task. Pass their instructions
  as the message. A finished run resumes to answer it and updates the pull
  request.
- Give the user the SSH command or editor URI from `handoff_status` when
  they want to open the remote workspace.
- Call `handoff_stop` only when the user asks to stop the remote work.
- Tell the user they can also check in from a terminal: `agent-handoff status`,
  `work`, `logs -f`, `send`, `ssh`, and `attach` (watch and steer OpenCode live).
