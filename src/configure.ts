// `agent-handoff setup`: choose a sandbox provider and the agents that can run
// there, store only the keys those agents need, register the MCP server with the
// agents installed on this machine, and install the handoff skill. The prompts
// and flow follow `npx skills add` (vercel-labs/skills).
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, styleText } from "node:util";
import * as p from "@clack/prompts";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
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

// Agents that can continue the work in the sandbox. Names match REMOTE_AGENTS
// in agents/remote.ts. Any one key in `keys` is enough for the agent to run.
interface CloudAgentChoice {
  name: string;
  label: string;
  keys: { name: string; hint: string }[];
  // Describes a login on this machine that the handoff reuses, when there is one.
  existingLogin(): string | undefined;
}

const codexAuthFile = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");

const CLOUD_AGENTS: CloudAgentChoice[] = [
  {
    name: "opencode",
    label: "OpenCode",
    keys: [],
    existingLogin: () => "uses your OpenCode login",
  },
  {
    name: "codex",
    label: "Codex",
    keys: [
      { name: "OPENAI_API_KEY", hint: "OpenAI API key" },
      { name: "CODEX_API_KEY", hint: "Codex API key" },
    ],
    existingLogin: () => (existsSync(codexAuthFile) ? `uses ${codexAuthFile.replace(homedir(), "~")}` : undefined),
  },
  {
    name: "claude",
    label: "Claude Code",
    keys: [
      { name: "CLAUDE_CODE_OAUTH_TOKEN", hint: "subscription token from `claude setup-token`" },
      { name: "ANTHROPIC_API_KEY", hint: "Anthropic API key" },
    ],
    existingLogin: () => undefined,
  },
  {
    name: "pi",
    label: "Pi",
    keys: [
      { name: "ANTHROPIC_API_KEY", hint: "Anthropic API key" },
      { name: "OPENAI_API_KEY", hint: "OpenAI API key" },
      { name: "GEMINI_API_KEY", hint: "Gemini API key" },
      { name: "OPENROUTER_API_KEY", hint: "OpenRouter API key" },
    ],
    existingLogin: () => undefined,
  },
];

interface AgentRegistration {
  label: string;
  binary: string;
  // The `mcp add` arguments for a server entry point. Undefined for agents that
  // connect by URL instead of a stdio command.
  args?: (entry: string) => string[];
  // For editors with no `mcp add` command: the JSON file that lists their MCP
  // servers. The editor counts as installed when the file's directory exists.
  configFile?: ConfigFile;
  skills?: { global: string; project: string };
}

// Skills directories match the agent table in vercel-labs/skills (src/agents.ts).
// OpenCode, Codex, and Pi read the shared .agents/skills directory in a project.
const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
const appData = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
// Zed reads ~/.config/zed on macOS too, not ~/Library/Application Support/Zed.
const zedConfigDir = process.platform === "win32" ? join(appData, "Zed") : join(xdgConfigHome, "zed");

interface ConfigFile {
  path: string;
  // The top-level object that maps server names to servers.
  serversKey: string;
  entry(command: string, args: string[]): Record<string, unknown>;
}

// Commands that add a stdio MCP server to each agent's user-level config.
const REGISTRATIONS: Record<string, AgentRegistration> = {
  opencode: {
    label: "OpenCode",
    binary: "opencode",
    args: (entry) => ["mcp", "add", "agent-handoff", "--", "node", entry],
    skills: { global: join(xdgConfigHome, "opencode", "skills"), project: join(".agents", "skills") },
  },
  claude: {
    label: "Claude Code",
    binary: "claude",
    args: (entry) => ["mcp", "add", "--scope", "user", "agent-handoff", "--", "node", entry],
    skills: { global: join(claudeHome, "skills"), project: join(".claude", "skills") },
  },
  codex: {
    label: "Codex",
    binary: "codex",
    args: (entry) => ["mcp", "add", "agent-handoff", "--", "node", entry],
    skills: { global: join(homedir(), ".agents", "skills"), project: join(".agents", "skills") },
  },
  pi: {
    label: "Pi",
    binary: "pi",
    args: (entry) => ["mcp", "add", "agent-handoff", "--", "node", entry],
    skills: { global: join(homedir(), ".agents", "skills"), project: join(".agents", "skills") },
  },
  "prime-agent": { label: "Prime Agent", binary: "prime-agent" },
  zed: {
    label: "Zed agent",
    binary: "zed",
    configFile: {
      path: join(zedConfigDir, "settings.json"),
      serversKey: "context_servers",
      entry: (command, args) => ({ command, args, env: {} }),
    },
  },
};

