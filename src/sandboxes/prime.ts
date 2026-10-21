import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Env } from "../agents/remote.js";
import type { ProviderCapabilities, SshDetails } from "../contract.js";
import { stateDir } from "../store.js";
import type { CreateSandboxOptions, CreatedSandbox, ExecResult, SandboxAdapter, SandboxState } from "./sandbox.js";

const execFileAsync = promisify(execFile);

const BRIDGE = fileURLToPath(new URL("../../bridges/prime.py", import.meta.url));
const SDK_PACKAGE = "prime-sandboxes==0.5.0";
// The image needs git, curl, and Node for the npm-installed agents.
const DEFAULT_IMAGE = "node:22-bookworm";
// Prime's idle timeout counts only API calls, not a running agent, so cap the lifetime instead.
const DEFAULT_LIFETIME_MINUTES = 240;
const SSH_TTL_SECONDS = 24 * 60 * 60;
const PUBLIC_KEYS = ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"];

// Prime checkpoints have IDs, not names, so the cache key maps to an ID locally.
const cacheIndexPath = () => join(stateDir(), "prime-cache.json");

function readCacheIndex(): Record<string, string> {
  return existsSync(cacheIndexPath()) ? (JSON.parse(readFileSync(cacheIndexPath(), "utf8")) as Record<string, string>) : {};
}

export class PrimeSandboxes implements SandboxAdapter {
  readonly name = "prime";
  readonly capabilities: ProviderCapabilities;
  private readonly lifetimeMinutes: number;

  constructor(private readonly env: Env) {
    this.lifetimeMinutes = Number(env.AGENT_HANDOFF_PRIME_LIFETIME_MINUTES) || DEFAULT_LIFETIME_MINUTES;
    this.capabilities = { ssh: true, cache: true, keepAlive: "none", maxLifetimeMinutes: this.lifetimeMinutes };
  }

  preflight(): string | undefined {
    if (!this.env.PRIME_API_KEY) {
      return "PRIME_API_KEY is not set. Run `agent-handoff setup` or add it to the agent-handoff secrets file.";
    }
    return undefined;
  }

  // The SDK is Python only. uv fetches a pinned copy on first use.
  private async bridge<T>(operation: string, args: Record<string, unknown>): Promise<T> {
    const child = execFileAsync(
      "uv",
      ["run", "--no-project", "--quiet", "--with", SDK_PACKAGE, "python", BRIDGE, operation],
      { env: { ...process.env, PRIME_API_KEY: this.env.PRIME_API_KEY }, maxBuffer: 64 * 1024 * 1024 },
    );
    child.child.stdin?.end(JSON.stringify(args));
    try {
      return JSON.parse((await child).stdout) as T;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(`Prime ${operation} failed${stderr ? `: ${stderr.split("\n").slice(-3).join(" ")}` : ""}`, {
        cause: error,
      });
    }
  }

  async create(options: CreateSandboxOptions): Promise<CreatedSandbox> {
    const checkpointId = options.cacheSnapshot ? readCacheIndex()[options.cacheSnapshot] : undefined;
    const request = {
      name: `agent-handoff-${options.handoffId}`,
      image: this.env.AGENT_HANDOFF_PRIME_IMAGE || DEFAULT_IMAGE,
      cpuCores: 2,
      memoryGb: 4,
      timeoutMinutes: this.lifetimeMinutes,
      env: options.env,
      labels: Object.entries(options.labels).map(([key, value]) => `${key}=${value}`),
    };
    let created: { id: string };
    let cacheHit = false;
    try {
      if (!checkpointId) throw new Error("no cache");
      created = await this.bridge("create", { ...request, checkpointId });
      cacheHit = true;
    } catch {
      // The checkpoint is missing or expired; any credential problem fails again below.
      created = await this.bridge("create", request);
    }
    const home = await this.exec(created.id, 'printf %s "$HOME"', 30);
    return { id: created.id, cacheHit, root: home.output.trim() || "/root" };
  }

  exec(sandboxId: string, command: string, timeoutSeconds: number): Promise<ExecResult> {
    return this.bridge<ExecResult>("exec", { id: sandboxId, command, timeout: timeoutSeconds });
  }

  async upload(sandboxId: string, content: string, remotePath: string): Promise<void> {
    await this.bridge("upload", { id: sandboxId, path: remotePath, content });
  }

  async startBackground(sandboxId: string, _name: string, command: string): Promise<void> {
    await this.bridge("background", { id: sandboxId, command });
  }

  async saveCache(sandboxId: string, name: string): Promise<void> {
    const { checkpointId } = await this.bridge<{ checkpointId: string }>("checkpoint", { id: sandboxId });
    writeFileSync(cacheIndexPath(), JSON.stringify({ ...readCacheIndex(), [name]: checkpointId }, null, 2));
  }

  // The SSH gateway routes by session ID, which is also the username. The
  // user's own public key authorizes the session, so their normal ssh works.
  async sshAccess(sandboxId: string, remoteDir: string): Promise<SshDetails> {
    const keyFile = PUBLIC_KEYS.map((name) => join(homedir(), ".ssh", name)).find(existsSync);
    if (!keyFile) throw new Error("No SSH public key found in ~/.ssh for Prime SSH access.");
    const session = await this.bridge<{ user: string; host: string; port: number; expiresAt: string }>("ssh", {
      id: sandboxId,
      publicKey: readFileSync(keyFile, "utf8").trim(),
      ttlSeconds: SSH_TTL_SECONDS,
    });
    return {
      command: `ssh -p ${session.port} ${session.user}@${session.host}`,
      uri: `ssh://${session.user}@${session.host}:${session.port}${remoteDir}`,
      expiresAt: session.expiresAt,
    };
  }

  async state(sandboxId: string): Promise<SandboxState> {
    try {
      const { status } = await this.bridge<{ status: string }>("status", { id: sandboxId });
      const normalized = status.toLowerCase().replace(/^sandboxstatus\./, "");
      return normalized === "running" ? "running" : normalized;
    } catch {
      return "missing";
    }
  }

  // Prime has no stop or pause, only delete. Pushed branches keep the work.
  async stop(sandboxId: string): Promise<void> {
    await this.bridge("delete", { id: sandboxId });
  }

  async remove(sandboxId: string): Promise<void> {
    await this.bridge("delete", { id: sandboxId });
  }
}
