import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { AgentAdapter, AgentCredentials, AgentSession } from "./agent.js";

const execFileAsync = promisify(execFile);

// OpenCode sends the invoking session in tool-call request metadata.
const SESSION_META_KEY = "ai.opencode/sessionID";
const IDLE_POLL_MS = 1000;

interface Credential {
  integrationID: string;
  active: boolean;
  value: { type: string; key?: string };
}

// The sandbox runner derives the same variable name with `tr`, so keep the rule simple.
export function keyEnvName(integrationId: string): string {
  return `HANDOFF_OC_KEY_${integrationId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

async function opencode(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("opencode", args, {
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

// `opencode api` authenticates against the local background service for us.
async function api<T>(operation: string, params: Record<string, string> = {}, body?: unknown): Promise<T> {
  const args = ["api", operation];
  for (const [key, value] of Object.entries(params)) args.push("--param", `${key}=${value}`);
  if (body !== undefined) args.push("--data", JSON.stringify(body));
  const output = await opencode(args);
  // Some operations, such as session.update, answer with an empty body.
  if (!output.trim()) return undefined as T;
  return (JSON.parse(output) as { data: T }).data;
}

export class OpenCodeAgent implements AgentAdapter {
  readonly name = "opencode";

  async version(): Promise<string> {
    const output = await opencode(["--version"]);
    const match = /\d+\.\d+\.\d+/.exec(output);
    if (!match) throw new Error(`Could not read the OpenCode version from "${output.trim()}".`);
    return match[0];
  }

  sessionIdFromMeta(meta: Record<string, unknown> | undefined): string | undefined {
    const value = meta?.[SESSION_META_KEY];
    return typeof value === "string" ? value : undefined;
  }

  async getSession(sessionId: string): Promise<AgentSession> {
    const info = await api<{ id: string; title?: string; location: { directory: string } }>("session.get", {
      sessionID: sessionId,
    });
    return { id: info.id, directory: info.location.directory, title: info.title };
  }

  async waitUntilIdle(sessionId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await api<Record<string, unknown>>("session.active");
      if (!(sessionId in active)) return;
      await sleep(IDLE_POLL_MS);
    }
    throw new Error(`Session ${sessionId} was still running after ${Math.round(timeoutMs / 60000)} minutes.`);
  }

  async exportSession(sessionId: string): Promise<string> {
    const output = await opencode(["session", "export", sessionId]);
    JSON.parse(output); // fail here, not in the sandbox, if the export is not JSON
    return output;
  }

  // Provider keys live in OpenCode's credential store, not in the environment.
  // Each API key becomes a sandbox variable that the runner registers remotely.
  async credentials(): Promise<AgentCredentials> {
    const credentials = await api<Credential[]>("credential.list");
    const env: Record<string, string> = {};
    const warnings: string[] = [];
    const integrations: string[] = [];
    for (const credential of credentials) {
      // MCP server sign-ins are local tool access, not model access.
      if (!credential.active || credential.integrationID.startsWith("mcp_")) continue;
      if (credential.value.type === "key" && credential.value.key) {
        env[keyEnvName(credential.integrationID)] = credential.value.key;
        integrations.push(credential.integrationID);
      } else {
        warnings.push(
          `OpenCode integration "${credential.integrationID}" uses ${credential.value.type} sign-in, which is not transferred. Sign in inside the sandbox if the remote session needs it.`,
        );
      }
    }
    if (integrations.length === 0) {
      warnings.push("No OpenCode API keys were found. The remote session may have no model access.");
    }
    env.HANDOFF_OC_INTEGRATIONS = integrations.join(" ");
    return { env, warnings };
  }

  async markHandedOff(sessionId: string, handoffId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    const title = `[cloud ${handoffId}] ${session.title ?? ""}`.trim();
    await api("session.update", { sessionID: sessionId }, { title });
  }
}
