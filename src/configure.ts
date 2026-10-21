// `agent-handoff setup`: choose a sandbox provider, store keys, and register
// the MCP server with the agents installed on this machine.
import { execFile, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { REMOTE_AGENT_NAMES } from "./agents/remote.js";
import { type HandoffConfig, loadConfig, loadEnv, saveConfig, saveSecrets, secretsPath } from "./config.js";

const execFileAsync = promisify(execFile);
const SERVER_ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));
const SKILL_DIR = fileURLToPath(new URL("../skills/handoff", import.meta.url));
const HTTP_PORT = 7878;

interface ProviderChoice {
  name: string;
  summary: string;
  keys: string[];
}

const PROVIDERS: ProviderChoice[] = [
  { name: "daytona", summary: "Managed sandboxes with SSH and a reusable cache.", keys: ["DAYTONA_API_KEY"] },
  { name: "ssh", summary: "Your own machine over SSH. No account needed.", keys: [] },
  { name: "e2b", summary: "Managed sandboxes. Free tier: one-time credit, 1-hour runs, no SSH.", keys: ["E2B_API_KEY"] },
  {
    name: "vercel",
    summary: "Managed sandboxes. Hobby tier: 45-minute runs, no SSH.",
    keys: ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
  },
  { name: "prime", summary: "Prime Intellect sandboxes with SSH. Needs uv installed.", keys: ["PRIME_API_KEY"] },
];

const MODEL_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

interface AgentRegistration {
  binary: string;
  args: string[];
  skillDir?: string;
}

// Commands that add a stdio MCP server to each agent's user-level config.
const REGISTRATIONS: Record<string, AgentRegistration> = {
  opencode: {
    binary: "opencode",
    args: ["mcp", "add", "agent-handoff", "--", "node", SERVER_ENTRY],
    skillDir: join(homedir(), ".config", "opencode", "skills"),
  },
  claude: {
    binary: "claude",
    args: ["mcp", "add", "--scope", "user", "agent-handoff", "--", "node", SERVER_ENTRY],
    skillDir: join(homedir(), ".claude", "skills"),
  },
  codex: { binary: "codex", args: ["mcp", "add", "agent-handoff", "--", "node", SERVER_ENTRY] },
  pi: { binary: "pi", args: ["mcp", "add", "agent-handoff", "--", "node", SERVER_ENTRY] },
};

async function installed(binary: string): Promise<boolean> {
  try {
    await execFileAsync("which", [binary]);
    return true;
  } catch {
    return false;
  }
}

export async function runSetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, fallback = "") => (await rl.question(question)).trim() || fallback;
  const yes = async (question: string) => /^y/i.test(await ask(`${question} [y/N] `));
  // Keys are typed without echo. readline has no public option for this, so mute its writer.
  const askSecret = async (question: string) => {
    const writer = rl as unknown as { _writeToOutput: (text: string) => void };
    const original = writer._writeToOutput;
    process.stdout.write(question);
    writer._writeToOutput = () => {};
    try {
      return (await rl.question("")).trim();
    } finally {
      writer._writeToOutput = original;
      process.stdout.write("\n");
    }
  };

  try {
    const current = loadConfig();
    const env = loadEnv();
    const config: HandoffConfig = { ...current };
    const secrets: Record<string, string> = {};

    console.log("Sandbox providers:");
    PROVIDERS.forEach((provider, index) => console.log(`  ${index + 1}. ${provider.name}: ${provider.summary}`));
    const pick = await ask(`Choose a provider [${current.provider}]: `, current.provider);
    const provider = PROVIDERS[Number(pick) - 1] ?? PROVIDERS.find((choice) => choice.name === pick);
    if (!provider) throw new Error(`Unknown provider ${pick}.`);
    config.provider = provider.name;

    if (provider.name === "ssh") {
      const host = await ask(`SSH host (user@host) [${current.ssh?.host ?? ""}]: `, current.ssh?.host ?? "");
      if (!host) throw new Error("An SSH host is required.");
      config.ssh = { host };
      const check = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "command -v git && command -v node"], {
        encoding: "utf8",
      });
      console.log(
        check.status === 0
          ? "Connected. git and node are available."
          : "Could not confirm SSH access with git and node. Check key-based login and install git and Node.js on the host.",
      );
    }

    for (const key of [...provider.keys, "GITHUB_TOKEN"]) {
      if (env[key]) continue;
      const hint = key === "GITHUB_TOKEN" ? " (needs Contents and Pull requests read and write on your repos)" : "";
      const value = await askSecret(`${key}${hint}: `);
      if (value) secrets[key] = value;
    }

    console.log(`\nModel keys for the remote agent (Enter to skip). Already set: ${MODEL_KEYS.filter((k) => env[k]).join(", ") || "none"}.`);
    for (const key of MODEL_KEYS.filter((k) => !env[k])) {
      const value = await askSecret(`${key}: `);
      if (value) secrets[key] = value;
    }

    const target = await ask(
      `Default remote agent (${REMOTE_AGENT_NAMES.join(", ")}), or Enter to use the calling agent [${current.targetAgent ?? ""}]: `,
      current.targetAgent ?? "",
    );
    if (target && !REMOTE_AGENT_NAMES.includes(target)) throw new Error(`Unknown agent ${target}.`);
    config.targetAgent = target || undefined;

    saveConfig(config);
    if (Object.keys(secrets).length > 0) saveSecrets(secrets);
    console.log(`\nSaved the provider choice. Keys are in ${secretsPath()} (readable only by you).`);

    console.log("\nRegister the MCP server with your agents:");
    for (const [agent, registration] of Object.entries(REGISTRATIONS)) {
      if (!(await installed(registration.binary))) continue;
      if (!(await yes(`  Add agent-handoff to ${agent}?`))) continue;
      const result = spawnSync(registration.binary, registration.args, { stdio: "inherit" });
      if (result.status !== 0) console.log(`  ${agent} returned ${result.status}. Run it yourself: ${registration.binary} ${registration.args.join(" ")}`);
      if (registration.skillDir && existsSync(SKILL_DIR) && (await yes(`  Install the handoff skill for ${agent}?`))) {
        mkdirSync(registration.skillDir, { recursive: true });
        cpSync(SKILL_DIR, join(registration.skillDir, "handoff"), { recursive: true });
      }
    }
    if (await installed("prime-agent")) {
      console.log(
        `  Prime Agent connects by URL. Start \`agent-handoff --http ${HTTP_PORT}\`, then run:\n    prime-agent mcp add agent-handoff --url http://127.0.0.1:${HTTP_PORT}/mcp`,
      );
    }
    console.log("\nDone. Reload your agents so they pick up the server.");
  } finally {
    rl.close();
  }
}
