// Detached helper for one handoff. It outlives the MCP tool call so the
// agent can end its turn before the work is captured.
//
//   warm -> wait for handoff_start -> wait for idle (when the session is known)
//   -> push the snapshot -> checkout and setup -> cache (when supported)
//   -> start the remote runner
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { localAgentByName } from "./agents/local.js";
import { remoteAgent } from "./agents/remote.js";
import { continuationPrompt, renderBrief } from "./brief.js";
import { OPENCODE_PORT, WATCH_PORT, publishWatchLink } from "./checkin.js";
import { loadConfig, loadEnv } from "./config.js";
import type { HandoffRecord, HandoffState } from "./contract.js";
import { collectSandboxEnv } from "./credentials.js";
import { createSnapshotCommit, pushSnapshot } from "./git-snapshot.js";
import { sandboxAdapter } from "./sandboxes/sandbox.js";
import { RUNNER_SCRIPT, TRANSCRIPT_SCRIPT, WATCH_SCRIPT, renderSetupScript } from "./setup.js";
import { type StartSignal, appendLog, readRecord, readStartSignal, updateRecord } from "./store.js";

const START_WAIT_MS = 20 * 60_000;
const START_POLL_MS = 500;
const IDLE_TIMEOUT_MS = 30 * 60_000;
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

async function waitForStartSignal(id: string): Promise<StartSignal | undefined> {
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    const signal = readStartSignal(id);
    if (signal) return signal;
    await sleep(START_POLL_MS);
  }
  return undefined;
}

