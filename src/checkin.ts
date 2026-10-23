// Checking in on a handoff after it starts: its status, the agent's work so far,
// the remote log, messages to the agent, and shell access. The MCP tools and the
// `agent-handoff` commands share these functions.
import { renderUnicodeCompact } from "uqr";
import { loadConfig, loadEnv } from "./config.js";
import { type HandoffRecord, type SshDetails, TERMINAL_STATES } from "./contract.js";
import { type SandboxAdapter, sandboxAdapter } from "./sandboxes/sandbox.js";
import { appendLog, listRecords, readRecord, updateRecord } from "./store.js";

export function sandboxes(provider?: string): SandboxAdapter {
  const config = loadConfig();
  return sandboxAdapter(provider ? { ...config, provider } : config, loadEnv());
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const remoteHome = (record: HandoffRecord) => `${record.remoteRoot}/.agent-handoff`;

// Ports inside the sandbox: the watch page, and OpenCode's server (runner.sh pins it).
export const WATCH_PORT = 7980;
export const OPENCODE_PORT = 49374;
// Renews a watch link this long before it expires, so a link you are handed still has time left.
const WATCH_RENEW_MS = 2 * 60 * 60_000;

// The runner phase command, the same one the helper uses to start the run.
export const runnerCommand = (record: HandoffRecord, phase: string) =>
  ["env", `HANDOFF_HOME=${shellQuote(remoteHome(record))}`, "bash", shellQuote(`${remoteHome(record)}/runner.sh`), phase].join(
    " ",
  );

export function describe(record: HandoffRecord, extra: string[] = []): string {
  const lines = [
    `Handoff: ${record.id}`,
    `State: ${record.state}`,
    ...(record.failedStep ? [`Failed step: ${record.failedStep}`, `Error: ${record.error}`] : []),
    `Agents: ${record.sourceAgent} -> ${record.targetAgent}${record.transferSession ? " (session moved)" : " (brief only)"}`,
    ...(record.targetModel ? [`Model: ${record.targetModel}`] : []),
    `Branches: ${record.baseBranch} -> ${record.snapshotBranch} -> ${record.resultBranch}`,
    ...(record.sandboxId ? [`Sandbox: ${record.sandboxProvider} ${record.sandboxId}`] : []),
    ...(record.remoteDir ? [`Remote directory: ${record.remoteDir}`] : []),
    ...(record.prUrl ? [`Draft pull request: ${record.prUrl}`] : []),
    ...(record.watchUrl ? [`Watch link: ${record.watchUrl}`] : []),
    ...(record.ssh ? [`SSH: ${record.ssh.command}`] : []),
    ...(record.ssh?.uri ? [`Editor URI: ${record.ssh.uri}`] : []),
    ...extra,
    "Recent events:",
    ...record.log.slice(-8).map((entry) => `  ${entry.at} ${entry.message}`),
  ];
  return lines.join("\n");
}

// The handoff a check-in refers to: the one named, else the newest for this
// project, else the newest overall.
export function findHandoff(handoffId?: string, projectDir?: string): HandoffRecord {
  if (handoffId) return readRecord(handoffId);
  const record = (projectDir ? listRecords(projectDir)[0] : undefined) ?? listRecords()[0];
  if (!record) throw new Error("No handoffs found.");
  return record;
}

// Runs a script in the sandbox, after checking it can be reached at all.
async function remoteRun(record: HandoffRecord, script: string, timeoutSeconds = 30) {
  if (!record.sandboxId || !record.remoteRoot) {
    throw new Error(`Handoff ${record.id} has no sandbox yet. Its state is ${record.state}.`);
  }
  const provider = sandboxes(record.sandboxProvider);
  const state = await provider.state(record.sandboxId);
  if (state !== "running") {
    throw new Error(`The ${record.sandboxProvider} sandbox for handoff ${record.id} is ${state}, so it cannot be reached.`);
  }
  return { provider, result: await provider.exec(record.sandboxId, `bash -c ${shellQuote(script)}`, timeoutSeconds) };
}

// Reads the runner's state file once the helper has exited. The sandbox is the
// source of truth from then on. A failed run stops its sandbox, so it stops costing money.
export async function refreshFromSandbox(record: HandoffRecord): Promise<{ record: HandoffRecord; lines: string[] }> {
  const provider = sandboxes(record.sandboxProvider);
  const sandboxState = await provider.state(record.sandboxId!);
  const lines = [`Sandbox state: ${sandboxState}`];
  if (sandboxState !== "running") return { record, lines };

  const result = await provider.exec(
    record.sandboxId!,
    `bash -c 'cd "${remoteHome(record)}" 2>/dev/null && { cat state; echo @@; cat pr-url; echo @@; tail -n 30 runner.log; } 2>/dev/null'`,
    30,
  );
  const [remoteState = "", prUrl = "", remoteLog = ""] = result.output.split("@@").map((part) => part.trim());
  const failed = remoteState.startsWith("failed:");
  const sshExpired = !record.ssh || (record.ssh.expiresAt !== undefined && Date.parse(record.ssh.expiresAt) < Date.now());
  const ssh = sshExpired && provider.sshAccess && !failed ? await provider.sshAccess(record.sandboxId!, record.remoteDir!) : record.ssh;
  const updated = updateRecord(record.id, (r) => {
    if (remoteState === "completed" && r.state !== "completed") {
      r.state = "completed";
      appendLog(r, "Remote agent finished and pushed the result branch.");
    } else if (remoteState === "running" && r.state !== "running") {
      r.state = "running";
    } else if (failed) {
      r.state = "failed";
      r.failedStep = `remote_${remoteState.slice("failed:".length)}`;
      r.error = "The remote runner failed. See the remote log.";
    }
    if (prUrl) r.prUrl = prUrl;
    r.ssh = ssh;
  });
  if (remoteLog) lines.push("Remote log:", (await readableLog(record))(`${remoteLog}\n`).trimEnd());
  if (failed) {
    await provider.stop(record.sandboxId!);
    lines.push("Stopped the sandbox because the run failed. The pushed branch keeps any partial work.");
  }
  return { record: updated, lines };
}

// The agent's work since the handoff: commits, changed files, and optionally the
// full diff. Diffs compare the working tree, so uncommitted edits count too.
export async function remoteWork(record: HandoffRecord, fullDiff: boolean): Promise<string> {
  const base = shellQuote(record.snapshotCommit ?? `origin/${record.snapshotBranch}`);
  const script = [
    `cd ${shellQuote(record.remoteDir!)}`,
    `echo "Commits since the handoff:"`,
    `git log --oneline ${base}..HEAD`,
    `echo; echo "Changed files, committed or not:"`,
    `git diff --stat ${base}`,
    `untracked="$(git ls-files --others --exclude-standard)"`,
    `if [ -n "$untracked" ]; then echo; echo "New untracked files:"; echo "$untracked"; fi`,
    ...(fullDiff ? [`echo; git diff ${base}`] : []),
  ].join(" && ");
  const { result } = await remoteRun(record, script, 60);
  return result.output.trimEnd();
}

interface TranscriptItem {
  kind: "text" | "tool" | "note";
  text?: string;
  id?: string;
  icon?: string;
  title?: string;
  meta?: string;
  state?: string;
  output?: string;
}

const TOOL_LABELS: Record<string, string> = { run: "$", read: "read", edit: "edit", search: "search", web: "web", agent: "agent", plan: "plan", tool: "tool" };

// Turns the remote log into plain lines as it arrives. The cloud agent writes JSON
// events; each becomes its text, or one line per tool call. Other lines pass through.
export async function readableLog(record: HandoffRecord): Promise<(chunk: string) => string> {
  // Shipped next to dist/ and shared with the watch page, which runs it in the sandbox.
  const { parseLine } = (await import(new URL("../remote/transcript.mjs", import.meta.url).href)) as {
    parseLine: (agent: string, line: string, workdir?: string) => TranscriptItem[] | undefined;
  };
  const shown = new Set<string>();
  let partial = "";
  const toolLines = (item: TranscriptItem): string[] => {
    const lines: string[] = [];
    if (item.title !== undefined && !shown.has(item.id!)) {
      shown.add(item.id!);
      lines.push(`  ${TOOL_LABELS[item.icon ?? "tool"] ?? item.icon} ${item.title}${item.meta ? `  ${item.meta}` : ""}`);
    }
    if (item.state === "error") lines.push(`  failed${item.output ? `: ${item.output.split("\n").at(-1)}` : ""}`);
    return lines;
  };
  return (chunk) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    return lines
      .flatMap((line) => {
        const items = parseLine(record.targetAgent, line, record.remoteDir);
        if (!items) return [line];
        return items.flatMap((item) => (item.kind === "tool" ? toolLines(item) : [item.text ?? ""]));
      })
      .map((line) => `${line}\n`)
      .join("");
  };
}

