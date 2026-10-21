import { CommandExitError, Sandbox } from "e2b";
import type { Env } from "../agents/remote.js";
import type { ProviderCapabilities } from "../contract.js";
import type { CreateSandboxOptions, CreatedSandbox, ExecResult, SandboxAdapter, SandboxState } from "./sandbox.js";

// Hobby sandboxes run at most 1 hour, Pro at most 24. Raise this on Pro.
const DEFAULT_LIFETIME_MINUTES = 60;

export class E2bSandboxes implements SandboxAdapter {
  readonly name = "e2b";
  readonly capabilities: ProviderCapabilities;
  private readonly lifetimeMinutes: number;

  constructor(private readonly env: Env) {
    this.lifetimeMinutes = Number(env.AGENT_HANDOFF_E2B_LIFETIME_MINUTES) || DEFAULT_LIFETIME_MINUTES;
    // No SSH without a custom template, so only the run-and-pull-request flow.
    this.capabilities = { ssh: false, cache: true, keepAlive: "none", maxLifetimeMinutes: this.lifetimeMinutes };
  }

  preflight(): string | undefined {
    if (this.env.E2B_API_KEY) return undefined;
    return "E2B_API_KEY is not set. Run `agent-handoff setup` or add it to the agent-handoff secrets file.";
  }

  private connect(sandboxId: string): Promise<Sandbox> {
    return Sandbox.connect(sandboxId, { apiKey: this.env.E2B_API_KEY });
  }

  async create(options: CreateSandboxOptions): Promise<CreatedSandbox> {
    const opts = {
      apiKey: this.env.E2B_API_KEY,
      envs: options.env,
      metadata: options.labels,
      timeoutMs: this.lifetimeMinutes * 60_000,
      // Pausing at the time limit keeps files and processes for a later resume.
      lifecycle: { onTimeout: "pause" as const },
    };
    let sandbox: Sandbox;
    let cacheHit = false;
    try {
      if (!options.cacheSnapshot) throw new Error("no cache");
      sandbox = await Sandbox.create(options.cacheSnapshot, opts);
      cacheHit = true;
    } catch {
      // No cached snapshot yet; any credential problem fails again below.
      sandbox = await Sandbox.create(opts);
    }
    const home = (await sandbox.commands.run('printf %s "$HOME"')).stdout.trim() || "/home/user";
    return { id: sandbox.sandboxId, cacheHit, root: home };
  }

  async exec(sandboxId: string, command: string, timeoutSeconds: number): Promise<ExecResult> {
    const sandbox = await this.connect(sandboxId);
    try {
      const result = await sandbox.commands.run(command, { timeoutMs: timeoutSeconds * 1000 });
      return { exitCode: result.exitCode, output: result.stdout + result.stderr };
    } catch (error) {
      // E2B throws on a non-zero exit instead of returning it.
      if (error instanceof CommandExitError) return { exitCode: error.exitCode, output: error.stdout + error.stderr };
      throw error;
    }
  }

  async upload(sandboxId: string, content: string, remotePath: string): Promise<void> {
    const sandbox = await this.connect(sandboxId);
    await sandbox.files.write(remotePath, content);
  }

  // timeoutMs 0 removes the per-command limit; the default 60 seconds kills background jobs too.
  async startBackground(sandboxId: string, _name: string, command: string): Promise<void> {
    const sandbox = await this.connect(sandboxId);
    await sandbox.commands.run(command, { background: true, timeoutMs: 0 });
  }

  async saveCache(sandboxId: string, name: string): Promise<void> {
    await Sandbox.createSnapshot(sandboxId, { apiKey: this.env.E2B_API_KEY, name });
  }

  async state(sandboxId: string): Promise<SandboxState> {
    try {
      const info = await Sandbox.getInfo(sandboxId, { apiKey: this.env.E2B_API_KEY });
      return info.state === "paused" ? "stopped" : info.state;
    } catch {
      return "missing";
    }
  }

  async stop(sandboxId: string): Promise<void> {
    await Sandbox.pause(sandboxId, { apiKey: this.env.E2B_API_KEY });
  }

  async remove(sandboxId: string): Promise<void> {
    await Sandbox.kill(sandboxId, { apiKey: this.env.E2B_API_KEY });
  }
}
