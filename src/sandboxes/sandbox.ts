import type { SshDetails } from "../contract.js";
import { DaytonaSandboxes } from "./daytona.js";

export interface CreateSandboxOptions {
  cacheSnapshot: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  autoStopMinutes: number;
}

export interface CreatedSandbox {
  id: string;
  cacheHit: boolean;
  homeDir: string;
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

export interface Heartbeat {
  url: string;
  headers: Record<string, string>;
}

// Everything the handoff needs from a remote machine provider.
export interface SandboxAdapter {
  readonly name: string;
  preflight(): string | undefined;
  create(options: CreateSandboxOptions): Promise<CreatedSandbox>;
  exec(sandboxId: string, command: string, timeoutSeconds: number): Promise<ExecResult>;
  upload(sandboxId: string, content: string, remotePath: string): Promise<void>;
  startBackground(sandboxId: string, name: string, command: string): Promise<void>;
  saveCache(sandboxId: string, name: string): Promise<void>;
  // A URL that resets the idle auto-stop timer when requested.
  heartbeat(sandboxId: string, port: number): Promise<Heartbeat>;
  sshAccess(sandboxId: string, remoteDir: string, minutes: number): Promise<SshDetails>;
  state(sandboxId: string): Promise<string>;
  stop(sandboxId: string): Promise<void>;
  remove(sandboxId: string): Promise<void>;
}

export function sandboxAdapter(name: string): SandboxAdapter {
  if (name === "daytona") return new DaytonaSandboxes();
  throw new Error(`Unsupported sandbox provider ${name}.`);
}
