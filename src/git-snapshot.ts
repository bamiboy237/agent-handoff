import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Untracked or modified files that are not gitignored are part of the snapshot.
// These names usually hold secrets, so prepare warns before they are pushed.
const SECRET_FILE_PATTERN = /(^|\/)(\.env(\..+)?|.*\.pem|.*\.key|id_rsa|id_ed25519)$/;

export interface RepoInfo {
  root: string;
  repoName: string;
  remoteUrl: string;
  cloneUrl: string;
  githubRepo?: string;
  baseBranch: string;
  baseCommit: string;
  authorName: string;
  authorEmail: string;
  changedFiles: number;
  secretLikeFiles: string[];
}

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  // GITHUB_TOKEN is meant for the sandbox. The gh credential helper prefers it over
  // the user's own sign-in, so drop it and push with the user's normal credentials.
  const { GITHUB_TOKEN: _sandboxToken, GH_TOKEN: _ghToken, ...localEnv } = process.env;
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...localEnv, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitOrFail(cwd: string, args: string[], message: string): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}

function parseGithubRepo(remoteUrl: string): string | undefined {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(remoteUrl);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

// The sandbox has no SSH keys, so it always clones over HTTPS with GITHUB_TOKEN.
function httpsCloneUrl(remoteUrl: string, githubRepo: string | undefined): string {
  if (githubRepo) return `https://github.com/${githubRepo}.git`;
  if (remoteUrl.startsWith("https://")) return remoteUrl;
  throw new Error(`The origin remote ${remoteUrl} is not HTTPS or GitHub. The sandbox cannot clone it.`);
}

export async function inspectRepo(dir: string): Promise<RepoInfo> {
  const root = await gitOrFail(dir, ["rev-parse", "--show-toplevel"], `${dir} is not inside a Git repository.`);
  const baseCommit = await gitOrFail(
    root,
    ["rev-parse", "--verify", "HEAD"],
    "The repository has no commits. Commit once before handing off.",
  );
  const baseBranch = await gitOrFail(
    root,
    ["symbolic-ref", "--short", "HEAD"],
    "HEAD is detached. Check out a branch before handing off.",
  );
  const remoteUrl = await gitOrFail(
    root,
    ["remote", "get-url", "origin"],
    "The repository has no origin remote. The handoff pushes the snapshot branch to origin.",
  );
  const githubRepo = parseGithubRepo(remoteUrl);

  // -z keeps paths with spaces intact. Each entry is "XY path"; renames add a second path.
  const status = await git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const paths = status
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3));

  return {
    root,
    repoName: basename(root),
    remoteUrl,
    cloneUrl: httpsCloneUrl(remoteUrl, githubRepo),
    githubRepo,
    baseBranch,
    baseCommit,
    authorName: await git(root, ["config", "user.name"]).catch(() => "agent-handoff"),
    authorEmail: await git(root, ["config", "user.email"]).catch(() => "agent-handoff@localhost"),
    changedFiles: paths.length,
    secretLikeFiles: paths.filter((path) => SECRET_FILE_PATTERN.test(path)),
  };
}

// Builds one commit holding committed, staged, unstaged, and new files.
// A copy of the index is used, so the working tree, the real index,
// and the current branch stay untouched.
export async function createSnapshotCommit(root: string, handoffId: string): Promise<string> {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-handoff-"));
  const tempIndex = join(tempDir, "index");
  try {
    const realIndex = resolve(root, await git(root, ["rev-parse", "--git-path", "index"]));
    // Starting from the real index reuses its stat cache, so unchanged files are not rehashed.
    if (existsSync(realIndex)) copyFileSync(realIndex, tempIndex);
    const env = { GIT_INDEX_FILE: tempIndex };
    await git(root, ["add", "--all"], env);
    const tree = await git(root, ["write-tree"], env);
    if (tree === (await git(root, ["rev-parse", "HEAD^{tree}"]))) {
      return git(root, ["rev-parse", "HEAD"]);
    }
    return git(root, ["commit-tree", tree, "-p", "HEAD", "-m", `agent-handoff snapshot ${handoffId}`]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function pushSnapshot(root: string, commit: string, branch: string): Promise<void> {
  await git(root, ["push", "--quiet", "origin", `${commit}:refs/heads/${branch}`]);
}
