#!/usr/bin/env node
// MCP server that hands an active OpenCode session off to a Daytona sandbox.
// Tool calls return quickly; the detached helper (helper.ts) does the slow work.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { agentAdapter } from "./agents/agent.js";
import { type HandoffRecord, TERMINAL_STATES } from "./contract.js";
import { collectSandboxEnv } from "./credentials.js";
import { inspectRepo } from "./git-snapshot.js";
import { sandboxAdapter } from "./sandboxes/sandbox.js";
import { RUNNER_SCRIPT, planSetup } from "./setup.js";
import {
  appendLog,
  helperLogPath,
  listRecords,
  readRecord,
  startSignalPath,
  updateRecord,
  writeRecord,
} from "./store.js";

const HELPER_SCRIPT = fileURLToPath(new URL("./helper.js", import.meta.url));
const SSH_MINUTES = 24 * 60;

const agent = agentAdapter("opencode");
const sandboxes = sandboxAdapter("daytona");

// Helpers spawned by this process, so a start right after prepare does not
// spawn a second helper before the first one records its PID.
const spawnedHelpers = new Map<string, number>();

type Meta = Record<string, unknown> | undefined;

function reply(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function helperAlive(record: HandoffRecord): boolean {
  const pid = record.helperPid ?? spawnedHelpers.get(record.id);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnHelper(id: string): void {
  const log = openSync(helperLogPath(id), "a");
  const child = spawn(process.execPath, [HELPER_SCRIPT, id], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  if (child.pid) spawnedHelpers.set(id, child.pid);
}

function findRecord(handoffId: string | undefined, meta: Meta): HandoffRecord | undefined {
  if (handoffId) return readRecord(handoffId);
  const sessionId = agent.sessionIdFromMeta(meta);
  const records = listRecords();
  return records.find((record) => record.sessionId === sessionId) ?? records[0];
}

function describe(record: HandoffRecord, extra: string[] = []): string {
  const lines = [
    `Handoff: ${record.id}`,
    `State: ${record.state}`,
    ...(record.failedStep ? [`Failed step: ${record.failedStep}`, `Error: ${record.error}`] : []),
    `Session: ${record.sessionId}`,
    `Branches: ${record.baseBranch} -> ${record.snapshotBranch} -> ${record.resultBranch}`,
    ...(record.sandboxId ? [`Sandbox: ${record.sandboxProvider} ${record.sandboxId}`] : []),
    ...(record.remoteDir ? [`Remote directory: ${record.remoteDir}`] : []),
    ...(record.prUrl ? [`Draft pull request: ${record.prUrl}`] : []),
    ...(record.ssh ? [`SSH: ${record.ssh.command}`, `Open in Zed: ${record.ssh.zedCommand}`] : []),
    ...extra,
    "Recent events:",
    ...record.log.slice(-8).map((entry) => `  ${entry.at} ${entry.message}`),
  ];
  return lines.join("\n");
}

async function prepare(task: string, meta: Meta): Promise<{ record: HandoffRecord; notes: string[] }> {
  const sessionId = agent.sessionIdFromMeta(meta);
  if (!sessionId) {
    throw new Error("OpenCode did not send the calling session ID. Call this tool from an OpenCode session.");
  }
  const open = listRecords().find((record) => record.sessionId === sessionId && !TERMINAL_STATES.has(record.state));
  if (open) return { record: open, notes: ["This session already has an open handoff. Reusing it."] };

  const preflightError = sandboxes.preflight();
  if (preflightError) throw new Error(preflightError);

  const session = await agent.getSession(sessionId);
  const repo = await inspectRepo(session.directory);
  const agentVersion = await agent.version();
  const { env, warnings } = await collectSandboxEnv(repo.root, agent, repo.githubRepo);
  const setup = planSetup(repo.root, [
    agent.name,
    agentVersion,
    repo.cloneUrl,
    readFileSync(RUNNER_SCRIPT, "utf8"),
  ]);

  if (repo.secretLikeFiles.length > 0) {
    warnings.push(
      `These files are not gitignored, so the snapshot branch will include them: ${repo.secretLikeFiles.join(", ")}. Add them to .gitignore if they hold secrets.`,
    );
  }
  if (!repo.githubRepo) {
    warnings.push("The origin remote is not on GitHub. The result branch is pushed, but no draft pull request is opened.");
  }

  const id = `h${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const now = new Date().toISOString();
  const record: HandoffRecord = {
    id,
    state: "warming",
    agent: agent.name,
    sessionId,
    task,
    projectDir: repo.root,
    repoName: repo.repoName,
    remoteUrl: repo.remoteUrl,
    cloneUrl: repo.cloneUrl,
    githubRepo: repo.githubRepo,
    gitAuthorName: repo.authorName,
    gitAuthorEmail: repo.authorEmail,
    baseBranch: repo.baseBranch,
    baseCommit: repo.baseCommit,
    snapshotBranch: `handoff/${id}`,
    resultBranch: `handoff/${id}-result`,
    sandboxProvider: sandboxes.name,
    cacheSnapshot: `agent-handoff-${setup.cacheKey.slice(0, 16)}`,
    agentVersion,
    setupCommands: setup.commands,
    envKeys: Object.keys(env).sort(),
    startRequested: false,
    createdAt: now,
    updatedAt: now,
    log: [],
  };
  appendLog(record, `Prepared from ${repo.baseBranch} at ${repo.baseCommit.slice(0, 12)} with ${repo.changedFiles} changed files.`);
  writeRecord(record);
  spawnHelper(id);

  const notes = [
    `Detected setup: ${setup.detected.length > 0 ? setup.detected.join(", ") : "none"}`,
    `Sandbox environment variables: ${record.envKeys.join(", ") || "none"}`,
    ...warnings.map((warning) => `Warning: ${warning}`),
  ];
  return { record, notes };
}

const server = new McpServer({ name: "agent-handoff", version: "0.1.0" });

server.registerTool(
  "handoff_prepare",
  {
    title: "Prepare cloud handoff",
    description:
      "Start warming a cloud sandbox for moving this session off the user's machine. Call it as soon as the user signals they want work to continue remotely, such as leaving, closing the laptop, or wanting the task to keep running in the cloud. It checks the repository and credentials and returns warnings. It does not move anything yet. Follow it with handoff_start.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe("The task in progress and the exact next step, written so a fresh agent could continue it."),
    },
  },
  async ({ task }, extra) => {
    try {
      const { record, notes } = await prepare(task, extra._meta as Meta);
      return reply([describe(record), ...notes, "", "Call handoff_start when the user is ready to move."].join("\n"));
    } catch (error) {
      return reply(`handoff_prepare failed: ${errorText(error)}`, true);
    }
  },
);

server.registerTool(
  "handoff_start",
  {
    title: "Start cloud handoff",
    description:
      "Move this session and all local changes to the prepared cloud sandbox, where the task continues after the user disconnects. The transfer begins after your current turn ends. After calling it, end your turn immediately with one short message and do not edit files.",
    inputSchema: {
      handoffId: z.string().optional().describe("ID from handoff_prepare. Omit it to prepare and start in one call."),
      task: z
        .string()
        .optional()
        .describe("Updated task and next step. Required when handoffId is omitted."),
    },
  },
  async ({ handoffId, task }, extra) => {
    try {
      let record: HandoffRecord;
      let notes: string[] = [];
      if (handoffId) {
        record = readRecord(handoffId);
      } else if (task) {
        ({ record, notes } = await prepare(task, extra._meta as Meta));
      } else {
        return reply("handoff_start needs a handoffId from handoff_prepare, or a task to prepare one now.", true);
      }

      if (TERMINAL_STATES.has(record.state)) {
        return reply(`Handoff ${record.id} is ${record.state}. Call handoff_prepare to begin a new one.`, true);
      }
      // Repeating a start must never launch a second remote agent.
      if (existsSync(startSignalPath(record.id))) {
        return reply(`Handoff ${record.id} was already started.\n\n${describe(record)}`);
      }
      writeFileSync(startSignalPath(record.id), JSON.stringify({ task }), { mode: 0o600 });
      if (!helperAlive(record)) spawnHelper(record.id);

      return reply(
        [
          `Handoff ${record.id} is starting.`,
          ...notes,
          "End your turn now with one short message telling the user the session is moving to the cloud. Do not call more tools or edit files. The transfer begins when this turn ends.",
          "The user can check progress and get the SSH and Zed details with handoff_status.",
        ].join("\n"),
      );
    } catch (error) {
      return reply(`handoff_start failed: ${errorText(error)}`, true);
    }
  },
);

server.registerTool(
  "handoff_status",
  {
    title: "Cloud handoff status",
    description:
      "Report a handoff's progress, remote logs, draft pull request, and the SSH and Zed connection details. Omit handoffId for this session's latest handoff.",
    inputSchema: {
      handoffId: z.string().optional(),
    },
  },
  async ({ handoffId }, extra) => {
    try {
      let record = findRecord(handoffId, extra._meta as Meta);
      if (!record) return reply("No handoffs found.");
      const extraLines: string[] = [];

      // Once the helper exits, the sandbox is the source of truth.
      if (!helperAlive(record) && record.sandboxId && (record.state === "running" || record.state === "completed")) {
        const sandboxState = await sandboxes.state(record.sandboxId);
        extraLines.push(`Sandbox state: ${sandboxState}`);
        if (sandboxState === "started") {
          const result = await sandboxes.exec(
            record.sandboxId,
            "bash -c 'cd ~/.agent-handoff 2>/dev/null && { cat state; echo @@; cat pr-url; echo @@; tail -n 30 runner.log; } 2>/dev/null'",
            30,
          );
          const [remoteState = "", prUrl = "", remoteLog = ""] = result.output.split("@@").map((part) => part.trim());
          const sshExpired = !record.ssh || Date.parse(record.ssh.expiresAt) < Date.now();
          const ssh = sshExpired
            ? await sandboxes.sshAccess(record.sandboxId, record.remoteDir!, SSH_MINUTES)
            : record.ssh;
          record = updateRecord(record.id, (r) => {
            if (remoteState === "completed" && r.state !== "completed") {
              r.state = "completed";
              appendLog(r, "Remote agent finished and pushed the result branch.");
            } else if (remoteState.startsWith("failed:")) {
              r.state = "failed";
              r.failedStep = `remote_${remoteState.slice("failed:".length)}`;
              r.error = "The remote runner failed. See the remote log.";
            }
            if (prUrl) r.prUrl = prUrl;
            r.ssh = ssh;
          });
          if (remoteLog) extraLines.push("Remote log:", remoteLog);
        }
      }
      return reply(describe(record, extraLines));
    } catch (error) {
      return reply(`handoff_status failed: ${errorText(error)}`, true);
    }
  },
);

server.registerTool(
  "handoff_stop",
  {
    title: "Stop cloud handoff",
    description:
      "Stop a handoff and its remote agent. The sandbox stops but keeps its disk. Pushed branches stay on the remote.",
    inputSchema: {
      handoffId: z.string(),
    },
  },
  async ({ handoffId }) => {
    try {
      const record = readRecord(handoffId);
      if (helperAlive(record)) process.kill((record.helperPid ?? spawnedHelpers.get(record.id))!, "SIGTERM");
      if (record.sandboxId && (await sandboxes.state(record.sandboxId)) === "started") {
        await sandboxes.stop(record.sandboxId);
      }
      const stopped = updateRecord(handoffId, (r) => {
        r.state = "stopped";
        appendLog(r, "Stopped through handoff_stop.");
      });
      return reply(describe(stopped));
    } catch (error) {
      return reply(`handoff_stop failed: ${errorText(error)}`, true);
    }
  },
);

await server.connect(new StdioServerTransport());
