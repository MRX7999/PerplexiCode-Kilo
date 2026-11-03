#!/bin/sh
# PreToolUse guard for Bash (Claude Code hook contract).
# stdin: {"tool_name":"Bash","tool_input":{"command":"..."},"cwd":"...","session_id":"..."}
# exit 2 = block, stderr goes back to the model as the reason.
input=$(cat)
command=$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -n 1)

case "$command" in
  *"curl "*"| sh"*|*"curl "*"|sh"*|*"wget "*"| sh"*)
    echo "Piping a download into a shell is blocked. Download, inspect, then run." >&2
    exit 2 ;;
  *"chmod 777"*)
    echo "chmod 777 is blocked; use the narrowest mode that works." >&2
    exit 2 ;;
  *"--no-verify"*)
    echo "Do not skip git hooks (--no-verify)." >&2
    exit 2 ;;
esac
exit 0
