// `agent-handoff setup`: choose a sandbox provider, store keys, register the
// MCP server with the agents installed on this machine, and install the handoff
// skill. The prompts and flow follow `npx skills add` (vercel-labs/skills).
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, styleText } from "node:util";
import * as p from "@clack/prompts";
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

const SAME_AS_CALLER = "";

interface AgentRegistration {
  label: string;
  binary: string;
  // Undefined for agents that connect by URL instead of a stdio command.
  args?: string[];
  skills?: { global: string; project: string };
}

// Skills directories match the agent table in vercel-labs/skills (src/agents.ts).
// OpenCode, Codex, and Pi read the shared .agents/skills directory in a project.
const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");

// Commands that add a stdio MCP server to each agent's user-level config.
const REGISTRATIONS: Record<string, AgentRegistration> = {
  opencode: {
    label: "OpenCode",
    binary: "opencode",
    args: ["mcp", "add", "agent-handoff", "--", "node", SERVER_ENTRY],
    skills: { global: join(xdgConfigHome, "opencode", "skills"), project: join(".agents", "skills") },
  },
  claude: {
    label: "Claude Code",
    binary: "claude",
    args: ["mcp", "add", "--scope", "user", "agent-handoff", "--", "node", SERVER_ENTRY],
    skills: { global: join(claudeHome, "skills"), project: join(".claude", "skills") },
  },
  codex: {
    label: "Codex",
    binary: "codex",
    args: ["mcp", "add", "agent-handoff", "--", "node", SERVER_ENTRY],
    skills: { global: join(homedir(), ".agents", "skills"), project: join(".agents", "skills") },
  },
  pi: {
    label: "Pi",
    binary: "pi",
    args: ["mcp", "add", "agent-handoff", "--", "node", SERVER_ENTRY],
    skills: { global: join(homedir(), ".agents", "skills"), project: join(".agents", "skills") },
  },
  "prime-agent": { label: "Prime Agent", binary: "prime-agent" },
};

const PRIME_AGENT_HINT = `Prime Agent connects by URL. Start \`agent-handoff --http ${HTTP_PORT}\`, then run:\n  prime-agent mcp add agent-handoff --url http://127.0.0.1:${HTTP_PORT}/mcp`;

async function installed(binary: string): Promise<boolean> {
  try {
    await execFileAsync("which", [binary]);
    return true;
  } catch {
    return false;
  }
}

function cancelled(): never {
  p.cancel("Setup cancelled. Nothing was changed.");
  process.exit(0);
}

function answer<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) cancelled();
  return value as Exclude<T, symbol>;
}

// Names come from REGISTRATIONS itself, so the lookup cannot miss.
const agentOf = (name: string) => REGISTRATIONS[name] as AgentRegistration;

const dim = (text: string) => styleText("dim", text);

