import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HandoffBrief, HandoffRecord, LogEntry } from "./contract.js";

const MAX_LOG_ENTRIES = 200;

export function stateDir(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const dir = join(base, "agent-handoff");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function recordPath(id: string): string {
  return join(stateDir(), `${id}.json`);
}

export function helperLogPath(id: string): string {
  return join(stateDir(), `${id}.log`);
}

// handoff_start creates this file instead of editing the record, so the
// MCP server never races the helper's own record writes.
export function startSignalPath(id: string): string {
  return join(stateDir(), `${id}.start`);
}

export interface StartSignal {
  brief?: HandoffBrief; // replaces the prepared brief when the work moved on
  snapshotCommit?: string; // taken at call time when the session cannot be watched
}

export function readStartSignal(id: string): StartSignal | undefined {
  const path = startSignalPath(id);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as StartSignal) : undefined;
}

export function writeStartSignal(id: string, signal: StartSignal): void {
  writeFileSync(startSignalPath(id), JSON.stringify(signal), { mode: 0o600 });
}

export function readRecord(id: string): HandoffRecord {
  try {
    return JSON.parse(readFileSync(recordPath(id), "utf8")) as HandoffRecord;
  } catch (error) {
    throw new Error(`Unknown handoff ${id}.`, { cause: error });
  }
}

export function writeRecord(record: HandoffRecord): void {
  record.updatedAt = new Date().toISOString();
  record.log = record.log.slice(-MAX_LOG_ENTRIES);
  // Write then rename so the helper and the MCP server never read a partial file.
  const target = recordPath(record.id);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
  renameSync(temp, target);
}

export function updateRecord(id: string, change: (record: HandoffRecord) => void): HandoffRecord {
  const record = readRecord(id);
  change(record);
  writeRecord(record);
  return record;
}

export function appendLog(record: HandoffRecord, message: string): LogEntry {
  const entry = { at: new Date().toISOString(), message };
  record.log.push(entry);
  return entry;
}

export function listRecords(projectDir?: string): HandoffRecord[] {
  return readdirSync(stateDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(stateDir(), name), "utf8")) as HandoffRecord)
    .filter((record) => !projectDir || record.projectDir === projectDir)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
