---
name: handoff
description: Move the current OpenCode session and all local changes to a cloud sandbox so the task keeps running after the user disconnects. Use when the user wants work to continue without their machine, for example "move this to the cloud", "keep going while I'm away", "I need to close my laptop, finish this", or "run this remotely". Do not use for deploying an app or running a single remote command.
---

# Cloud handoff

The agent-handoff MCP server moves this session to a Daytona sandbox. The
task continues there after the user's machine disconnects. The user does
not need a special phrase. Infer the intent from what they say.

## When handoff fits

Hand off when the user wants the current task to keep going without them
or their machine. Typical signals:

- They are leaving, closing the laptop, or going offline.
- They ask for the work to run in the cloud or on a remote machine.
- The remaining work is long and they do not want to wait for it locally.

Ask one short question first when the intent is unclear. Do not hand off
for deploys, one-off remote commands, or questions about cloud services.

## Steps

1. Call `handoff_prepare` as soon as you notice the intent.
   - Pass `task`: what you are doing, what is done, and the exact next step.
     Write it for a fresh agent with no other context.
   - Preparation warms the sandbox in the background. Keep working while it runs.
2. Read the result. Tell the user about each warning, such as a missing
   `GITHUB_TOKEN` or files that the snapshot branch would include.
3. When the user is ready to move, call `handoff_start` with the `handoffId`.
   - Pass an updated `task` if the work moved on since step 1.
   - If the user wants to move right away, skip step 1. Call
     `handoff_start` with only `task`.
4. End your turn immediately after `handoff_start`.
   - Write one short message saying the session is moving to the cloud.
   - Do not call more tools. Do not edit files.
   - The transfer waits for your turn to end, so any later edit is lost
     or splits the work.

## After the handoff

- The remote session owns the task. Treat this local session as read-only.
- Call `handoff_status` when the user asks about progress. It returns the
  state, the remote log, the draft pull request, and the SSH and Zed details.
- Give the user the `zed ssh://...` command from `handoff_status` when they
  want to open the remote workspace.
- Call `handoff_stop` only when the user asks to stop the remote work.
