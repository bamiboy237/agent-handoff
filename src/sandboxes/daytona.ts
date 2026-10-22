import type { Daytona, Sandbox } from "@daytonaio/sdk";
import type { Env } from "../agents/remote.js";
import type { ProviderCapabilities, SshDetails } from "../contract.js";
import type {
  CreateSandboxOptions,
  CreatedSandbox,
  ExecResult,
  Heartbeat,
  PublicUrl,
  SandboxAdapter,
  SandboxState,
} from "./sandbox.js";

const CREATE_TIMEOUT_SECONDS = 300;
const SNAPSHOT_TIMEOUT_SECONDS = 900;
const AUTO_STOP_MINUTES = 30;
const SSH_MINUTES = 24 * 60;
// Daytona caps signed preview URLs at 24 hours; status checks renew them.
const PUBLIC_URL_SECONDS = 24 * 60 * 60;

export class DaytonaSandboxes implements SandboxAdapter {
  readonly name = "daytona";
  readonly capabilities: ProviderCapabilities = { ssh: true, cache: true, keepAlive: "heartbeat" };
  private client?: Promise<Daytona>;

  constructor(private readonly env: Env) {}

  preflight(): string | undefined {
    if (this.env.DAYTONA_API_KEY || this.env.DAYTONA_JWT_TOKEN) return undefined;
    return "DAYTONA_API_KEY is not set. Run `agent-handoff setup` or add it to the agent-handoff secrets file.";
  }

  // The SDK takes about 175 ms to load, so it loads on first use instead of each
  // time an agent starts the server.
  private daytona(): Promise<Daytona> {
    this.client ??= import("@daytonaio/sdk").then(
      ({ Daytona }) =>
        new Daytona({
          apiKey: this.env.DAYTONA_API_KEY,
          jwtToken: this.env.DAYTONA_JWT_TOKEN,
          organizationId: this.env.DAYTONA_ORGANIZATION_ID,
          apiUrl: this.env.DAYTONA_API_URL,
          target: this.env.DAYTONA_TARGET,
        }),
    );
    return this.client;
  }

  private async get(sandboxId: string): Promise<Sandbox> {
    return (await this.daytona()).get(sandboxId);
  }

  private async snapshotIsActive(name: string): Promise<boolean> {
    try {
      const snapshot = await (await this.daytona()).snapshot.get(name);
      return snapshot.state === "active";
    } catch {
      // Not found is the normal case for a first handoff. Any other problem
      // surfaces in create(), which uses the same credentials.
      return false;
    }
  }

  async create(options: CreateSandboxOptions): Promise<CreatedSandbox> {
    const cacheHit = options.cacheSnapshot ? await this.snapshotIsActive(options.cacheSnapshot) : false;
    const sandbox = await (await this.daytona()).create(
      {
        ...(cacheHit ? { snapshot: options.cacheSnapshot } : {}),
        envVars: options.env,
        labels: options.labels,
        autoStopInterval: AUTO_STOP_MINUTES,
      },
      { timeout: CREATE_TIMEOUT_SECONDS },
    );
    const root = (await sandbox.getUserHomeDir()) ?? "/home/daytona";
    return { id: sandbox.id, cacheHit, root };
  }

  async exec(sandboxId: string, command: string, timeoutSeconds: number): Promise<ExecResult> {
    const sandbox = await this.get(sandboxId);
    const response = await sandbox.process.executeCommand(command, undefined, undefined, timeoutSeconds);
    return { exitCode: response.exitCode, output: response.result };
  }

  async upload(sandboxId: string, content: string, remotePath: string): Promise<void> {
    const sandbox = await this.get(sandboxId);
    await sandbox.fs.uploadFile(Buffer.from(content), remotePath);
  }

  async startBackground(sandboxId: string, name: string, command: string): Promise<void> {
    const sandbox = await this.get(sandboxId);
    await sandbox.process.createSession(name);
    await sandbox.process.executeSessionCommand(name, { command, runAsync: true });
  }

  async saveCache(sandboxId: string, name: string): Promise<void> {
    const sandbox = await this.get(sandboxId);
    await sandbox.createSnapshot(name, SNAPSHOT_TIMEOUT_SECONDS);
  }

  // Daytona resets the auto-stop timer on preview requests, not on processes
  // running inside the sandbox, so the runner pings this URL while it works.
  async heartbeat(sandboxId: string, port: number): Promise<Heartbeat> {
    const sandbox = await this.get(sandboxId);
    const preview = await sandbox.getPreviewLink(port);
    return { url: preview.url, headers: { "X-Daytona-Preview-Token": preview.token } };
  }

  // A signed preview URL carries its token, so a phone browser can open it. Daytona
  // shows a one-time warning page before it, unless the organization turns that off.
  async publicUrl(sandboxId: string, port: number): Promise<PublicUrl> {
    const sandbox = await this.get(sandboxId);
    const signed = await sandbox.getSignedPreviewUrl(port, PUBLIC_URL_SECONDS);
    return { url: signed.url, expiresAt: new Date(Date.now() + PUBLIC_URL_SECONDS * 1000).toISOString() };
  }

  async sshAccess(sandboxId: string, remoteDir: string): Promise<SshDetails> {
    const sandbox = await this.get(sandboxId);
    const access = await sandbox.createSshAccess(SSH_MINUTES);
    const match = /ssh\s+(?:-p\s+(\d+)\s+)?(\S+@\S+)/.exec(access.sshCommand);
    if (!match) throw new Error(`Unexpected Daytona SSH command "${access.sshCommand}".`);
    const port = match[1] ? `:${match[1]}` : "";
    return {
      command: access.sshCommand,
      uri: `ssh://${match[2]}${port}${remoteDir}`,
      expiresAt: new Date(access.expiresAt).toISOString(),
    };
  }

  async state(sandboxId: string): Promise<SandboxState> {
    const state = (await this.get(sandboxId)).state ?? "unknown";
    return state === "started" ? "running" : state;
  }

  async stop(sandboxId: string): Promise<void> {
    const sandbox = await this.get(sandboxId);
    await sandbox.stop();
  }

  async remove(sandboxId: string): Promise<void> {
    const sandbox = await this.get(sandboxId);
    await sandbox.delete();
  }
}
