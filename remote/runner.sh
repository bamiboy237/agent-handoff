#!/usr/bin/env bash
# Runs inside the sandbox. The local helper uploads it and calls one phase at a time:
#   install-agent  install the pinned OpenCode version
#   checkout       clone or fetch the snapshot branch and create the result branch
#   setup          run the generated setup.sh
#   run            import the session, continue the task, push, and open a draft PR
# Secrets arrive as sandbox environment variables. Non-secret settings come from handoff.env.
set -eEuo pipefail

HANDOFF_HOME="$HOME/.agent-handoff"
STATE_FILE="$HANDOFF_HOME/state"
LOG_FILE="$HANDOFF_HOME/runner.log"
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export NO_COLOR=1
mkdir -p "$HANDOFF_HOME"
if [ -f "$HANDOFF_HOME/handoff.env" ]; then . "$HANDOFF_HOME/handoff.env"; fi

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

install_agent() {
  # Check this binary, not the first opencode on PATH: some images ship their own copy.
  local bin="$HOME/.opencode/bin/opencode"
  if "$bin" --version 2>/dev/null | grep -q "v$OPENCODE_VERSION\$"; then
    log "opencode $OPENCODE_VERSION is already installed"
    return
  fi
  log "installing opencode $OPENCODE_VERSION"
  if ! "$bin" --version 2>/dev/null | grep -q ' v2\.'; then
    # The install script ships OpenCode 1 only. --major moves to the latest OpenCode 2
    # and ignores a requested version, so a second upgrade pins it.
    curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path >> "$LOG_FILE" 2>&1
    "$bin" upgrade --major --method curl >> "$LOG_FILE" 2>&1
  fi
  "$bin" upgrade "$OPENCODE_VERSION" --method curl >> "$LOG_FILE" 2>&1
  "$bin" --version | grep -q "v$OPENCODE_VERSION\$"
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

start_service() {
  if opencode service status >/dev/null 2>&1; then return; fi
  if ! opencode service start >> "$LOG_FILE" 2>&1; then
    # Containers often lack a service manager, so run the service in the background directly.
    nohup opencode serve --service >> "$HANDOFF_HOME/serve.log" 2>&1 &
  fi
  for _ in $(seq 1 60); do
    if opencode service status >/dev/null 2>&1; then return; fi
    sleep 1
  done
  log "the OpenCode service did not start"
  return 1
}

register_keys() {
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

import_session() {
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

# Daytona auto-stop ignores processes inside the sandbox. Preview requests reset
# the idle timer, so ping a tiny listener through the preview URL while working.
start_heartbeat() {
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
  title="agent-handoff: $(head -n 1 "$HANDOFF_HOME/task.txt")"
  body="Continued in a cloud sandbox by agent-handoff (handoff $HANDOFF_ID).

$(cat "$HANDOFF_HOME/task.txt")"
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
  start_heartbeat
  start_service
  register_keys
  import_session
  local status=0
  # stdin must be closed: with a non-TTY stdin, opencode run waits for piped input
  # before sending the prompt, and the Daytona session pipe never reaches EOF.
  (cd "$WORKDIR" && opencode run --session "$SESSION_ID" --auto "$(cat "$HANDOFF_HOME/prompt.txt")" < /dev/null) >> "$LOG_FILE" 2>&1 || status=$?
  kill "$HEARTBEAT_PID" 2>/dev/null || true
  # Push even after a failed run, so partial work is never stranded in the sandbox.
  publish_result
  if [ "$status" -ne 0 ]; then
    log "opencode run exited with $status"
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
  *)
    echo "usage: runner.sh install-agent|checkout|setup|run" >&2
    exit 2
    ;;
esac
