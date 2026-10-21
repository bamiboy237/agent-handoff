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

export interface SshDetails {
  command: string;
  zedCommand: string;
  expiresAt: string;
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

  agent: string;
  sessionId: string;
  task: string;

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
  sandboxId?: string;
  cacheSnapshot: string;
  cacheHit?: boolean;
  agentVersion: string;
  setupCommands: string[];
  remoteHome?: string;
  remoteDir?: string;
  envKeys: string[]; // names only, for display
  ssh?: SshDetails;
  prUrl?: string;

  helperPid?: number;
  startRequested: boolean;
  createdAt: string;
  updatedAt: string;
  log: LogEntry[];
}
