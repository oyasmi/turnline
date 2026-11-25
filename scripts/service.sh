#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ACTION="${1:-}"
if [ -z "$ACTION" ]; then
  echo "Usage: $0 <start|stop|restart|status|logs> [options]" >&2
  exit 2
fi
shift

MODE="lan"
HOST="127.0.0.1"
PORT="8686"
PUBLIC_URL=""
TLS_CERT=""
TLS_KEY=""
STATE_DIR=""
AUTH="passcode"
SESSION_DAYS="30"
TTS_THREADS="2"
DIRECT_ONLY=0
PIPICLAW_SOCKET=""
PASSCODE_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --tls-cert) TLS_CERT="$2"; shift 2 ;;
    --tls-key) TLS_KEY="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --auth) AUTH="$2"; shift 2 ;;
    --session-days) SESSION_DAYS="$2"; shift 2 ;;
    --tts-threads) TTS_THREADS="$2"; shift 2 ;;
    --direct-only) DIRECT_ONLY=1; shift ;;
    --pipiclaw-socket) PIPICLAW_SOCKET="$2"; shift 2 ;;
    --passcode-file) PASSCODE_FILE="$2"; shift 2 ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

case "$MODE" in
  local)
    DEFAULT_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/turnline"
    ;;
  lan)
    DEFAULT_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/turnline-lan"
    ;;
  public)
    DEFAULT_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/turnline-public"
    ;;
  *)
    echo "Unsupported --mode: $MODE (expected local, lan, or public)" >&2
    exit 2
    ;;
esac

STATE_DIR="${STATE_DIR:-$DEFAULT_STATE}"
PID_FILE="$STATE_DIR/turnline.pid"
LOG_FILE="$STATE_DIR/turnline.log"

is_running() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ] || ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  kill -0 "$pid" 2>/dev/null
}

do_start() {
  if is_running; then
    echo "Turnline ($MODE) 已在运行 (PID $(cat "$PID_FILE"))，日志: $LOG_FILE"
    return 0
  fi

  local uv_bin
  uv_bin="$(command -v uv || true)"
  if [ -z "$uv_bin" ]; then
    echo "找不到 uv，请先安装 uv 并确保其在 PATH 中。" >&2
    exit 1
  fi

  if [ "$MODE" != "local" ] && [ "$AUTH" = "passcode" ] && [ -z "$PASSCODE_FILE" ] && [ -z "${TURNLINE_PASSCODE_FILE:-}" ] && [ -z "${TURNLINE_PASSCODE:-}" ] && [ ! -f "$STATE_DIR/auth.json" ]; then
    echo "尚未为 $STATE_DIR 配置访问口令。请先运行：" >&2
    echo "  make auth-set STATE_DIR=$STATE_DIR" >&2
    exit 1
  fi

  local args=("$uv_bin" "run" "--no-sync" "python" "server.py")
  case "$MODE" in
    local)
      args+=(--host "$HOST" --port "$PORT" --state-dir "$STATE_DIR")
      ;;
    lan)
      if [ -z "$PUBLIC_URL" ]; then
        echo "内网启动需要提供 --public-url（或通过 make 的 LAN_HOST 指定），例如 https://192.168.1.5:8686" >&2
        exit 1
      fi
      args+=(--host "0.0.0.0" --port "$PORT" --self-signed --public-url "$PUBLIC_URL"
             --state-dir "$STATE_DIR" --auth "$AUTH" --session-days "$SESSION_DAYS")
      ;;
    public)
      if [ -z "$TLS_CERT" ] || [ -z "$TLS_KEY" ]; then
        echo "公网启动必须提供 --tls-cert 和 --tls-key。" >&2
        exit 1
      fi
      args+=(--host "0.0.0.0" --port "$PORT" --tls-cert "$TLS_CERT" --tls-key "$TLS_KEY"
             --state-dir "$STATE_DIR" --auth "$AUTH" --session-days "$SESSION_DAYS")
      if [ -n "$PUBLIC_URL" ]; then
        args+=(--public-url "$PUBLIC_URL")
      fi
      ;;
  esac

  args+=(--tts-threads "$TTS_THREADS")
  if [ "$DIRECT_ONLY" -eq 1 ]; then
    args+=(--direct-only)
  fi
  if [ -n "$PIPICLAW_SOCKET" ]; then
    args+=(--pipiclaw-socket "$PIPICLAW_SOCKET")
  fi

  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"

  local start_line=0
  if [ -f "$LOG_FILE" ]; then
    start_line="$(wc -l < "$LOG_FILE")"
  fi

  (
    cd "$REPO_DIR"
    if [ -n "$PASSCODE_FILE" ]; then
      export TURNLINE_PASSCODE_FILE="$PASSCODE_FILE"
    fi
    nohup "${args[@]}" >> "$LOG_FILE" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
  )

  local pid
  pid="$(cat "$PID_FILE")"
  local waited=0
  while [ "$waited" -lt 15 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "Turnline ($MODE) 启动失败，最近日志：" >&2
      tail -n +"$((start_line + 1))" "$LOG_FILE" >&2 || true
      exit 1
    fi
    if tail -n +"$((start_line + 1))" "$LOG_FILE" 2>/dev/null | grep -q "^Turnline "; then
      break
    fi
    sleep 0.2
    waited=$((waited + 1))
  done

  echo "Turnline ($MODE) 已后台启动 (PID $pid)"
  echo "日志文件: $LOG_FILE"
  tail -n +"$((start_line + 1))" "$LOG_FILE" 2>/dev/null | grep -E "^(Turnline |Trust this CA)" || true
}

do_stop() {
  if ! is_running; then
    rm -f "$PID_FILE"
    echo "Turnline ($MODE) 未在运行。"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true
  local waited=0
  while [ "$waited" -lt 25 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "Turnline ($MODE) 已停止 (PID $pid)。"
      return 0
    fi
    sleep 0.2
    waited=$((waited + 1))
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "Turnline ($MODE) 已强制停止 (PID $pid)。"
}

do_status() {
  if is_running; then
    echo "Turnline ($MODE) 运行中 (PID $(cat "$PID_FILE"))"
    echo "状态目录: $STATE_DIR"
    echo "日志文件: $LOG_FILE"
  else
    echo "Turnline ($MODE) 未运行 (状态目录: $STATE_DIR)"
    exit 1
  fi
}

do_logs() {
  if [ ! -f "$LOG_FILE" ]; then
    echo "日志文件尚不存在: $LOG_FILE" >&2
    exit 1
  fi
  exec tail -n 50 -f "$LOG_FILE"
}

case "$ACTION" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status) do_status ;;
  logs) do_logs ;;
  *)
    echo "Unknown action: $ACTION (expected start, stop, restart, status, or logs)" >&2
    exit 2
    ;;
esac
