// The handoff tools. Tool calls return quickly; the detached helper
// (helper.ts) does the slow work.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type LocalAgent, detectLocalAgent } from "./agents/local.js";
import { REMOTE_AGENT_NAMES, remoteAgent } from "./agents/remote.js";
import { describe, findHandoff, refreshFromSandbox, remoteWork, sandboxes, sendMessage, stopHandoff } from "./checkin.js";
import { loadConfig, loadEnv } from "./config.js";
import { type HandoffBrief, type HandoffRecord, TERMINAL_STATES } from "./contract.js";
import { collectSandboxEnv } from "./credentials.js";
import { createSnapshotCommit, inspectRepo } from "./git-snapshot.js";
import { RUNNER_SCRIPT, planSetup } from "./setup.js";
import {
  appendLog,
  helperLogPath,
  listRecords,
  readRecord,
  readStartSignal,
  writeRecord,
  writeStartSignal,
} from "./store.js";

const HELPER_SCRIPT = fileURLToPath(new URL("./helper.js", import.meta.url));

// Helpers spawned by this process, so a start right after prepare does not
// spawn a second helper before the first one records its PID.
const spawnedHelpers = new Map<string, number>();

type Meta = Record<string, unknown> | undefined;

const briefSchema = z.object({
  title: z.string().min(1).max(120).describe("One line naming the work. Also the pull request title."),
  task: z.string().min(1).describe("The goal, written for an agent that has never seen this conversation."),
  done: z.string().optional().describe("What is already finished, including uncommitted edits."),
  decisions: z.string().optional().describe("Choices made and why, so the next agent does not undo them."),
  files: z.array(z.string()).optional().describe("Files that matter for the next step."),
  nextStep: z.string().min(1).describe("The exact next action."),
  verification: z.string().optional().describe("How to check the work, such as the test command."),
});

const modelSchema = z
  .string()
  .optional()
  .describe(
    "Model for the cloud agent, in that agent's own format. For OpenCode, provider/model, such as opencode/big-pickle. Defaults to the configured model, then the agent's default.",
  );

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

// The client's workspace, used to pick the newest handoff for this project.
async function workspaceDir(server: McpServer): Promise<string | undefined> {
  try {
    const { roots } = await server.server.listRoots();
    const root = roots.find((entry) => entry.uri.startsWith("file://"));
    return root ? fileURLToPath(root.uri) : undefined;
  } catch {
    return undefined;
  }
}

// The directory to hand off: the explicit argument, the calling session's
// directory, the client's first workspace root, then the server's working directory.
async function resolveProjectDir(
  server: McpServer,
  local: LocalAgent,
  sessionId: string | undefined,
  projectDir: string | undefined,
): Promise<string> {
  if (projectDir) return projectDir;
  if (sessionId && local.session) return local.session.directory(sessionId);
  try {
    const { roots } = await server.server.listRoots();
    const root = roots.find((entry) => entry.uri.startsWith("file://"));
    if (root) return fileURLToPath(root.uri);
  } catch {
    // The client does not support roots.
  }
  return process.cwd();
}

interface PrepareInput {
  brief: HandoffBrief;
  targetAgent?: string;
  model?: string;
  projectDir?: string;
}