// The remote log from a byte offset, plus the log's current size, so callers can follow it.
export async function remoteLog(record: HandoffRecord, fromByte?: number): Promise<{ text: string; size: number }> {
  const log = `${remoteHome(record)}/runner.log`;
  const read = fromByte === undefined ? `tail -n 40 ${shellQuote(log)}` : `tail -c +${fromByte + 1} ${shellQuote(log)}`;
  const { result } = await remoteRun(record, `wc -c < ${shellQuote(log)}; echo @@; ${read}`);
  const [size = "0", ...rest] = result.output.split("@@\n");
  return { size: Number(size.trim()) || 0, text: rest.join("@@\n") };
}

// Queues a message for the cloud agent. A running agent reads it when its current
// turn ends. A finished run is resumed in the same session to answer it.
export async function sendMessage(record: HandoffRecord, text: string): Promise<string> {
  const { provider, result } = await remoteRun(record, `cat ${shellQuote(`${remoteHome(record)}/state`)} 2>/dev/null`);
  const remoteState = result.output.trim();
  if (remoteState.startsWith("failed:") && remoteState !== "failed:agent") {
    throw new Error(`The handoff failed at ${remoteState.slice("failed:".length)} before the agent started. Start a new handoff.`);
  }
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  await provider.exec(record.sandboxId!, `mkdir -p ${shellQuote(`${remoteHome(record)}/inbox`)}`, 30);
  await provider.upload(record.sandboxId!, text, `${remoteHome(record)}/inbox/${name}`);

  if (remoteState === "running") {
    updateRecord(record.id, (r) => appendLog(r, "Queued a message for the cloud agent."));
    return `Queued. ${record.targetAgent} reads it when its current turn ends, and continues in the same session.`;
  }
  // Each background command needs its own name on providers that keep sessions.
  await provider.startBackground(record.sandboxId!, `agent-handoff-resume-${Date.now()}`, runnerCommand(record, "resume"));
  updateRecord(record.id, (r) => {
    r.state = "running";
    appendLog(r, "Resumed the cloud agent to answer a message.");
  });
  return `The run had finished, so ${record.targetAgent} resumed in the same session to answer it. The result branch and pull request update when it is done.`;
}

