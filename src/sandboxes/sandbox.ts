import type { Env } from "../agents/remote.js";
import type { HandoffConfig } from "../config.js";
import type { ProviderCapabilities, SshDetails } from "../contract.js";
import { DaytonaSandboxes } from "./daytona.js";
import { E2bSandboxes } from "./e2b.js";
import { PrimeSandboxes } from "./prime.js";
import { SshHostSandboxes } from "./ssh.js";
import { VercelSandboxes } from "./vercel.js";

export interface CreateSandboxOptions {
  handoffId: string;
  cacheSnapshot?: string; // used only when the provider supports a cache
  env: Record<string, string>;
  labels: Record<string, string>;
}

export interface CreatedSandbox {
  id: string;
  cacheHit: boolean;
  root: string; // directory that holds .agent-handoff/ and workspace/
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

export interface Heartbeat {
  url: string;
  headers: Record<string, string>;
}

// "running" and "stopped" are normalized; other provider states pass through.
export type SandboxState = "running" | "stopped" | (string & {});

// Everything the handoff needs from a remote machine provider. Optional
// operations exist only when the matching capability is set.
export interface SandboxAdapter {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  preflight(): string | undefined;
  create(options: CreateSandboxOptions): Promise<CreatedSandbox>;
  exec(sandboxId: string, command: string, timeoutSeconds: number): Promise<ExecResult>;
  upload(sandboxId: string, content: string, remotePath: string): Promise<void>;
  // Starts a process that keeps running after this client disconnects.
  startBackground(sandboxId: string, name: string, command: string): Promise<void>;
  saveCache?(sandboxId: string, name: string): Promise<void>;
  // A URL that resets the idle auto-stop timer when requested.
  heartbeat?(sandboxId: string, port: number): Promise<Heartbeat>;
  sshAccess?(sandboxId: string, remoteDir: string): Promise<SshDetails>;
  state(sandboxId: string): Promise<SandboxState>;
  stop(sandboxId: string): Promise<void>;
  remove(sandboxId: string): Promise<void>;
}

export const PROVIDER_NAMES = ["daytona", "ssh", "e2b", "vercel", "prime"];

export function sandboxAdapter(config: HandoffConfig, env: Env): SandboxAdapter {
  switch (config.provider) {
    case "daytona":
      return new DaytonaSandboxes(env);
    case "ssh":
      return new SshHostSandboxes(config.ssh);
    case "e2b":
      return new E2bSandboxes(env);
    case "vercel":
      return new VercelSandboxes(env);
    case "prime":
      return new PrimeSandboxes(env);
    default:
      throw new Error(`Unsupported sandbox provider ${config.provider}. Choose one of: ${PROVIDER_NAMES.join(", ")}.`);
  }
}
