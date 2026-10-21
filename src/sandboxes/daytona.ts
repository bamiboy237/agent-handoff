import { Daytona, type Sandbox } from "@daytonaio/sdk";
import type { SshDetails } from "../contract.js";
import type { CreateSandboxOptions, CreatedSandbox, ExecResult, Heartbeat, SandboxAdapter } from "./sandbox.js";

const CREATE_TIMEOUT_SECONDS = 300;
const SNAPSHOT_TIMEOUT_SECONDS = 900;

export class DaytonaSandboxes implements SandboxAdapter {
  readonly name = "daytona";
  private client?: Daytona;

  preflight(): string | undefined {
    if (process.env.DAYTONA_API_KEY || process.env.DAYTONA_JWT_TOKEN) return undefined;
    return "DAYTONA_API_KEY is not set in the environment of the agent-handoff MCP server.";
  }

  // The SDK reads DAYTONA_API_KEY, DAYTONA_API_URL, and DAYTONA_TARGET from the environment.
  private daytona(): Daytona {
    this.client ??= new Daytona();
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
    const cacheHit = await this.snapshotIsActive(options.cacheSnapshot);
    const sandbox = await this.daytona().create(
      {
        ...(cacheHit ? { snapshot: options.cacheSnapshot } : {}),
        envVars: options.env,
        labels: options.labels,
        autoStopInterval: options.autoStopMinutes,
      },
      { timeout: CREATE_TIMEOUT_SECONDS },
    );
    const homeDir = (await sandbox.getUserHomeDir()) ?? "/home/daytona";
    return { id: sandbox.id, cacheHit, homeDir };
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

  async sshAccess(sandboxId: string, remoteDir: string, minutes: number): Promise<SshDetails> {
    const sandbox = await this.get(sandboxId);
    const access = await sandbox.createSshAccess(minutes);
    const match = /ssh\s+(?:-p\s+(\d+)\s+)?(\S+@\S+)/.exec(access.sshCommand);
    if (!match) throw new Error(`Unexpected Daytona SSH command "${access.sshCommand}".`);
    const port = match[1] ? `:${match[1]}` : "";
    return {
      command: access.sshCommand,
      zedCommand: `zed ssh://${match[2]}${port}${remoteDir}`,
      expiresAt: new Date(access.expiresAt).toISOString(),
    };
  }

  async state(sandboxId: string): Promise<string> {
    const sandbox = await this.get(sandboxId);
    return sandbox.state ?? "unknown";
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
