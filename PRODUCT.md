# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who run coding agents on their laptop and want the work to keep going after they close it. Startup founders also see the landing page, and they judge it the way a developer would.

## Product Purpose

agent-handoff moves a coding agent's task, including uncommitted work, from your laptop to a cloud sandbox. The same agent or a different one finishes the task there and returns the result as a draft pull request. Success means you can close the laptop mid-task and come back to a reviewable pull request.

## Positioning

It works with any agent that supports MCP (OpenCode, Claude Code, Codex, Pi) and with several sandbox providers (Daytona, E2B, Vercel, Prime Intellect, or your own machine over SSH). One agent can start the task and a different agent can finish it.

## Operating Context

- You install it with `npx github:bamiboy237/agent-handoff setup`. The setup wizard picks a sandbox provider and the agents that can run in the cloud, stores their keys, and registers the MCP server with your local agents.
- Your agent calls the MCP tools `handoff_prepare`, `handoff_start`, `handoff_status`, and `handoff_stop`.
- The result comes back on a `handoff/<id>-result` branch as a draft pull request.

## Capabilities and Constraints

- Uncommitted changes travel with the task through a temporary snapshot commit.
- Prime Agent can start a handoff but cannot run in the sandbox yet.
- The npm name `agent-handoff` belongs to another project, so installs run from GitHub.
- Live progress viewing ("Can I check on it?") is not built yet.
- The landing page in `site/` is static HTML, CSS, and vanilla JS with no build step, deployed to GitHub Pages.

## Brand Commitments

- Name: agent-handoff, always lowercase.
- Voice: plain, short, to the point. No stated facts for their own sake and no meta commentary.
- Must look clearly different from the owner's other project, Reelcall, which uses an italic serif headline and warm tones.

## Evidence on Hand

- A working end-to-end handoff against Daytona with OpenCode, run on a throwaway repository.
- No real screenshots or video of a handoff yet. The landing page demo is a re-creation of Claude Code and OpenCode, and it should be replaced with real footage later.
- No users, testimonials, benchmarks, or pricing exist. Do not invent them.

## Product Principles

- Close the laptop: the product exists so work continues without you.
- Bring your own agent and your own sandbox.
- The result is a pull request you review, never a silent change to your main branch.