// Stops the helper if it is still working, then the sandbox. Pushed branches stay.
export async function stopHandoff(record: HandoffRecord): Promise<HandoffRecord> {
  if (record.helperPid) {
    try {
      process.kill(record.helperPid, "SIGTERM");
    } catch {
      // The helper already exited.
    }
  }
  if (record.sandboxId) {
    const provider = sandboxes(record.sandboxProvider);
    if ((await provider.state(record.sandboxId)) === "running") await provider.stop(record.sandboxId);
  }
  return updateRecord(record.id, (r) => {
    r.state = "stopped";
    appendLog(r, "Stopped.");
  });
}

// Makes the watch link public, and tells the watch page its own public address so
// it can point OpenCode pairing links at itself.
export async function publishWatchLink(record: HandoffRecord): Promise<HandoffRecord> {
  const provider = sandboxes(record.sandboxProvider);
  if (!provider.publicUrl || !record.sandboxId || !record.watchKey) return record;
  const watch = await provider.publicUrl(record.sandboxId, WATCH_PORT);
  await provider.upload(record.sandboxId, watch.url.replace(/\/$/, ""), `${remoteHome(record)}/watch-url`);
  return updateRecord(record.id, (r) => {
    r.watchUrl = `${watch.url.replace(/\/$/, "")}/?key=${r.watchKey}`;
    r.watchExpiresAt = watch.expiresAt;
  });
}

