import { Sandbox } from "@vercel/sandbox";
import type { Env } from "../agents/remote.js";
import type { ProviderCapabilities } from "../contract.js";
import type { CreateSandboxOptions, CreatedSandbox, ExecResult, SandboxAdapter, SandboxState } from "./sandbox.js";

// Hobby sandboxes run at most 45 minutes, Pro at most 24 hours. Raise this on Pro.
const DEFAULT_LIFETIME_MINUTES = 45;

export class VercelSandboxes implements SandboxAdapter {
  readonly name = "vercel";
  readonly capabilities: ProviderCapabilities;
  private readonly lifetimeMinutes: number;

  constructor(private readonly env: Env) {
    this.lifetimeMinutes = Number(env.AGENT_HANDOFF_VERCEL_LIFETIME_MINUTES) || DEFAULT_LIFETIME_MINUTES;
    // `sandbox ssh` is an interactive shell, not an SSH server, and snapshot() stops
    // the sandbox, so neither SSH for editors nor a mid-run cache is offered.
    this.capabilities = { ssh: false, cache: false, keepAlive: "none", maxLifetimeMinutes: this.lifetimeMinutes };
  }

  preflight(): string | undefined {
    if (this.env.VERCEL_OIDC_TOKEN) return undefined;
    if (this.env.VERCEL_TOKEN && this.env.VERCEL_TEAM_ID && this.env.VERCEL_PROJECT_ID) return undefined;
    return "Vercel needs VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID, or VERCEL_OIDC_TOKEN. Run `agent-handoff setup`.";
  }

  // An access token needs the team and project; without one the SDK uses VERCEL_OIDC_TOKEN.
  private credentials() {
    const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = this.env;
    return token && teamId && projectId ? { token, teamId, projectId } : {};
  }

  private get(name: string): Promise<Sandbox> {
    return Sandbox.get({ name, ...this.credentials() });
  }

  async create(options: CreateSandboxOptions): Promise<CreatedSandbox> {
    const name = `agent-handoff-${options.handoffId}`;
    const sandbox = await Sandbox.create({
      name,
      env: options.env,
      tags: options.labels,
      timeout: this.lifetimeMinutes * 60_000,
      ...this.credentials(),
    });
    const home = await sandbox.runCommand("bash", ["-c", 'printf %s "$HOME"']);
    return { id: name, cacheHit: false, root: (await home.stdout()).trim() || "/home/vercel-sandbox" };
  }

  async exec(name: string, command: string, timeoutSeconds: number): Promise<ExecResult> {
    const sandbox = await this.get(name);
    const result = await sandbox.runCommand("bash", ["-c", command], { timeoutMs: timeoutSeconds * 1000 });
    return { exitCode: result.exitCode, output: await result.output("both") };
  }

  async upload(name: string, content: string, remotePath: string): Promise<void> {
    const sandbox = await this.get(name);
    await sandbox.writeFiles([{ path: remotePath, content }]);
  }

  async startBackground(name: string, _jobName: string, command: string): Promise<void> {
    const sandbox = await this.get(name);
    await sandbox.runCommand({ cmd: "bash", args: ["-c", command], detached: true });
  }

  async state(name: string): Promise<SandboxState> {
    try {
      return (await this.get(name)).status;
    } catch {
      return "missing";
    }
  }

  async stop(name: string): Promise<void> {
    await (await this.get(name)).stop();
  }

  async remove(name: string): Promise<void> {
    await (await this.get(name)).delete();
  }
}
