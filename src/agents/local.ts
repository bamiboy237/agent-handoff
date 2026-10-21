import { OpenCodeAgent } from "./opencode.js";

// Session operations, available only when the calling agent identifies
// its session to the tool. Without them, the handoff relies on the brief.
export interface LocalSession {
  directory(sessionId: string): Promise<string>;
  waitUntilIdle(sessionId: string, timeoutMs: number): Promise<void>;
  exportSession(sessionId: string): Promise<string>;
  markHandedOff(sessionId: string, handoffId: string): Promise<void>;
}

// The agent on the user's machine that called the handoff tools.
export interface LocalAgent {
  readonly name: string;
  sessionIdFromMeta(meta: Record<string, unknown> | undefined): string | undefined;
  readonly session?: LocalSession;
}

const SESSION_AWARE_AGENTS: LocalAgent[] = [new OpenCodeAgent()];

// MCP clients report their name during initialization. These patterns map
// the names we have seen to agent names; anything else keeps its own name.
const CLIENT_NAME_PATTERNS: [RegExp, string][] = [
  [/opencode/i, "opencode"],
  [/claude/i, "claude"],
  [/codex/i, "codex"],
  [/prime/i, "prime-agent"],
  [/^pi(\b|-|$)/i, "pi"],
  [/zed/i, "zed"],
];

function agentNameFromClient(clientName: string | undefined): string {
  if (!clientName) return "unknown";
  return CLIENT_NAME_PATTERNS.find(([pattern]) => pattern.test(clientName))?.[1] ?? clientName;
}

// The helper runs in its own process and finds the agent again by name.
export function localAgentByName(name: string): LocalAgent {
  return (
    SESSION_AWARE_AGENTS.find((agent) => agent.name === name) ?? { name, sessionIdFromMeta: () => undefined }
  );
}

export function detectLocalAgent(
  meta: Record<string, unknown> | undefined,
  clientName: string | undefined,
): LocalAgent {
  const sessionAware = SESSION_AWARE_AGENTS.find((agent) => agent.sessionIdFromMeta(meta));
  if (sessionAware) return sessionAware;
  return { name: agentNameFromClient(clientName), sessionIdFromMeta: () => undefined };
}