// The current watch link, renewed when it is close to expiring.
export async function watchLink(record: HandoffRecord): Promise<string | undefined> {
  const expiring = record.watchExpiresAt !== undefined && Date.parse(record.watchExpiresAt) - Date.now() < WATCH_RENEW_MS;
  if (record.watchUrl && !expiring) return record.watchUrl;
  if (!record.sandboxId || TERMINAL_STATES.has(record.state)) return record.watchUrl;
  return (await publishWatchLink(record)).watchUrl;
}

// A QR code drawn with half-block characters, for terminals and chat code blocks.
export function qrCode(text: string): string {
  return renderUnicodeCompact(text, { border: 1 });
}

// Current SSH details, renewed when they have expired.
export async function sshDetails(record: HandoffRecord): Promise<SshDetails> {
  const provider = sandboxes(record.sandboxProvider);
  if (!provider.sshAccess) throw new Error(`${record.sandboxProvider} sandboxes have no SSH access.`);
  if (!record.sandboxId || !record.remoteDir) throw new Error(`Handoff ${record.id} has no sandbox yet.`);
  const expired = !record.ssh || (record.ssh.expiresAt !== undefined && Date.parse(record.ssh.expiresAt) < Date.now());
  if (!expired) return record.ssh!;
  const ssh = await provider.sshAccess(record.sandboxId, record.remoteDir);
  updateRecord(record.id, (r) => {
    r.ssh = ssh;
  });
  return ssh;
}

// Where the sandbox's OpenCode server listens, its password, and the session the
// run uses. OpenCode keeps the address and password in its service state file.
export async function openCodeServer(
  record: HandoffRecord,
): Promise<{ port: number; password?: string; sessionId: string }> {
  if (record.targetAgent !== "opencode") {
    throw new Error(`attach needs OpenCode as the cloud agent. This handoff runs ${record.targetAgent}.`);
  }
  const { result } = await remoteRun(
    record,
    // The runner saves the session ID when the run ends. During the run, the
    // project's newest session is the one it is using.
    [
      `export PATH="$HOME/.opencode/bin:$PATH"`,
      `cat ${shellQuote(`${remoteHome(record)}/session-id`)} 2>/dev/null ||`,
      `(cd ${shellQuote(record.remoteDir!)} && opencode session list --format json --max-count 1 | grep -o 'ses_[A-Za-z0-9]*' | head -n 1)`,
      `; echo @@; cat "\${XDG_STATE_HOME:-$HOME/.local/state}/opencode/service.json" 2>/dev/null`,
    ].join(" "),
  );
  const [sessionId = "", serviceJson = ""] = result.output.split("@@").map((part) => part.trim());
  let service: { url?: string; password?: string } = {};
  try {
    service = JSON.parse(serviceJson) as typeof service;
  } catch {
    // Handled below: no service file means no running server.
  }
  const port = Number(/:(\d+)\/?$/.exec(service.url ?? "")?.[1]);
  if (!port) throw new Error("The OpenCode server in the sandbox is not running.");
  if (!sessionId) throw new Error("The cloud agent has not started its OpenCode session yet. Try again in a moment.");
  return { port, password: service.password, sessionId };
}
