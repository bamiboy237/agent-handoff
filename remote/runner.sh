#!/usr/bin/env bash
# Runs inside the sandbox. The local helper uploads it and calls one phase at a time:
#   install-agent  install the target agent (TARGET_AGENT, pinned to AGENT_VERSION when set)
#   checkout       clone or fetch the snapshot branch and create the result branch
#   setup          run the generated setup.sh
#   run            continue the task with the target agent, push, and open a draft PR
#   resume         answer messages that arrived after the run finished, then push again
# Secrets arrive as sandbox environment variables, or in secrets.env for providers
# that cannot set them. Non-secret settings come from handoff.env.
set -eEuo pipefail

HANDOFF_HOME="${HANDOFF_HOME:-$HOME/.agent-handoff}"
STATE_FILE="$HANDOFF_HOME/state"
LOG_FILE="$HANDOFF_HOME/runner.log"
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$PATH"
export NO_COLOR=1
mkdir -p "$HANDOFF_HOME"
if [ -f "$HANDOFF_HOME/secrets.env" ]; then set -a; . "$HANDOFF_HOME/secrets.env"; set +a; fi
if [ -f "$HANDOFF_HOME/handoff.env" ]; then . "$HANDOFF_HOME/handoff.env"; fi
TARGET_AGENT="${TARGET_AGENT:-opencode}"
AGENT_VERSION="${AGENT_VERSION:-}"
# Empty means the agent's own default model.
AGENT_MODEL="${AGENT_MODEL:-}"
# `agent-handoff send` writes messages here; the runner answers them oldest first.
INBOX="$HANDOFF_HOME/inbox"
# The watch link (watch.mjs) listens on WATCH_PORT. OpenCode's server gets a fixed
# port so the watch link can point a public URL at it.
WATCH_PORT="${WATCH_PORT:-}"
OPENCODE_PORT="${OPENCODE_PORT:-49374}"

PHASE="${1:-}"

log() { printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$PHASE" "$*" | tee -a "$LOG_FILE" >&2; }
set_state() { printf '%s\n' "$1" > "$STATE_FILE"; log "state $1"; }
trap 'set_state "failed:$PHASE"' ERR

json_string() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'
}

# Reads GITHUB_TOKEN from the environment each time, so the token never lands in .git/config.
CREDENTIAL_HELPER='!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f'
git_auth() { git -c credential.helper= -c credential.helper="$CREDENTIAL_HELPER" "$@"; }

# Installs into the user's home when the global npm prefix is not writable, as on a plain SSH host.
# The global prefix can be writable while a preinstalled package inside it is not
# (Daytona ships Codex that way), so a failed global install retries in a user
# prefix, which comes first on PATH.
npm_install_global() {
  if [ -w "$(npm prefix -g)" ] && npm install -g --no-fund --no-audit "$@" >> "$LOG_FILE" 2>&1; then return; fi
  npm install -g --prefix "$HOME/.npm-global" --no-fund --no-audit "$@" >> "$LOG_FILE" 2>&1
}

# True when the binary exists and, if a version is pinned, reports that version.
agent_installed() {
  local version
  version="$("$1" --version 2>/dev/null)" || return 1
  [ -z "$AGENT_VERSION" ] || printf '%s' "$version" | grep -q "$AGENT_VERSION"
}

install_opencode() {
  # Check this binary, not the first opencode on PATH: some images ship an old OpenCode 1.
  local bin="$HOME/.opencode/bin/opencode"
  if "$bin" --version 2>/dev/null | grep -q " v2\." && agent_installed "$bin"; then return; fi
  if ! "$bin" --version 2>/dev/null | grep -q ' v2\.'; then
    # The install script ships OpenCode 1 only. --major moves to the latest OpenCode 2
    # and ignores a requested version, so a second upgrade pins it.
    curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path >> "$LOG_FILE" 2>&1
    "$bin" upgrade --major --method curl >> "$LOG_FILE" 2>&1
  fi
  if [ -n "$AGENT_VERSION" ]; then "$bin" upgrade "$AGENT_VERSION" --method curl >> "$LOG_FILE" 2>&1; fi
  agent_installed "$bin"
}

install_npm_agent() {
  local bin="$1" package="$2"
  shift 2
  if agent_installed "$bin"; then return; fi
  npm_install_global "$@" "$package${AGENT_VERSION:+@$AGENT_VERSION}"
  agent_installed "$bin"
}

