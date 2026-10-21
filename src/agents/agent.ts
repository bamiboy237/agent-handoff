import { OpenCodeAgent } from "./opencode.js";

export interface AgentSession {
  id: string;
  directory: string;
  title?: string;
}

export interface AgentCredentials {
  env: Record<string, string>;
  warnings: string[];
}

// Everything the handoff needs from a coding agent on the local machine.
// The remote half of each agent lives in remote/runner.sh.
export interface AgentAdapter {
  readonly name: string;
  version(): Promise<string>;
  sessionIdFromMeta(meta: Record<string, unknown> | undefined): string | undefined;
  getSession(sessionId: string): Promise<AgentSession>;
  waitUntilIdle(sessionId: string, timeoutMs: number): Promise<void>;
  exportSession(sessionId: string): Promise<string>;
  credentials(): Promise<AgentCredentials>;
  markHandedOff(sessionId: string, handoffId: string): Promise<void>;
}

export function agentAdapter(name: string): AgentAdapter {
  if (name === "opencode") return new OpenCodeAgent();
  throw new Error(`Unsupported agent ${name}.`);
}
