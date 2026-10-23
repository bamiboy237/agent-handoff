import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { OpenCodeAgent } from "./opencode.js";

const execFileAsync = promisify(execFile);

export type Env = Record<string, string | undefined>;

export interface AgentCredentials {
  env: Record<string, string>;
  warnings: string[];
}

// The agent that continues the task in the sandbox. Its install and run
// commands live in remote/runner.sh under the same name.
export interface RemoteAgent {
  readonly name: string;
  // The version installed locally, pinned in the sandbox. Undefined installs the latest.
  localVersion(): Promise<string | undefined>;
  credentials(env: Env): Promise<AgentCredentials>;
  // The local agent whose exported session this agent can resume.
  readonly resumesSessionOf?: string;
}

async function installedVersion(binary: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { env: { ...process.env, NO_COLOR: "1" } });
    return /\d+\.\d+\.\d+/.exec(stdout)?.[0];
  } catch {
    return undefined; // not installed locally; the sandbox installs the latest
  }
}

function pick(env: Env, names: string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value) picked[name] = value;
  }
  return picked;
}

// Agents that read model keys from environment variables only.
function envKeyAgent(name: string, binary: string, keyNames: string[], missingHint: string): RemoteAgent {
  return {
    name,
    localVersion: () => installedVersion(binary),
    credentials: async (env) => {
      const picked = pick(env, keyNames);
      const warnings = Object.keys(picked).length > 0 ? [] : [missingHint];
      return { env: picked, warnings };
    },
  };
}

const claude = envKeyAgent(
  "claude",
  "claude",
  ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  "No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN found. Run `claude setup-token` for a subscription token, or set an API key.",
);

const pi = envKeyAgent(
  "pi",
  "pi",
  ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"],
  "No model API key found for Pi. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY.",
);

// Codex also runs on a ChatGPT login stored in auth.json. The runner writes
// the file into the sandbox; Codex refreshes it there.
const codex: RemoteAgent = {
  name: "codex",
  localVersion: () => installedVersion("codex"),
  credentials: async (env) => {
    // codex exec reads CODEX_API_KEY. OPENAI_API_KEY alone is not a login.
    const apiKey = env.CODEX_API_KEY || env.OPENAI_API_KEY;
    const picked: Record<string, string> = apiKey ? { CODEX_API_KEY: apiKey } : {};
    const authFile = join(env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
    if (Object.keys(picked).length === 0 && existsSync(authFile)) {
      picked.HANDOFF_CODEX_AUTH_JSON = readFileSync(authFile).toString("base64");
    }
    const warnings =
      Object.keys(picked).length > 0 ? [] : ["No CODEX_API_KEY, OPENAI_API_KEY, or ~/.codex/auth.json found for Codex."];
    return { env: picked, warnings };
  },
};

const REMOTE_AGENTS: Record<string, RemoteAgent> = {
  opencode: new OpenCodeAgent(),
  claude,
  codex,
  pi,
};

export const REMOTE_AGENT_NAMES = Object.keys(REMOTE_AGENTS);

export function remoteAgent(name: string): RemoteAgent {
  const agent = REMOTE_AGENTS[name];
  if (!agent) {
    throw new Error(`${name} cannot run in the sandbox yet. Choose one of: ${REMOTE_AGENT_NAMES.join(", ")}.`);
  }
  return agent;
}
