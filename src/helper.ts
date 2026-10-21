// Detached helper for one handoff. It outlives the MCP tool call so the
// agent can end its turn before the session is exported.
//
//   warm -> wait for handoff_start -> wait for idle -> snapshot and export
//   -> checkout and setup -> cache snapshot -> start the remote runner
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { agentAdapter } from "./agents/agent.js";
import type { HandoffRecord, HandoffState } from "./contract.js";
import { collectSandboxEnv } from "./credentials.js";
import { createSnapshotCommit, pushSnapshot } from "./git-snapshot.js";
import { sandboxAdapter } from "./sandboxes/sandbox.js";
import { RUNNER_SCRIPT, renderSetupScript } from "./setup.js";
import { appendLog, startSignalPath, updateRecord } from "./store.js";

const START_WAIT_MS = 20 * 60_000;
const START_POLL_MS = 500;
const IDLE_TIMEOUT_MS = 30 * 60_000;
const AUTO_STOP_MINUTES = 30;
const SSH_MINUTES = 24 * 60;
const HEARTBEAT_PORT = 7979;

class StepError extends Error {
  constructor(
    readonly step: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function renderEnvFile(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join("\n")
    .concat("\n");
}

function continuationPrompt(record: HandoffRecord): string {
  return [
    `agent-handoff moved this session from the user's machine to a cloud sandbox (handoff ${record.id}).`,
    `The repository is at ${record.remoteDir} on branch ${record.resultBranch}. It includes every local change, including uncommitted work.`,
    "The user may be offline. Do not wait for answers. Make reasonable decisions and note them in your commit messages.",
    "",
    "Continue this task:",
    record.task,
    "",
    "Commit your work as you go. When the task is done, stop. The runner pushes the branch and opens a draft pull request.",
  ].join("\n");
}

async function waitForStartSignal(id: string): Promise<{ task?: string } | undefined> {
  const deadline = Date.now() + START_WAIT_MS;
  const path = startSignalPath(id);
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as { task?: string };
    await sleep(START_POLL_MS);
  }
  return undefined;
}

async function run(id: string): Promise<void> {
  let record = updateRecord(id, (r) => {
    r.helperPid = process.pid;
  });
  const agent = agentAdapter(record.agent);
  const sandboxes = sandboxAdapter(record.sandboxProvider);

  const progress = (message: string, state?: HandoffState, change?: (r: HandoffRecord) => void) => {
    record = updateRecord(id, (r) => {
      if (state) r.state = state;
      change?.(r);
      appendLog(r, message);
    });
    console.log(`${new Date().toISOString()} ${message}`);
  };

  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      throw new StepError(name, error);
    }
  };

  const runPhase = (phase: string, timeoutSeconds: number, env: Record<string, string> = {}) =>
    step(phase, async () => {
      const assignments = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
      const command = ["env", ...assignments, "bash", `${record.remoteHome}/.agent-handoff/runner.sh`, phase].join(" ");
      const result = await sandboxes.exec(record.sandboxId!, `bash -c ${shellQuote(command)}`, timeoutSeconds);
      if (result.exitCode !== 0) {
        throw new Error(`runner.sh ${phase} exited with ${result.exitCode}: ${result.output.slice(-1500)}`);
      }
    });

  const upload = (name: string, content: string) =>
    sandboxes.upload(record.sandboxId!, content, `${record.remoteHome}/.agent-handoff/${name}`);

  const handoffEnv = (extra: Record<string, string> = {}) =>
    renderEnvFile({
      HANDOFF_ID: record.id,
      OPENCODE_VERSION: record.agentVersion,
      REPO_URL: record.cloneUrl,
      SNAPSHOT_BRANCH: record.snapshotBranch,
      RESULT_BRANCH: record.resultBranch,
      BASE_BRANCH: record.baseBranch,
      WORKDIR: record.remoteDir!,
      SESSION_ID: record.sessionId,
      GITHUB_REPO: record.githubRepo ?? "",
      GIT_AUTHOR_NAME: record.gitAuthorName,
      GIT_AUTHOR_EMAIL: record.gitAuthorEmail,
      ...extra,
    });

  // 1. Warm the sandbox while the local agent keeps working.
  if (!record.sandboxId) {
    const created = await step("create_sandbox", async () => {
      const { env } = await collectSandboxEnv(record.projectDir, agent);
      return sandboxes.create({
        cacheSnapshot: record.cacheSnapshot,
        env,
        labels: { "agent-handoff": record.id },
        autoStopMinutes: AUTO_STOP_MINUTES,
      });
    });
    progress(`Created sandbox ${created.id}${created.cacheHit ? " from the cached snapshot" : ""}.`, undefined, (r) => {
      r.sandboxId = created.id;
      r.cacheHit = created.cacheHit;
      r.remoteHome = created.homeDir;
      r.remoteDir = `${created.homeDir}/workspace/${r.repoName}`;
    });
    await step("upload_runner", async () => {
      await sandboxes.exec(record.sandboxId!, `mkdir -p ${record.remoteHome}/.agent-handoff`, 30);
      await upload("runner.sh", readFileSync(RUNNER_SCRIPT, "utf8"));
    });
    await runPhase("install-agent", 900, { OPENCODE_VERSION: record.agentVersion });
    progress(`Sandbox is warm with OpenCode ${record.agentVersion}.`, "warm");
  }

  // 2. Wait for handoff_start. Delete the sandbox if it never comes.
  const signal = await waitForStartSignal(id);
  if (!signal) {
    await sandboxes.remove(record.sandboxId!);
    progress("handoff_start was not called within 20 minutes. Deleted the warm sandbox.", "abandoned");
    return;
  }
  progress("Start requested. Waiting for the local turn to end.", "waiting_for_idle", (r) => {
    r.startRequested = true;
    if (signal.task) r.task = signal.task;
  });

  // 3. Capture the finished turn and the files on disk.
  await step("wait_for_idle", () => agent.waitUntilIdle(record.sessionId, IDLE_TIMEOUT_MS));
  progress("Local session is idle. Creating the snapshot commit.", "transferring");
  const snapshotCommit = await step("snapshot", () => createSnapshotCommit(record.projectDir, record.id));
  await step("push_snapshot", () => pushSnapshot(record.projectDir, snapshotCommit, record.snapshotBranch));
  progress(`Pushed ${snapshotCommit.slice(0, 12)} to ${record.snapshotBranch}.`, undefined, (r) => {
    r.snapshotCommit = snapshotCommit;
  });
  const sessionExport = await step("export_session", () => agent.exportSession(record.sessionId));

  // 4. Restore the project. The session is uploaded after the cache snapshot
  //    so transcripts never end up in a reusable image.
  progress("Restoring the project in the sandbox.", "setting_up");
  await step("upload_config", async () => {
    await upload("handoff.env", handoffEnv());
    await upload("setup.sh", renderSetupScript(record.setupCommands));
  });
  await runPhase("checkout", 900);
  await runPhase("setup", 3600);
  if (!record.cacheHit) {
    try {
      await sandboxes.saveCache(record.sandboxId!, record.cacheSnapshot);
      progress(`Saved cache snapshot ${record.cacheSnapshot} for later handoffs.`);
    } catch (error) {
      progress(`Could not save the cache snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 5. Start the remote session in the background.
  await step("start_remote", async () => {
    const heartbeat = await sandboxes.heartbeat(record.sandboxId!, HEARTBEAT_PORT);
    await upload(
      "handoff.env",
      handoffEnv({
        HEARTBEAT_PORT: String(HEARTBEAT_PORT),
        HEARTBEAT_URL: heartbeat.url,
        HEARTBEAT_TOKEN: heartbeat.headers["X-Daytona-Preview-Token"] ?? "",
      }),
    );
    await upload("session.json", sessionExport);
    await upload("task.txt", record.task);
    await upload("prompt.txt", continuationPrompt(record));
    await sandboxes.startBackground(record.sandboxId!, "agent-handoff", `bash ${record.remoteHome}/.agent-handoff/runner.sh run`);
  });
  const ssh = await step("ssh_access", () => sandboxes.sshAccess(record.sandboxId!, record.remoteDir!, SSH_MINUTES));

  try {
    await agent.markHandedOff(record.sessionId, record.id);
  } catch (error) {
    progress(`Could not retitle the local session: ${error instanceof Error ? error.message : String(error)}`);
  }
  progress("Remote session is running. The local session is now read-only by convention.", "running", (r) => {
    r.ssh = ssh;
  });
}

const id = process.argv[2];
if (!id) {
  console.error("usage: helper.js <handoff-id>");
  process.exit(2);
}

run(id).catch((error: unknown) => {
  const step = error instanceof StepError ? error.step : "helper";
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${new Date().toISOString()} failed at ${step}: ${message}`);
  process.exitCode = 1;
  try {
    updateRecord(id, (r) => {
      r.state = "failed";
      r.failedStep = step;
      r.error = message;
      appendLog(r, `Failed at ${step}: ${message}`);
    });
  } catch {
    // The record is missing, so the id was wrong. The message above is all there is to report.
  }
});