install_agent() {
  log "installing $TARGET_AGENT ${AGENT_VERSION:-latest}"
  case "$TARGET_AGENT" in
    opencode) install_opencode ;;
    claude) install_npm_agent claude @anthropic-ai/claude-code ;;
    codex) install_npm_agent codex @openai/codex ;;
    pi) install_npm_agent pi @earendil-works/pi-coding-agent --ignore-scripts ;;
    *) log "unknown target agent $TARGET_AGENT"; return 1 ;;
  esac
  log "$TARGET_AGENT is ready"
  start_watch_server
}

checkout() {
  if [ -d "$WORKDIR/.git" ]; then
    log "fetching $SNAPSHOT_BRANCH into the cached checkout"
    git_auth -C "$WORKDIR" fetch --quiet origin "$SNAPSHOT_BRANCH"
  else
    log "cloning $SNAPSHOT_BRANCH"
    mkdir -p "$(dirname "$WORKDIR")"
    git_auth clone --quiet --branch "$SNAPSHOT_BRANCH" "$REPO_URL" "$WORKDIR"
    git -C "$WORKDIR" config credential.helper "$CREDENTIAL_HELPER"
  fi
  git -C "$WORKDIR" checkout --quiet --force -B "$RESULT_BRANCH" "origin/$SNAPSHOT_BRANCH"
  # Removes untracked leftovers from a cached checkout. Ignored files such as dependencies stay.
  git -C "$WORKDIR" clean -fdq
  git -C "$WORKDIR" config user.name "$GIT_AUTHOR_NAME"
  git -C "$WORKDIR" config user.email "$GIT_AUTHOR_EMAIL"
}

start_opencode_service() {
  if opencode service status >/dev/null 2>&1; then return; fi
  opencode service set port "$OPENCODE_PORT" >> "$LOG_FILE" 2>&1 || true
  if ! opencode service start >> "$LOG_FILE" 2>&1; then
    # Containers often lack a service manager, so run the service in the background directly.
    nohup opencode serve --service --port "$OPENCODE_PORT" >> "$HANDOFF_HOME/serve.log" 2>&1 &
  fi
  for _ in $(seq 1 60); do
    if opencode service status >/dev/null 2>&1; then return; fi
    sleep 1
  done
  log "the OpenCode service did not start"
  return 1
}

register_opencode_keys() {
  for integration in ${HANDOFF_OC_INTEGRATIONS:-}; do
    local name key
    name="HANDOFF_OC_KEY_$(printf '%s' "$integration" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"
    key="${!name:-}"
    if [ -z "$key" ]; then continue; fi
    # A freshly started service answers 404 until its integration catalog loads.
    for _ in $(seq 1 30); do
      if opencode api integration.get --param "integrationID=$integration" > /dev/null 2>&1; then break; fi
      sleep 1
    done
    # One provider failing should not stop the run; the session may use another.
    if opencode api integration.connect.key --param "integrationID=$integration" \
      --data "{\"key\":\"$(json_string "$key")\"}" > /dev/null 2>> "$LOG_FILE"; then
      log "registered the API key for $integration"
    else
      log "could not register the API key for $integration"
    fi
  done
}

import_opencode_session() {
  if opencode api session.get --param "sessionID=$SESSION_ID" > /dev/null 2>&1; then
    log "session $SESSION_ID is already imported"
    return
  fi
  opencode session import "$HANDOFF_HOME/session.json" --directory "$WORKDIR" >> "$LOG_FILE" 2>&1
  if ! opencode api session.get --param "sessionID=$SESSION_ID" > /dev/null 2>&1; then
    # Import assigned a new ID. It is the newest session in the workspace.
    SESSION_ID="$(cd "$WORKDIR" && opencode session list --format json --max-count 1 | grep -o 'ses_[A-Za-z0-9]*' | head -n 1)"
    log "the imported session has the new ID $SESSION_ID"
  fi
}

# `agent-handoff attach` and later messages need the session the run used.
remember_opencode_session() {
  if [ -z "${SESSION_ID:-}" ]; then
    SESSION_ID="$(cd "$WORKDIR" && opencode session list --format json --max-count 1 | grep -o 'ses_[A-Za-z0-9]*' | head -n 1)"
  fi
  printf '%s\n' "$SESSION_ID" > "$HANDOFF_HOME/session-id"
}