const PRIME_AGENT_HINT = `Prime Agent connects by URL. Start \`agent-handoff --http ${HTTP_PORT}\`, then run:\n  prime-agent mcp add agent-handoff --url http://127.0.0.1:${HTTP_PORT}/mcp`;

// Editors are GUI apps that may not inherit the shell's PATH, so their entries name
// node by absolute path. The PATH lookup gives a stable link such as
// /opt/homebrew/bin/node; process.execPath is the versioned target, which breaks on
// the next upgrade.
async function nodePath(): Promise<string> {
  try {
    return (await execFileAsync("which", ["node"])).stdout.trim() || process.execPath;
  } catch {
    return process.execPath;
  }
}

async function serverEntry(file: ConfigFile, entry: string): Promise<Record<string, unknown>> {
  return file.entry(await nodePath(), [entry]);
}

// npx runs setup from its cache (~/.npm/_npx/<hash>), which npm may clear or replace
// at any time. Registering that path would leave agents pointing at nothing, so setup
// copies the whole npx install, dependencies included, to a stable folder and
// registers the copy. A source checkout is already stable and is registered as is.
const installDir =
  process.platform === "win32"
    ? join(process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"), "agent-handoff")
    : join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "agent-handoff");

function npxInstallRoot(): string | undefined {
  const marker = `${sep}_npx${sep}`;
  const at = SERVER_ENTRY.indexOf(marker);
  if (at === -1) return undefined;
  const end = SERVER_ENTRY.indexOf(sep, at + marker.length);
  return end === -1 ? undefined : SERVER_ENTRY.slice(0, end);
}

// Dependencies ship source maps, type declarations, and docs that nothing loads at
// runtime. Skipping them halves the copy (152 MB to 73 MB). Licenses and this
// package's own files, such as the handoff skill's SKILL.md, are always kept.
const OWN_PACKAGE = dirname(dirname(SERVER_ENTRY));
const NOT_NEEDED_AT_RUNTIME = /\.(map|d\.[cm]?ts|md)$/i;

function neededAtRuntime(source: string): boolean {
  return (
    source.startsWith(OWN_PACKAGE) || /^licen[cs]e/i.test(basename(source)) || !NOT_NEEDED_AT_RUNTIME.test(source)
  );
}

// Copies into a fresh folder first, so a failed copy never leaves a half-written install.
function installServer(root: string): string {
  const staging = `${installDir}.new`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(root, staging, { recursive: true, filter: neededAtRuntime });
  rmSync(installDir, { recursive: true, force: true });
  renameSync(staging, installDir);
  return join(installDir, relative(root, SERVER_ENTRY));
}

