#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

ACTION="${1:-}"
if [ -z "$ACTION" ]; then
  echo "Usage: $0 <render|install|uninstall|status|logs> [options]" >&2
  exit 2
fi
shift

MODE="lan"
NAME=""
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
    --name) NAME="$2"; shift 2 ;;
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
    DEFAULT_NAME="turnline"
    DEFAULT_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/turnline"
    ;;
  lan)
    DEFAULT_NAME="turnline-lan"
    DEFAULT_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/turnline-lan"
    ;;
  public)
    DEFAULT_NAME="turnline-public"
    DEFAULT_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/turnline-public"
    ;;
  *)
    echo "Unsupported --mode: $MODE (expected local, lan, or public)" >&2
    exit 2
    ;;
esac

SERVICE_NAME="${NAME:-$DEFAULT_NAME}"
STATE_DIR="${STATE_DIR:-$DEFAULT_STATE}"
UNIT_FILE="$UNIT_DIR/$SERVICE_NAME.service"

quote_systemd() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

render_unit() {
  local uv_bin
  uv_bin="$(command -v uv || true)"
  if [ -z "$uv_bin" ]; then
    echo "找不到 uv，请先安装 uv 并确保其在 PATH 中。" >&2
    exit 1
  fi

  local args=("$uv_bin" "run" "--no-sync" "python" "server.py")
  case "$MODE" in
    local)
      args+=(--host "$HOST" --port "$PORT" --state-dir "$STATE_DIR")
      ;;
    lan)
      if [ -z "$PUBLIC_URL" ]; then
        echo "内网服务需要提供 --public-url（或通过 make 的 LAN_HOST 指定），例如 https://192.168.1.5:8686" >&2
        exit 1
      fi
      args+=(--host "0.0.0.0" --port "$PORT" --self-signed --public-url "$PUBLIC_URL"
             --state-dir "$STATE_DIR" --auth "$AUTH" --session-days "$SESSION_DAYS")
      ;;
    public)
      if [ -z "$TLS_CERT" ] || [ -z "$TLS_KEY" ]; then
        echo "公网服务必须提供 --tls-cert 和 --tls-key。" >&2
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

  local exec_line=""
  local arg
  for arg in "${args[@]}"; do
    if [ -n "$exec_line" ]; then
      exec_line+=" "
    fi
    exec_line+="$(quote_systemd "$arg")"
  done

  cat <<EOF
[Unit]
Description=Turnline ($MODE)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=$exec_line
Restart=on-failure
RestartSec=3
EOF
  if [ -n "$PASSCODE_FILE" ]; then
    echo "Environment=TURNLINE_PASSCODE_FILE=$PASSCODE_FILE"
  fi
  cat <<EOF

[Install]
WantedBy=default.target
EOF
}

case "$ACTION" in
  render)
    render_unit
    ;;
  install)
    if [ "$MODE" != "local" ] && [ "$AUTH" = "passcode" ] && [ -z "$PASSCODE_FILE" ] && [ ! -f "$STATE_DIR/auth.json" ]; then
      echo "尚未为 $STATE_DIR 配置访问口令。请先运行：" >&2
      echo "  make auth-set STATE_DIR=$STATE_DIR" >&2
      exit 1
    fi
    unit_content="$(render_unit)"
    mkdir -p "$UNIT_DIR"
    printf '%s\n' "$unit_content" > "$UNIT_FILE"
    echo "已写入服务文件: $UNIT_FILE"
    systemctl --user daemon-reload
    systemctl --user enable --now "$SERVICE_NAME.service"
    echo "服务已启动: $SERVICE_NAME.service"
    echo "提示：如需注销 SSH 后保持后台常驻，可执行：loginctl enable-linger $USER"
    ;;
  uninstall)
    systemctl --user disable --now "$SERVICE_NAME.service" 2>/dev/null || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload
    echo "已卸载服务: $SERVICE_NAME.service"
    ;;
  status)
    systemctl --user status "$SERVICE_NAME.service" --no-pager
    ;;
  logs)
    exec journalctl --user -u "$SERVICE_NAME.service" -f
    ;;
  *)
    echo "Unknown action: $ACTION" >&2
    exit 2
    ;;
esac
