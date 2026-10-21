import { Daytona, type Sandbox } from "@daytonaio/sdk";
import type { Env } from "../agents/remote.js";
import type { ProviderCapabilities, SshDetails } from "../contract.js";
import type {
  CreateSandboxOptions,
  CreatedSandbox,
  ExecResult,
  Heartbeat,
  SandboxAdapter,
  SandboxState,
} from "./sandbox.js";

const CREATE_TIMEOUT_SECONDS = 300;
const SNAPSHOT_TIMEOUT_SECONDS = 900;
const AUTO_STOP_MINUTES = 30;
const SSH_MINUTES = 24 * 60;

export class DaytonaSandboxes implements SandboxAdapter {
  readonly name = "daytona";
  readonly capabilities: ProviderCapabilities = { ssh: true, cache: true, keepAlive: "heartbeat" };
  private client?: Daytona;

  constructor(private readonly env: Env) {}

  preflight(): string | undefined {
    if (this.env.DAYTONA_API_KEY || this.env.DAYTONA_JWT_TOKEN) return undefined;
    return "DAYTONA_API_KEY is not set. Run `agent-handoff setup` or add it to the agent-handoff secrets file.";
  }

  private daytona(): Daytona {
    this.client ??= new Daytona({
      apiKey: this.env.DAYTONA_API_KEY,
      jwtToken: this.env.DAYTONA_JWT_TOKEN,
      organizationId: this.env.DAYTONA_ORGANIZATION_ID,
      apiUrl: this.env.DAYTONA_API_URL,
      target: this.env.DAYTONA_TARGET,
    });
    return this.client;
  }

  private get(sandboxId: string): Promise<Sandbox> {
    return this.daytona().get(sandboxId);
  }

  private async snapshotIsActive(name: string): Promise<boolean> {
    try {
      const snapshot = await this.daytona().snapshot.get(name);
      return snapshot.state === "active";
    } catch {
      // Not found is the normal case for a first handoff. Any other problem
      // surfaces in create(), which uses the same credentials.
      return false;
    }
  }

  async create(options: CreateSandboxOptions): Promise<CreatedSandbox> {
    const cacheHit = options.cacheSnapshot ? await this.snapshotIsActive(options.cacheSnapshot) : false;
    const sandbox = await this.daytona().create(
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