export async function runSetup(): Promise<void> {
  // Prompts wait for keystrokes forever when stdin is not a terminal, so stop early.
  if (!process.stdin.isTTY) {
    console.error("agent-handoff setup needs an interactive terminal. Nothing was changed.");
    process.exitCode = 1;
    return;
  }

  console.log();
  p.intro(styleText(["bgCyan", "black"], " agent-handoff "));

  const current = loadConfig();
  const env = loadEnv();
  const config: HandoffConfig = { ...current };
  const secrets: Record<string, string> = {};

  const providerName = answer(
    await p.select({
      message: "Sandbox provider",
      options: PROVIDERS.map(({ name, summary }) => ({ value: name, label: name, hint: summary })),
      initialValue: current.provider,
    }),
  );
  const provider = PROVIDERS.find((choice) => choice.name === providerName) as ProviderChoice;
  config.provider = provider.name;

  if (provider.name === "ssh") {
    const host = answer(
      await p.text({
        message: "SSH host",
        placeholder: "user@host",
        initialValue: current.ssh?.host,
        validate: (value) => (value?.trim() ? undefined : "An SSH host is required."),
      }),
    ).trim();
    config.ssh = { host };
    const spin = p.spinner();
    spin.start(`Checking SSH access to ${host}`);
    try {
      await execFileAsync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "command -v git && command -v node"]);
      spin.stop(`Connected to ${host}. git and node are available.`);
    } catch {
      spin.error("Could not confirm SSH access with git and node.");
      p.log.warn("Check key-based login and install git and Node.js on the host. Setup continues.");
    }
  }

  const askKey = async (key: string, hint: string) => {
    const value = answer(await p.password({ message: `${key} ${dim(hint)}`.trim() }));
    if (value.trim()) secrets[key] = value.trim();
  };

  for (const key of [...provider.keys, "GITHUB_TOKEN"]) {
    if (env[key]) continue;
    await askKey(key, key === "GITHUB_TOKEN" ? "(needs Contents and Pull requests read and write on your repos. Enter to skip)" : "(Enter to skip)");
  }

  const missingModelKeys = MODEL_KEYS.filter((key) => !env[key]);
  if (missingModelKeys.length < MODEL_KEYS.length) {
    p.log.info(`Model keys already set: ${MODEL_KEYS.filter((key) => env[key]).join(", ")}`);
  }
  if (missingModelKeys.length > 0) {
    p.log.step("Model keys for the remote agent. Press Enter to skip any key.");
    for (const key of missingModelKeys) await askKey(key, "");
  }

  const targetAgent = answer(
    await p.select({
      message: "Default remote agent",
      options: [
        { value: SAME_AS_CALLER, label: "Same as the calling agent" },
        ...REMOTE_AGENT_NAMES.map((name) => ({ value: name, label: name })),
      ],
      initialValue: current.targetAgent ?? SAME_AS_CALLER,
    }),
  );
  config.targetAgent = targetAgent || undefined;

  const detectSpin = p.spinner();
  detectSpin.start("Detecting installed agents");
  const found = await Promise.all(
    Object.entries(REGISTRATIONS).map(async ([name, agent]) => ((await installed(agent.binary)) ? name : undefined)),
  );
  const detected = found.filter((name): name is string => name !== undefined);
  detectSpin.stop(
    detected.length > 0 ? `Detected ${detected.length} agent${detected.length === 1 ? "" : "s"}` : "No supported agents detected",
  );

  let registerAgents: string[] = [];
  let skillAgents: string[] = [];
  let skillScope: "project" | "global" = "global";
  if (detected.length === 0) {
    p.log.warn("Install opencode, claude, codex, pi, or prime-agent, then run setup again to register the server.");
  } else {
    registerAgents = answer(
      await p.multiselect({
        message: "Register the MCP server with",
        options: detected.map((name) => ({
          value: name,
          label: agentOf(name).label,
          hint: agentOf(name).args ? undefined : "connects by URL",
        })),
        initialValues: detected,
        required: false,
      }),
    );

    const skillOptions = detected.filter((name) => agentOf(name).skills);
    if (!existsSync(SKILL_DIR)) {
      p.log.warn("The handoff skill is missing from this install. Skipping skill setup.");
    } else if (skillOptions.length > 0) {
      skillAgents = answer(
        await p.multiselect({
          message: "Install the handoff skill for",
          options: skillOptions.map((name) => ({ value: name, label: agentOf(name).label })),
          initialValues: skillOptions.filter((name) => registerAgents.includes(name)),
          required: false,
        }),
      );
      if (skillAgents.length > 0) {
        skillScope = answer(
          await p.select({
            message: "Installation scope",
            options: [
              { value: "project" as const, label: "Project", hint: "Install in current directory (committed with your project)" },
              { value: "global" as const, label: "Global", hint: "Install in home directory (available across all projects)" },
            ],
            initialValue: "global" as const,
          }),
        );
      }
    }
  }

  // Agents that share a skills directory (for example .agents/skills) get one copy.
  const skillTargets = new Map<string, string[]>();
  for (const name of skillAgents) {
    const skills = agentOf(name).skills as NonNullable<AgentRegistration["skills"]>;
    const dir = resolve(skillScope === "global" ? skills.global : skills.project);
    skillTargets.set(dir, [...(skillTargets.get(dir) ?? []), agentOf(name).label]);
  }

  const summary = [
    `Provider: ${provider.name}${config.ssh ? ` (${config.ssh.host})` : ""}`,
    `Keys to save: ${Object.keys(secrets).join(", ") || "none"}`,
    `Default remote agent: ${config.targetAgent ?? "same as the calling agent"}`,
    `MCP server: ${registerAgents.map((name) => agentOf(name).label).join(", ") || "not registered"}`,
    ...(skillTargets.size > 0
      ? [`Handoff skill (${skillScope}):`, ...[...skillTargets].map(([dir, labels]) => `  ${labels.join(", ")}: ${dir}`)]
      : ["Handoff skill: not installed"]),
  ];
  p.note(summary.join("\n"), "Setup summary");
  if (!answer(await p.confirm({ message: "Proceed with setup?" }))) cancelled();

  const results: string[] = [];
  const failures: string[] = [];

  const saveSpin = p.spinner();
  saveSpin.start("Saving settings");
  saveConfig(config);
  if (Object.keys(secrets).length > 0) saveSecrets(secrets);
  saveSpin.stop("Saved settings");
  results.push(`Keys are in ${secretsPath()} (readable only by you).`);

  for (const name of registerAgents) {
    const { label, binary, args } = agentOf(name);
    if (!args) {
      results.push(PRIME_AGENT_HINT);
      continue;
    }
    const spin = p.spinner();
    spin.start(`Registering with ${label}`);
    try {
      await execFileAsync(binary, args);
      spin.stop(`Registered with ${label}`);
    } catch {
      spin.error(`Could not register with ${label}`);
      failures.push(`Run it yourself: ${binary} ${args.join(" ")}`);
    }
  }

  if (skillTargets.size > 0) {
    const spin = p.spinner();
    spin.start("Installing the handoff skill");
    const failuresBefore = failures.length;
    for (const [dir, labels] of skillTargets) {
      try {
        mkdirSync(dir, { recursive: true });
        cpSync(SKILL_DIR, join(dir, "handoff"), { recursive: true });
        results.push(`Skill installed for ${labels.join(", ")}: ${join(dir, "handoff")}`);
      } catch (error) {
        failures.push(`Skill not installed in ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > failuresBefore) spin.error("Could not install the handoff skill everywhere");
    else spin.stop("Installed the handoff skill");
  }

  p.note(results.join("\n"), "Result");
  for (const failure of failures) p.log.error(failure);
  p.outro("Done. Reload your agents so they pick up the server.");
}