async function prepare(
  server: McpServer,
  input: PrepareInput,
  meta: Meta,
): Promise<{ record: HandoffRecord; notes: string[] }> {
  const local = detectLocalAgent(meta, server.server.getClientVersion()?.name);
  const sessionId = local.sessionIdFromMeta(meta);
  if (sessionId) {
    const open = listRecords().find((record) => record.sessionId === sessionId && !TERMINAL_STATES.has(record.state));
    if (open) return { record: open, notes: ["This session already has an open handoff. Reusing it."] };
  }

  const config = loadConfig();
  const provider = sandboxes();
  const preflightError = provider.preflight();
  if (preflightError) throw new Error(preflightError);

  const targetName = input.targetAgent ?? config.targetAgent ?? local.name;
  const remote = remoteAgent(targetName);
  const repo = await inspectRepo(await resolveProjectDir(server, local, sessionId, input.projectDir));
  const targetAgentVersion = await remote.localVersion();
  const { env, warnings } = await collectSandboxEnv(repo.root, remote, loadEnv(), repo.githubRepo);
  const setup = planSetup(repo.root, [
    remote.name,
    targetAgentVersion ?? "latest",
    repo.cloneUrl,
    readFileSync(RUNNER_SCRIPT, "utf8"),
  ]);
  const transferSession = Boolean(sessionId && local.session && remote.resumesSessionOf === local.name);

  if (repo.secretLikeFiles.length > 0) {
    warnings.push(
      `These files are not gitignored, so the snapshot branch will include them: ${repo.secretLikeFiles.join(", ")}. Add them to .gitignore if they hold secrets.`,
    );
  }
  if (!repo.githubRepo) {
    warnings.push("The origin remote is not on GitHub. The result branch is pushed, but no draft pull request is opened.");
  }
  if (provider.capabilities.maxLifetimeMinutes) {
    warnings.push(`${provider.name} stops this sandbox after ${provider.capabilities.maxLifetimeMinutes} minutes on its current plan.`);
  }

  const id = `h${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const now = new Date().toISOString();
  const record: HandoffRecord = {
    id,
    state: "warming",
    sourceAgent: local.name,
    targetAgent: remote.name,
    targetAgentVersion,
    targetModel: input.model ?? (targetName === config.targetAgent ? config.targetModel : undefined),
    sessionId,
    transferSession,
    snapshotMode: sessionId && local.session ? "on_idle" : "immediate",
    brief: input.brief,
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
    sandboxProvider: provider.name,
    capabilities: provider.capabilities,
    cacheSnapshot: provider.capabilities.cache ? `agent-handoff-${setup.cacheKey.slice(0, 16)}` : undefined,
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

export function createServer(): McpServer {
  const server = new McpServer({ name: "agent-handoff", version: "0.2.0" });

  server.registerTool(
    "handoff_prepare",
    {
      title: "Prepare cloud handoff",
      description:
        "Start warming a cloud sandbox so this task can continue off the user's machine. Call it as soon as the user signals they want work to keep going remotely, such as leaving, closing the laptop, or asking for the cloud. Pass a complete brief. It checks the repository and credentials and returns warnings. It moves nothing yet. Follow it with handoff_start.",
      inputSchema: {
        brief: briefSchema,
        targetAgent: z
          .enum(REMOTE_AGENT_NAMES as [string, ...string[]])
          .optional()
          .describe("Agent that continues in the sandbox. Defaults to the configured agent, then the calling agent."),
        model: modelSchema,
        projectDir: z.string().optional().describe("Absolute path of the repository. Defaults to the current workspace."),
      },
    },
    async ({ brief, targetAgent, model, projectDir }, extra) => {
      try {
        const { record, notes } = await prepare(server, { brief, targetAgent, model, projectDir }, extra._meta as Meta);
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
        "Move this task and all local changes to the cloud sandbox, where it continues after the user disconnects. After calling it, end your turn immediately with one short message. Do not edit files: later edits are not transferred.",
      inputSchema: {
        handoffId: z.string().optional().describe("ID from handoff_prepare. Omit it to prepare and start in one call."),
        brief: briefSchema.optional().describe("Updated brief. Required when handoffId is omitted."),
        targetAgent: z.enum(REMOTE_AGENT_NAMES as [string, ...string[]]).optional(),
        model: modelSchema,
        projectDir: z.string().optional(),
      },
    },
    async ({ handoffId, brief, targetAgent, model, projectDir }, extra) => {
      try {
        let record: HandoffRecord;
        let notes: string[] = [];
        if (handoffId) {
          record = readRecord(handoffId);
        } else if (brief) {
          ({ record, notes } = await prepare(server, { brief, targetAgent, model, projectDir }, extra._meta as Meta));
        } else {
          return reply("handoff_start needs a handoffId from handoff_prepare, or a brief to prepare one now.", true);
        }

        if (TERMINAL_STATES.has(record.state)) {
          return reply(`Handoff ${record.id} is ${record.state}. Call handoff_prepare to begin a new one.`, true);
        }
        // Repeating a start must never launch a second remote agent.
        if (readStartSignal(record.id)) {
          return reply(`Handoff ${record.id} was already started.\n\n${describe(record)}`);
        }
        // Without a session to watch, capture the files now, before the reply.
        const snapshotCommit =
          record.snapshotMode === "immediate" ? await createSnapshotCommit(record.projectDir, record.id) : undefined;
        writeStartSignal(record.id, { brief: handoffId ? brief : undefined, snapshotCommit });
        if (!helperAlive(record)) spawnHelper(record.id);

        return reply(
          [
            `Handoff ${record.id} is starting. ${record.targetAgent} continues the work in the sandbox.`,
            ...notes,
            "End your turn now with one short message telling the user the task is moving to the cloud. Do not call more tools or edit files.",
            "In later turns: handoff_status reports progress and SSH details, handoff_work shows the changes so far, and handoff_message sends the cloud agent new instructions.",
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
        "Check on a handoff: its progress, recent remote log, draft pull request, and SSH details. Omit handoffId for the latest handoff of this session or workspace.",
      inputSchema: {
        handoffId: z.string().optional(),
      },
    },
    async ({ handoffId }, extra) => {
      try {
        const local = detectLocalAgent(extra._meta as Meta, server.server.getClientVersion()?.name);
        const sessionId = local.sessionIdFromMeta(extra._meta as Meta);
        const records = listRecords();
        let record = handoffId
          ? readRecord(handoffId)
          : (records.find((r) => sessionId && r.sessionId === sessionId) ?? records[0]);
        if (!record) return reply("No handoffs found.");

        let lines: string[] = [];
        if (!helperAlive(record) && record.sandboxId && (record.state === "running" || record.state === "completed")) {
          ({ record, lines } = await refreshFromSandbox(record));
        }
        return reply(describe(record, lines));
      } catch (error) {
        return reply(`handoff_status failed: ${errorText(error)}`, true);
      }
    },
  );

  server.registerTool(
    "handoff_work",
    {
      title: "Cloud agent's work so far",
      description:
        "Show what the cloud agent has changed since the handoff: its commits, changed files, and new files. Set diff to include the full diff. Omit handoffId for the latest handoff in this workspace.",
      inputSchema: {
        handoffId: z.string().optional(),
        diff: z.boolean().optional().describe("Include the full diff. It can be long."),
      },
    },
    async ({ handoffId, diff }) => {
      try {
        const record = findHandoff(handoffId, await workspaceDir(server));
        const work = await remoteWork(record, diff ?? false);
        // Keeps a long diff from flooding the conversation.
        const limit = 40_000;
        return reply(work.length > limit ? `${work.slice(0, limit)}\n\n[Truncated. Run \`agent-handoff work --diff\` for the rest.]` : work);
      } catch (error) {
        return reply(`handoff_work failed: ${errorText(error)}`, true);
      }
    },
  );

  server.registerTool(
    "handoff_message",
    {
      title: "Message the cloud agent",
      description:
        "Send the cloud agent new instructions, such as a correction or an extra task. A running agent reads them when its current turn ends and continues in the same session. A finished run resumes to answer them, then updates the result branch and pull request. Omit handoffId for the latest handoff in this workspace.",
      inputSchema: {
        handoffId: z.string().optional(),
        message: z.string().min(1).describe("The instructions, written for the cloud agent."),
      },
    },
    async ({ handoffId, message }) => {
      try {
        const record = findHandoff(handoffId, await workspaceDir(server));
        return reply(await sendMessage(record, message));
      } catch (error) {
        return reply(`handoff_message failed: ${errorText(error)}`, true);
      }
    },
  );

  server.registerTool(
    "handoff_stop",
    {
      title: "Stop cloud handoff",
      description: "Stop a handoff and its remote agent. Pushed branches stay on the remote.",
      inputSchema: {
        handoffId: z.string(),
      },
    },
    async ({ handoffId }) => {
      try {
        const record = readRecord(handoffId);
        const helperPid = record.helperPid ?? spawnedHelpers.get(record.id);
        return reply(describe(await stopHandoff({ ...record, helperPid })));
      } catch (error) {
        return reply(`handoff_stop failed: ${errorText(error)}`, true);
      }
    },
  );

  return server;
}