# Every headless run closes stdin: with a non-TTY stdin, several agents wait for
# piped input before sending the prompt, and a provider's session pipe never reaches EOF.
run_opencode() {
  start_opencode_service
  register_opencode_keys
  local status=0
  if [ -f "$HANDOFF_HOME/session.json" ]; then
    import_opencode_session
    printf '%s\n' "$SESSION_ID" > "$HANDOFF_HOME/session-id"
    opencode run --session "$SESSION_ID" --auto ${AGENT_MODEL:+--model "$AGENT_MODEL"} "$1" < /dev/null || status=$?
  else
    opencode run --auto ${AGENT_MODEL:+--model "$AGENT_MODEL"} "$1" < /dev/null || status=$?
  fi
  remember_opencode_session
  return "$status"
}

# Claude Code, Codex, and Pi write JSON events, one per line, so the watch page can
# show each tool call. transcript.mjs reads them.
run_claude() {
  # Claude Code refuses to skip permissions as root unless it is told it runs in a sandbox.
  IS_SANDBOX=1 claude -p --output-format stream-json --verbose --dangerously-skip-permissions ${AGENT_MODEL:+--model "$AGENT_MODEL"} "$1" < /dev/null
}

run_codex() {
  if [ -n "${HANDOFF_CODEX_AUTH_JSON:-}" ] && [ ! -f "$HOME/.codex/auth.json" ]; then
    mkdir -p "$HOME/.codex"
    printf '%s' "$HANDOFF_CODEX_AUTH_JSON" | base64 -d > "$HOME/.codex/auth.json"
    chmod 600 "$HOME/.codex/auth.json"
    grep -qs cli_auth_credentials_store "$HOME/.codex/config.toml" ||
      printf 'cli_auth_credentials_store = "file"\n' >> "$HOME/.codex/config.toml"
  fi
  codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${AGENT_MODEL:+-m "$AGENT_MODEL"} "$1" < /dev/null
}

run_pi() {
  pi -p --mode json ${AGENT_MODEL:+--model "$AGENT_MODEL"} "$1" < /dev/null
}

# Each resume_* continues the session the run started, with one message.
resume_opencode() {
  start_opencode_service
  local session
  session="$(cat "$HANDOFF_HOME/session-id" 2>/dev/null || true)"
  if [ -n "$session" ]; then
    opencode run --session "$session" --auto ${AGENT_MODEL:+--model "$AGENT_MODEL"} "$1" < /dev/null
  else
    opencode run --continue --auto ${AGENT_MODEL:+--model "$AGENT_MODEL"} "$1" < /dev/null
  fi
}

resume_claude() {
  IS_SANDBOX=1 claude -p --continue --output-format stream-json --verbose --dangerously-skip-permissions ${AGENT_MODEL:+--model "$AGENT_MODEL"} "$1" < /dev/null
}

resume_codex() {
  codex exec resume --last --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${AGENT_MODEL:+-m "$AGENT_MODEL"} "$1" < /dev/null
}

resume_pi() {
  pi -c -p --mode json ${AGENT_MODEL:+--model "$AGENT_MODEL"} "$1" < /dev/null
}

