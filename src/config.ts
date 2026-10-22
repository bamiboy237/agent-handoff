import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "./agents/remote.js";
import { parseDotenv } from "./credentials.js";

export interface SshHostConfig {
  host: string; // user@host, or an alias from ~/.ssh/config
  port?: number;
}

export interface HandoffConfig {
  provider: string;
  targetAgent?: string; // default remote agent; otherwise the calling agent
  targetModel?: string; // default model for the remote agent; otherwise the agent's own default
  ssh?: SshHostConfig;
}

export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-handoff");
}

const configPath = () => join(configDir(), "config.json");
export const secretsPath = () => join(configDir(), ".env");

// Environment variables override the file, so one-off runs need no setup.
export function loadConfig(): HandoffConfig {
  const file: Partial<HandoffConfig> = existsSync(configPath())
    ? (JSON.parse(readFileSync(configPath(), "utf8")) as Partial<HandoffConfig>)
    : {};
  const sshHost = process.env.AGENT_HANDOFF_SSH_HOST;
  return {
    provider: process.env.AGENT_HANDOFF_PROVIDER || file.provider || "daytona",
    targetAgent: process.env.AGENT_HANDOFF_TARGET_AGENT || file.targetAgent,
    targetModel: process.env.AGENT_HANDOFF_TARGET_MODEL || file.targetModel,
    ssh: sshHost ? { host: sshHost } : file.ssh,
  };
}

export function saveConfig(config: HandoffConfig): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// Read on every call: the MCP server's own environment is fixed when the agent
// starts it, so a rotated key in the secrets file takes effect without a restart.
export function loadEnv(): Env {
  const secrets = existsSync(secretsPath()) ? parseDotenv(readFileSync(secretsPath(), "utf8")) : {};
  return { ...process.env, ...secrets };
}

export function saveSecrets(values: Record<string, string>): void {
  const existing = existsSync(secretsPath()) ? parseDotenv(readFileSync(secretsPath(), "utf8")) : {};
  const merged = { ...existing, ...values };
  const lines = Object.entries(merged).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(secretsPath(), `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(secretsPath(), 0o600);
}
