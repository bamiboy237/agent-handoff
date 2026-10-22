// The handoff record is the single source of truth shared by the MCP server,
// the detached helper, and `handoff_status`. It never holds credential values.

export type HandoffState =
  | "warming" // helper is creating the sandbox and installing the agent
  | "warm" // sandbox is ready; waiting for handoff_start
  | "waiting_for_idle" // start requested; waiting for the local turn to end
  | "transferring" // pushing the snapshot branch and uploading the session
  | "setting_up" // cloning and installing dependencies in the sandbox
  | "running" // remote agent is working
  | "completed" // remote agent finished and the runner pushed the result
  | "stopped" // stopped through handoff_stop
  | "abandoned" // prepared but never started; sandbox deleted
  | "failed";

export const TERMINAL_STATES: ReadonlySet<HandoffState> = new Set([
  "completed",
  "stopped",
  "abandoned",
  "failed",
]);

// Written by the calling model. It is the continuation context for every
// remote agent, and the only context when the native session cannot move.
export interface HandoffBrief {
  title: string; // one line; also the pull request title
  task: string;
  done?: string;
  decisions?: string;
  files?: string[];
  nextStep: string;
  verification?: string;
}

// What a sandbox provider can do. The tools offer only what the provider supports.
export interface ProviderCapabilities {
  ssh: boolean;
  cache: boolean; // can save and start from a reusable snapshot
  keepAlive: "heartbeat" | "none"; // heartbeat: the runner pings a preview URL while working
  maxLifetimeMinutes?: number;
}

export interface SshDetails {
  command: string; // ssh command for a terminal
  uri?: string; // ssh://user@host[:port]/path for editors that accept one
  expiresAt?: string;
}

export interface LogEntry {
  at: string;
  message: string;
}

export interface HandoffRecord {
  id: string;
  state: HandoffState;
  failedStep?: string;
  error?: string;

  sourceAgent: string; // the agent that called the tools
  targetAgent: string; // the agent that continues in the sandbox
  targetAgentVersion?: string;
  targetModel?: string; // in the target agent's own format; unset uses the agent's default
  sessionId?: string; // set only when the source agent identifies its session
  transferSession: boolean; // move the native session instead of relying on the brief alone
  snapshotMode: "on_idle" | "immediate";
  brief: HandoffBrief;

  projectDir: string;
  repoName: string;
  remoteUrl: string;
  cloneUrl: string;
  githubRepo?: string; // "owner/name" when the remote is on GitHub
  gitAuthorName: string;
  gitAuthorEmail: string;
  baseBranch: string;
  baseCommit: string;
  snapshotBranch: string;
  snapshotCommit?: string;
  resultBranch: string;

  sandboxProvider: string;
  capabilities: ProviderCapabilities;
  sandboxId?: string;
  cacheSnapshot?: string;
  cacheHit?: boolean;
  setupCommands: string[];
  remoteRoot?: string; // holds .agent-handoff/ and workspace/ in the sandbox
  remoteDir?: string;
  envKeys: string[]; // names only, for display
  ssh?: SshDetails;
  prUrl?: string;
  // The watch link: a page in the sandbox for following the agent from any device.
  watchKey?: string; // secret that the link carries; the page refuses requests without it
  watchUrl?: string;
  watchExpiresAt?: string;

  helperPid?: number;
  startRequested: boolean;
  createdAt: string;
  updatedAt: string;
  log: LogEntry[];
}
