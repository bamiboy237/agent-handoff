import { spawn } from "node:child_process";
import type { SshHostConfig } from "../config.js";
import type { ProviderCapabilities, SshDetails } from "../contract.js";
import type { CreateSandboxOptions, CreatedSandbox, ExecResult, SandboxAdapter, SandboxState } from "./sandbox.js";

const CONNECT_TIMEOUT_SECONDS = 15;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// The user's own machine over SSH. Each handoff gets its own directory, which
// doubles as the sandbox ID so any process can find it again. Secrets cannot be
// set as environment variables here, so they go into a 0600 file the runner sources.
export class SshHostSandboxes implements SandboxAdapter {
  readonly name = "ssh";
  readonly capabilities: ProviderCapabilities = { ssh: true, cache: false, keepAlive: "none" };

  constructor(private readonly config: SshHostConfig | undefined) {}

  preflight(): string | undefined {
    if (this.config?.host) return undefined;
    return "No SSH host is configured. Run `agent-handoff setup` or set AGENT_HANDOFF_SSH_HOST to user@host.";
  }

  private sshArgs(): string[] {
    const { host, port } = this.config!;
    return [
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
      ...(port ? ["-p", String(port)] : []),
      host,
    ];
  }

  private run(remoteCommand: string, timeoutSeconds: number, input?: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("ssh", [...this.sshArgs(), remoteCommand], { timeout: timeoutSeconds * 1000 });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (signal) output += `\nssh was stopped by ${signal}`;
        resolve({ exitCode: code ?? 1, output });
      });
      child.stdin.end(input ?? "");
    });
  }

  private async runOrThrow(remoteCommand: string, timeoutSeconds: number, input?: string): Promise<string> {
    const result = await this.run(remoteCommand, timeoutSeconds, input);
    if (result.exitCode !== 0) throw new Error(`ssh ${this.config!.host} failed: ${result.output.trim()}`);
    return result.output;
  }

  async create(options: CreateSandboxOptions): Promise<CreatedSandbox> {
    const home = (await this.runOrThrow('printf %s "$HOME"', 30)).trim();
    const root = `${home}/agent-handoff/${options.handoffId}`;
    const secrets = Object.entries(options.env)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join("\n");
    await this.upload(root, `${secrets}\n`, `${root}/.agent-handoff/secrets.env`);
    return { id: root, cacheHit: false, root };
  }

  exec(root: string, command: string, timeoutSeconds: number): Promise<ExecResult> {
    return this.run(command, timeoutSeconds);
  }

  async upload(_root: string, content: string, remotePath: string): Promise<void> {
    const dir = remotePath.slice(0, remotePath.lastIndexOf("/"));
    await this.runOrThrow(`umask 077 && mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(remotePath)}`, 60, content);
  }

  // setsid detaches the process from the SSH session so it survives disconnect.
  async startBackground(root: string, name: string, command: string): Promise<void> {
    const dir = `${root}/.agent-handoff`;
    const launch = `if command -v setsid >/dev/null; then setsid nohup bash -c ${shellQuote(command)}; else nohup bash -c ${shellQuote(command)}; fi`;
    await this.runOrThrow(
      `cd ${shellQuote(root)} && (${launch}) > ${shellQuote(`${dir}/${name}.out`)} 2>&1 < /dev/null & echo $! > ${shellQuote(`${dir}/${name}.pid`)}`,
      30,
    );
  }

  async sshAccess(_root: string, remoteDir: string): Promise<SshDetails> {
    const { host, port } = this.config!;
    return {
      command: `ssh ${port ? `-p ${port} ` : ""}${host}`,
      uri: `ssh://${host}${port ? `:${port}` : ""}${remoteDir}`,
    };
  }

  async state(root: string): Promise<SandboxState> {
    const result = await this.run(`test -d ${shellQuote(root)}`, 30);
    return result.exitCode === 0 ? "running" : "missing";
  }

  async stop(root: string): Promise<void> {
    const pidFile = `${root}/.agent-handoff/agent-handoff.pid`;
    // The background job leads its own process group when setsid exists.
    await this.run(
      `test -f ${shellQuote(pidFile)} && { pid=$(cat ${shellQuote(pidFile)}); kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; }; true`,
      30,
    );
  }

  async remove(root: string): Promise<void> {
    await this.stop(root);
    await this.runOrThrow(`rm -rf ${shellQuote(root)}`, 60);
  }
}
