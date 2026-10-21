import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env, RemoteAgent } from "./agents/remote.js";

// Later files override earlier ones, matching common dotenv tooling.
const DOTENV_FILES = [".env", ".env.local"];
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SandboxEnv {
  env: Record<string, string>;
  warnings: string[];
}

export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!ENV_KEY.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values[key] = value;
  }
  return values;
}

// Fine-grained tokens see only the repositories they were granted, and GitHub
// answers 404 for the rest. Catch that here instead of at clone time in the sandbox.
async function checkGithubAccess(token: string, githubRepo: string): Promise<string | undefined> {
  const response = await fetch(`https://api.github.com/repos/${githubRepo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (response.ok) return undefined;
  return `GITHUB_TOKEN cannot access ${githubRepo} (GitHub returned ${response.status}). Grant the token access to this repository with read and write permission for contents and pull requests.`;
}

// Collects every value the sandbox receives as an environment variable.
// The values are passed to the sandbox provider only. They are never
// written to the handoff record, the snapshot commit, or the session export.
export async function collectSandboxEnv(
  projectDir: string,
  agent: RemoteAgent,
  localEnv: Env,
  githubRepo?: string,
): Promise<SandboxEnv> {
  const warnings: string[] = [];
  const env: Record<string, string> = {};

  for (const name of DOTENV_FILES) {
    const path = join(projectDir, name);
    if (existsSync(path)) Object.assign(env, parseDotenv(readFileSync(path, "utf8")));
  }

  // Model keys may live in the agent-handoff secrets file or in the project's .env.
  const agentCredentials = await agent.credentials({ ...localEnv, ...env });
  Object.assign(env, agentCredentials.env);
  warnings.push(...agentCredentials.warnings);

  const githubToken = localEnv.GITHUB_TOKEN || env.GITHUB_TOKEN;
  if (githubToken) {
    env.GITHUB_TOKEN = githubToken;
    if (githubRepo) {
      // A rejected token always breaks the clone and push, so refuse instead of warning.
      const problem = await checkGithubAccess(githubToken, githubRepo);
      if (problem) throw new Error(problem);
    }
  } else {
    warnings.push(
      "GITHUB_TOKEN is not set in the agent-handoff secrets file, the server environment, or the project .env. The sandbox cannot clone a private repository, push the result branch, or open the draft pull request.",
    );
  }

  return { env, warnings };
}
