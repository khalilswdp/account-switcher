#!/usr/bin/env bash
# Swap the Claude desktop app between accounts by renaming its data folder.
# Nothing is copied, deleted or overwritten: only renames, and every step checks
# that its target does not exist first. Quit the app (Cmd+Q) and run this from
# Terminal.app, not from inside the desktop app.
#
#   desktop-swap.sh status            show the active account and parked ones
#   desktop-swap.sh list              same, in a machine-readable form (used by the dashboard)
#   desktop-swap.sh init <name>       record the CURRENT folder as account <name> (once)
#   desktop-swap.sh new <name>        park the current folder, so the next launch starts fresh
#   desktop-swap.sh use <name>        make the parked account <name> the active one
#
# Layout:  Application Support/Claude          active account
#          Application Support/Claude.<name>   parked accounts
set -euo pipefail

SUPPORT="${SUPPORT_DIR:-$HOME/Library/Application Support}"
ACTIVE="$SUPPORT/Claude"
STATE_DIR="${SWAP_STATE_DIR:-$HOME/.claude-desktop-accounts}"
ACTIVE_FILE="$STATE_DIR/active"

die() { echo "Error: $*" >&2; exit 1; }
parked() { echo "$SUPPORT/Claude.$1"; }
valid_name() { [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || die "account name may only use letters, digits, - and _"; }
current() { [[ -f "$ACTIVE_FILE" ]] && cat "$ACTIVE_FILE" || true; }

app_running() {
  [[ -n "${SWAP_SKIP_RUNNING_CHECK:-}" ]] && return 1 # tests only
  pgrep -f "/Applications/Claude.app/Contents/" >/dev/null 2>&1
}
require_quit() {
  if app_running; then
    die "Claude desktop is still running. Quit it with Cmd+Q, wait a few seconds, then run this again from Terminal.app."
  fi
}
require_init() {
  CUR="$(current)"
  [[ -n "$CUR" ]] || die "not initialised. First run:  $0 init <name-of-the-account-currently-signed-in>"
}

cmd_status() {
  local cur; cur="$(current)"
  echo "Active account : ${cur:-(not initialised)}"
  echo "Active folder  : $([[ -d "$ACTIVE" ]] && echo present || echo missing)"
  echo "Desktop app    : $(app_running && echo RUNNING || echo not running)"
  shopt -s nullglob
  local d any=0
  for d in "$SUPPORT"/Claude.*; do
    [[ -d "$d" ]] && { echo "Parked         : ${d##*/Claude.}"; any=1; }
  done
  [[ $any -eq 1 ]] || echo "Parked         : (none)"
}

# Machine-readable state for the dashboard: active / running / parked lines.
cmd_list() {
  local cur; cur="$(current)"
  echo "active ${cur:--}"
  echo "running $(app_running && echo yes || echo no)"
  shopt -s nullglob
  local d
  for d in "$SUPPORT"/Claude.*; do
    if [[ -d "$d" ]]; then echo "parked ${d##*/Claude.}"; fi
  done
  return 0
}

cmd_init() {
  local name="${1:-}"; [[ -n "$name" ]] || die "usage: $0 init <name>"
  valid_name "$name"
  [[ -z "$(current)" ]] || die "already initialised as '$(current)'"
  [[ -d "$ACTIVE" ]] || die "no Claude data folder found at: $ACTIVE"
  mkdir -p "$STATE_DIR"
  echo "$name" > "$ACTIVE_FILE"
  echo "OK: the current Claude data folder is now tracked as '$name'."
}

cmd_new() {
  local name="${1:-}"; [[ -n "$name" ]] || die "usage: $0 new <name>"
  valid_name "$name"
  require_quit; require_init
  [[ "$name" != "$CUR" ]] || die "'$name' is already the active account"
  [[ ! -e "$(parked "$name")" ]] || die "an account named '$name' already exists (parked)"
  [[ -d "$ACTIVE" ]] || die "active folder is missing: launch the app once and sign in before creating another account"
  [[ ! -e "$(parked "$CUR")" ]] || die "$(parked "$CUR") already exists, refusing to overwrite"
  mv -- "$ACTIVE" "$(parked "$CUR")"
  echo "$name" > "$ACTIVE_FILE"
  echo "OK: '$CUR' is parked. Now open the Claude app, sign in as '$name', then quit it (Cmd+Q)."
}

cmd_use() {
  local name="${1:-}"; [[ -n "$name" ]] || die "usage: $0 use <name>"
  valid_name "$name"
  require_quit; require_init
  if [[ "$name" == "$CUR" ]]; then echo "'$name' is already active."; return 0; fi
  [[ -d "$(parked "$name")" ]] || die "no parked account named '$name' (see: $0 status)"
  [[ -d "$ACTIVE" ]] || die "active folder is missing: launch the app once and sign in as '$CUR' before switching"
  [[ ! -e "$(parked "$CUR")" ]] || die "$(parked "$CUR") already exists, refusing to overwrite"
  mv -- "$ACTIVE" "$(parked "$CUR")"
  if ! mv -- "$(parked "$name")" "$ACTIVE"; then
    mv -- "$(parked "$CUR")" "$ACTIVE" # roll back the first rename
    die "switch failed; rolled back, '$CUR' is active again"
  fi
  echo "$name" > "$ACTIVE_FILE"
  echo "OK: '$name' is active, '$CUR' is parked. You can open the Claude app now."
}

case "${1:-}" in
  status) cmd_status ;;
  list)   cmd_list ;;
  init)   shift; cmd_init "$@" ;;
  new)    shift; cmd_new "$@" ;;
  use)    shift; cmd_use "$@" ;;
  *)      sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