# Answers queued messages oldest first, each in the same session. A message that
# arrives while one is being answered is picked up on the next pass.
# A glob, not ls: under errtrace, a failing ls in a substitution would fire the
# ERR trap and briefly mark the run as failed.
answer_messages() {
  local pending done_file
  mkdir -p "$INBOX/done"
  while true; do
    pending=("$INBOX"/*.md)
    [ -e "${pending[0]}" ] || return 0
    done_file="$INBOX/done/$(basename "${pending[0]}")"
    mv "${pending[0]}" "$done_file"
    log "message: $(head -c 200 "$done_file" | tr '\n' ' ')"
    (cd "$WORKDIR" && "resume_$TARGET_AGENT" "$(cat "$done_file")") >> "$LOG_FILE" 2>&1 || return $?
  done
}

# Serves the watch link. It needs Node; without it the handoff still runs, with no
# watch page. Starting it twice is harmless: a running server answers /health.
start_watch_server() {
  if [ -z "$WATCH_PORT" ] || [ -z "${WATCH_KEY:-}" ]; then return; fi
  if ! command -v node > /dev/null; then
    log "no Node in the sandbox, so there is no watch page"
    return
  fi
  if curl -fsS -o /dev/null -m 2 "http://127.0.0.1:$WATCH_PORT/health"; then return; fi
  HANDOFF_HOME="$HANDOFF_HOME" WATCH_PORT="$WATCH_PORT" WATCH_KEY="$WATCH_KEY" TARGET_AGENT="$TARGET_AGENT" \
    OPENCODE_PORT="$OPENCODE_PORT" WORKDIR="$WORKDIR" nohup node "$HANDOFF_HOME/watch.mjs" >> "$HANDOFF_HOME/watch.log" 2>&1 &
}

# Providers that stop idle sandboxes even while processes run (Daytona) get a
# preview URL. Pinging a tiny listener through it keeps the sandbox awake.
start_heartbeat() {
  HEARTBEAT_PID=""
  if [ -z "${HEARTBEAT_URL:-}" ]; then return; fi
  mkdir -p "$HANDOFF_HOME/heartbeat"
  if command -v python3 > /dev/null; then
    nohup python3 -m http.server "$HEARTBEAT_PORT" --directory "$HANDOFF_HOME/heartbeat" > /dev/null 2>&1 &
  elif command -v node > /dev/null; then
    nohup node -e "require('http').createServer((q, s) => s.end('ok')).listen($HEARTBEAT_PORT)" > /dev/null 2>&1 &
  else
    log "no python3 or node for the heartbeat listener; the sandbox may auto-stop during long runs"
  fi
  (
    while true; do
      curl -fsS -o /dev/null -H "X-Daytona-Preview-Token: $HEARTBEAT_TOKEN" "$HEARTBEAT_URL" || true
      sleep 240
    done
  ) &
  HEARTBEAT_PID=$!
}

create_draft_pr() {
  if [ -z "${GITHUB_REPO:-}" ]; then
    log "the origin remote is not on GitHub; skipping the draft pull request"
    return
  fi
  local title body status
  if [ -s "$HANDOFF_HOME/pr-url" ]; then
    log "updated the draft pull request $(cat "$HANDOFF_HOME/pr-url")"
    return
  fi
  title="$(head -n 1 "$HANDOFF_HOME/title.txt")"
  body="Continued in a cloud sandbox by $TARGET_AGENT through agent-handoff (handoff $HANDOFF_ID).

$(cat "$HANDOFF_HOME/brief.md")"
  status="$(curl -sS -o "$HANDOFF_HOME/pr.json" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_REPO/pulls" \
    -d "{\"title\":\"$(json_string "$title")\",\"head\":\"$RESULT_BRANCH\",\"base\":\"$BASE_BRANCH\",\"draft\":true,\"body\":\"$(json_string "$body")\"}")"
  if [ "$status" = "201" ]; then
    grep -o '"html_url": *"[^"]*/pull/[0-9]*"' "$HANDOFF_HOME/pr.json" | head -n 1 | sed 's/.*"\(http[^"]*\)"/\1/' > "$HANDOFF_HOME/pr-url"
    log "opened draft pull request $(cat "$HANDOFF_HOME/pr-url")"
  else
    log "GitHub returned $status for the draft pull request: $(head -c 300 "$HANDOFF_HOME/pr.json")"
  fi
}

publish_result() {
  cd "$WORKDIR"
  if [ -n "$(git status --porcelain)" ]; then
    git add --all
    git commit --quiet -m "agent-handoff: uncommitted remote work"
  fi
  git_auth push --quiet origin "HEAD:refs/heads/$RESULT_BRANCH"
  log "pushed $RESULT_BRANCH"
  create_draft_pr
}

run_agent() {
  set_state running
  start_watch_server
  start_heartbeat
  local status=0 prompt
  prompt="$(cat "$HANDOFF_HOME/prompt.txt")"
  (cd "$WORKDIR" && "run_$TARGET_AGENT" "$prompt") >> "$LOG_FILE" 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then answer_messages || status=$?; fi
  finish_run "$status"
}

# Started by `agent-handoff send` when a message arrives after the run finished.
resume_agent() {
  set_state running
  start_watch_server
  start_heartbeat
  local status=0
  answer_messages || status=$?
  finish_run "$status"
}

finish_run() {
  local status="$1"
  if [ -n "$HEARTBEAT_PID" ]; then kill "$HEARTBEAT_PID" 2>/dev/null || true; fi
  # Push even after a failed run, so partial work is never stranded in the sandbox.
  publish_result
  if [ "$status" -ne 0 ]; then
    log "$TARGET_AGENT exited with $status"
    set_state "failed:agent"
    exit "$status"
  fi
  set_state completed
}

case "$PHASE" in
  install-agent) install_agent ;;
  checkout) checkout ;;
  setup) bash "$HANDOFF_HOME/setup.sh" "$WORKDIR" >> "$LOG_FILE" 2>&1 ;;
  run) run_agent ;;
  resume) resume_agent ;;
  *)
    echo "usage: runner.sh install-agent|checkout|setup|run|resume" >&2
    exit 2
    ;;
esac
