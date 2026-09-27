#!/bin/sh
# 테스트용 가짜 claude: 실제 claude -p 처럼 훅을 부르고 JSON 결과를 출력해요.
# 사용: fake-claude.sh -p "<할 일>" [--output-format json] [--resume <id>] [--fork-session]
PROMPT=""; RESUME=""; FORK=0
while [ $# -gt 0 ]; do
  case "$1" in
    -p) PROMPT="$2"; shift 2 ;;
    --resume) RESUME="$2"; shift 2 ;;
    --fork-session) FORK=1; shift ;;
    *) shift ;;
  esac
done
[ "$PROMPT" = "FAIL" ] && { echo "Error: 가짜 실패" >&2; exit 1; }
SID="${RESUME:-fake-$$}"
[ "$FORK" = 1 ] && SID="fork-$$"
HOOK="$HOME/.codepup/codepup-hook.sh"
CWD="$(pwd)"
payload() { printf '{"session_id":"%s","cwd":"%s","transcript_path":"/tmp/x.jsonl"%s}' "$SID" "$CWD" "$1"; }
if [ -f "$HOOK" ]; then
  payload ',"source":"startup"' | sh "$HOOK" SessionStart >/dev/null
  payload ',"prompt":"x"' | sh "$HOOK" UserPromptSubmit >/dev/null
fi
sleep 1
if [ -f "$HOOK" ]; then
  payload ",\"last_assistant_message\":\"완료: $PROMPT\"" | sh "$HOOK" Stop >/dev/null
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"완료: %s","session_id":"%s"}\n' "$PROMPT" "$SID"