// Zed's settings may hold comments and trailing commas.
// Editing in place keeps the user's comments and formatting, which re-serializing
// would drop. Running setup again replaces the agent-handoff entry.
async function registerInConfigFile(file: ConfigFile, entry: string): Promise<void> {
  const text = existsSync(file.path) ? readFileSync(file.path, "utf8") : "{}\n";
  const errors: ParseError[] = [];
  parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`${file.path} could not be parsed`);
  const edits = modify(text, [file.serversKey, "agent-handoff"], await serverEntry(file, entry), {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, applyEdits(text, edits));
}

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

  // An agent is ready when a login or one of its keys is already available.
  const readyBy = (agent: CloudAgentChoice) => {
    const key = agent.keys.find(({ name }) => env[name] || secrets[name]);
    return agent.existingLogin() ?? (key ? `uses ${key.name}` : undefined);
  };
  const needs = (agent: CloudAgentChoice) =>
    agent.keys.length > 2 ? "needs one model key" : `needs ${agent.keys.map((key) => key.name).join(" or ")}`;

  const cloudAgents = answer(
    await p.multiselect({
      message: "Which agents can continue your work in the cloud?",
      options: CLOUD_AGENTS.map((agent) => ({ value: agent.name, label: agent.label, hint: readyBy(agent) ?? needs(agent) })),
      initialValues: CLOUD_AGENTS.filter((agent) => readyBy(agent) || agent.name === current.targetAgent).map(
        (agent) => agent.name,
      ),
      required: true,
    }),
  );

  for (const agent of CLOUD_AGENTS.filter((choice) => cloudAgents.includes(choice.name))) {
    if (readyBy(agent)) continue;
    // With one key there is nothing to choose; otherwise ask which key the user has.
    const key =
      agent.keys.length === 1
        ? (agent.keys[0] as CloudAgentChoice["keys"][number])
        : answer(
            await p.select({
              message: `${agent.label} key`,
              options: agent.keys.map((choice) => ({ value: choice, label: choice.name, hint: choice.hint })),
            }),
          );
    await askKey(key.name, "(Enter to skip)");
  }

  config.targetAgent =
    cloudAgents.length === 1
      ? cloudAgents[0]
      : answer(
          await p.select({
            message: "Default cloud agent",
            options: CLOUD_AGENTS.filter((agent) => cloudAgents.includes(agent.name)).map((agent) => ({
              value: agent.name,
              label: agent.label,
            })),
            initialValue: cloudAgents.includes(current.targetAgent ?? "") ? current.targetAgent : cloudAgents[0],
          }),
        );

  const detectSpin = p.spinner();
  detectSpin.start("Detecting installed agents");
  const found = await Promise.all(
    Object.entries(REGISTRATIONS).map(async ([name, agent]) => {
      const present = agent.configFile ? existsSync(dirname(agent.configFile.path)) : await installed(agent.binary);
      return present ? name : undefined;
    }),
  );
  const detected = found.filter((name): name is string => name !== undefined);
  detectSpin.stop(
    detected.length > 0 ? `Detected ${detected.length} agent${detected.length === 1 ? "" : "s"}` : "No supported agents detected",
  );

  let registerAgents: string[] = [];
  let skillAgents: string[] = [];
  let skillScope: "project" | "global" = "global";
  if (detected.length === 0) {
    p.log.warn(
      "Install OpenCode, Claude Code, Codex, Pi, Prime Agent, or Zed, then run setup again to register the server.",
    );
  } else {
    registerAgents = answer(
      await p.multiselect({
        message: "Register the MCP server with",
        options: detected.map((name) => ({
          value: name,
          label: agentOf(name).label,
          hint: agentOf(name).args || agentOf(name).configFile ? undefined : "connects by URL",
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

  const npxRoot = npxInstallRoot();
  const summary = [
    `Provider: ${provider.name}${config.ssh ? ` (${config.ssh.host})` : ""}`,
    `Keys to save: ${Object.keys(secrets).join(", ") || "none"}`,
    `Cloud agents: ${cloudAgents.map((name) => CLOUD_AGENTS.find((agent) => agent.name === name)?.label).join(", ")} (default ${config.targetAgent})`,
    `MCP server: ${registerAgents.map((name) => agentOf(name).label).join(", ") || "not registered"}`,
    ...(npxRoot && registerAgents.length > 0 ? [`Install folder: ${installDir}`] : []),
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

  let entry = SERVER_ENTRY;
  if (npxRoot && registerAgents.length > 0) {
    const spin = p.spinner();
    spin.start("Installing agent-handoff");
    try {
      entry = installServer(npxRoot);
      spin.stop(`Installed agent-handoff to ${installDir}`);
    } catch (error) {
      spin.error("Could not install agent-handoff outside the npx cache");
      failures.push(
        `${error instanceof Error ? error.message : String(error)}. Agents point at the npx cache, which npm may clear. Run setup again to fix it.`,
      );
    }
  }

  for (const name of registerAgents) {
    const { label, binary, args, configFile } = agentOf(name);
    if (!args && !configFile) {
      results.push(PRIME_AGENT_HINT);
      continue;
    }
    const spin = p.spinner();
    spin.start(`Registering with ${label}`);
    try {
      if (configFile) await registerInConfigFile(configFile, entry);
      else if (args) await execFileAsync(binary, args(entry));
      spin.stop(`Registered with ${label}`);
    } catch (error) {
      spin.error(`Could not register with ${label}`);
      failures.push(
        configFile
          ? `${error instanceof Error ? error.message : String(error)}. Add this under "${configFile.serversKey}" in ${configFile.path} yourself:\n  "agent-handoff": ${JSON.stringify(await serverEntry(configFile, entry))}`
          : `Run it yourself: ${binary} ${args?.(entry).join(" ")}`,
      );
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