async function run(id: string): Promise<void> {
  let record = updateRecord(id, (r) => {
    r.helperPid = process.pid;
  });
  const local = localAgentByName(record.sourceAgent);
  const remote = remoteAgent(record.targetAgent);
  const sandboxes = sandboxAdapter({ ...loadConfig(), provider: record.sandboxProvider }, loadEnv());

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

  const handoffDir = () => `${record.remoteRoot}/.agent-handoff`;

  const runnerCommand = (phase: string) =>
    ["env", `HANDOFF_HOME=${shellQuote(handoffDir())}`, "bash", shellQuote(`${handoffDir()}/runner.sh`), phase].join(" ");

  const runPhase = (phase: string, timeoutSeconds: number) =>
    step(phase, async () => {
      const result = await sandboxes.exec(record.sandboxId!, `bash -c ${shellQuote(runnerCommand(phase))}`, timeoutSeconds);
      if (result.exitCode !== 0) {
        throw new Error(`runner.sh ${phase} exited with ${result.exitCode}: ${result.output.slice(-1500)}`);
      }
    });

  const upload = (name: string, content: string) => sandboxes.upload(record.sandboxId!, content, `${handoffDir()}/${name}`);

  const handoffEnv = (extra: Record<string, string> = {}) =>
    renderEnvFile({
      HANDOFF_ID: record.id,
      TARGET_AGENT: record.targetAgent,
      AGENT_VERSION: record.targetAgentVersion ?? "",
      AGENT_MODEL: record.targetModel ?? "",
      REPO_URL: record.cloneUrl,
      SNAPSHOT_BRANCH: record.snapshotBranch,
      RESULT_BRANCH: record.resultBranch,
      BASE_BRANCH: record.baseBranch,
      WORKDIR: record.remoteDir!,
      SESSION_ID: record.sessionId ?? "",
      GITHUB_REPO: record.githubRepo ?? "",
      GIT_AUTHOR_NAME: record.gitAuthorName,
      GIT_AUTHOR_EMAIL: record.gitAuthorEmail,
      WATCH_PORT: String(WATCH_PORT),
      WATCH_KEY: record.watchKey ?? "",
      OPENCODE_PORT: String(OPENCODE_PORT),
      ...extra,
    });

  // 1. Warm the sandbox while the local agent keeps working.
  if (!record.sandboxId) {
    const created = await step("create_sandbox", async () => {
      const { env } = await collectSandboxEnv(record.projectDir, remote, loadEnv());
      return sandboxes.create({
        handoffId: record.id,
        cacheSnapshot: record.cacheSnapshot,
        env,
        labels: { "agent-handoff": record.id },
      });
    });
    progress(`Created sandbox ${created.id}${created.cacheHit ? " from the cached snapshot" : ""}.`, undefined, (r) => {
      r.sandboxId = created.id;
      r.cacheHit = created.cacheHit;
      r.remoteRoot = created.root;
      r.remoteDir = `${created.root}/workspace/${r.repoName}`;
    });
    await step("upload_runner", async () => {
      await sandboxes.exec(record.sandboxId!, `mkdir -p ${shellQuote(handoffDir())}`, 30);
      await upload("runner.sh", readFileSync(RUNNER_SCRIPT, "utf8"));
      await upload("watch.mjs", readFileSync(WATCH_SCRIPT, "utf8"));
      await upload("transcript.mjs", readFileSync(TRANSCRIPT_SCRIPT, "utf8"));
      await upload("handoff.env", handoffEnv());
    });
    await runPhase("install-agent", 900);
    progress(`Sandbox is warm with ${record.targetAgent} ${record.targetAgentVersion ?? "(latest)"}.`, "warm");
    // The watch link is ready before handoff_start, so the agent can hand it out at once.
    try {
      if ((await publishWatchLink(readRecord(id))).watchUrl) progress("Watch link is ready.");
    } catch (error) {
      progress(`Could not create a watch link: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 2. Wait for handoff_start. Delete the sandbox if it never comes.
  const signal = await waitForStartSignal(id);
  if (!signal) {
    await sandboxes.remove(record.sandboxId!);
    progress("handoff_start was not called within 20 minutes. Deleted the warm sandbox.", "abandoned");
    return;
  }
  progress("Start requested.", undefined, (r) => {
    r.startRequested = true;
    if (signal.brief) r.brief = signal.brief;
  });

  // 3. Capture the work. A known session is captured once its turn ends;
  //    otherwise handoff_start already took the snapshot at call time.
  let snapshotCommit = signal.snapshotCommit;
  if (record.snapshotMode === "on_idle" && record.sessionId && local.session) {
    progress("Waiting for the local turn to end.", "waiting_for_idle");
    await step("wait_for_idle", () => local.session!.waitUntilIdle(record.sessionId!, IDLE_TIMEOUT_MS));
    snapshotCommit = await step("snapshot", () => createSnapshotCommit(record.projectDir, record.id));
  }
  if (!snapshotCommit) throw new StepError("snapshot", new Error("No snapshot commit was taken."));
  progress("Pushing the snapshot commit.", "transferring");
  await step("push_snapshot", () => pushSnapshot(record.projectDir, snapshotCommit, record.snapshotBranch));
  progress(`Pushed ${snapshotCommit.slice(0, 12)} to ${record.snapshotBranch}.`, undefined, (r) => {
    r.snapshotCommit = snapshotCommit;
  });
  const sessionExport =
    record.transferSession && record.sessionId && local.session
      ? await step("export_session", () => local.session!.exportSession(record.sessionId!))
      : undefined;

  // 4. Restore the project. Private files are uploaded after the cache snapshot
  //    so transcripts and tokens never end up in a reusable image.
  progress("Restoring the project in the sandbox.", "setting_up");
  await step("upload_config", async () => {
    await upload("handoff.env", handoffEnv());
    await upload("setup.sh", renderSetupScript(record.setupCommands));
  });
  await runPhase("checkout", 900);
  await runPhase("setup", 3600);
  if (record.cacheSnapshot && !record.cacheHit && sandboxes.saveCache) {
    try {
      await sandboxes.saveCache(record.sandboxId!, record.cacheSnapshot);
      progress(`Saved cache snapshot ${record.cacheSnapshot} for later handoffs.`);
    } catch (error) {
      progress(`Could not save the cache snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 5. Start the remote agent in the background.
  await step("start_remote", async () => {
    const heartbeat = sandboxes.heartbeat ? await sandboxes.heartbeat(record.sandboxId!, HEARTBEAT_PORT) : undefined;
    await upload(
      "handoff.env",
      handoffEnv(
        heartbeat
          ? {
              HEARTBEAT_PORT: String(HEARTBEAT_PORT),
              HEARTBEAT_URL: heartbeat.url,
              HEARTBEAT_TOKEN: Object.values(heartbeat.headers)[0] ?? "",
            }
          : {},
      ),
    );
    if (sessionExport) await upload("session.json", sessionExport);
    await upload("title.txt", record.brief.title);
    await upload("brief.md", renderBrief(record.brief));
    await upload("prompt.txt", continuationPrompt(record));
    await sandboxes.startBackground(record.sandboxId!, "agent-handoff", runnerCommand("run"));
  });
  const ssh = sandboxes.sshAccess
    ? await step("ssh_access", () => sandboxes.sshAccess!(record.sandboxId!, record.remoteDir!))
    : undefined;

  if (record.sessionId && local.session) {
    try {
      await local.session.markHandedOff(record.sessionId, record.id);
    } catch (error) {
      progress(`Could not retitle the local session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  progress(`${record.targetAgent} is running in the sandbox. The local session is now read-only by convention.`, "running", (r) => {
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
