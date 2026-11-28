# 连接与部署

在仓库根目录按 [快速开始](../README.md#快速开始) 准备好依赖与模型后，即可启动服务：

```bash
make run
# 等价命令：uv run python server.py
```

Turnline 默认监听 `127.0.0.1:8686`，页面、语音 WebSocket、流式音频和 PipiClaw 中转共用同一个端口。本机回环地址可直接通过 HTTP 使用麦克风；若要从手机或局域网内的其他设备访问，浏览器要求必须通过受设备信任的 HTTPS 提供服务。

## 连接 PipiClaw 的两种方式

| 方式 | 数据流向 | 适用场景与配置 |
| --- | --- | --- |
| **服务端中转（默认）** | 浏览器 → Turnline → 本机 PipiClaw | Turnline 与 PipiClaw 运行在同一台机器。默认连接 `~/.pipiclaw/state/webapi/api.sock`，只需确保运行 Turnline 的系统用户有权访问该 Socket。 |
| **浏览器直连** | 浏览器 → PipiClaw（语音仍经 Turnline） | Turnline 部署在外网或另一台主机，而 PipiClaw 仅在浏览器所在网络可达。在「通话设置 → 浏览器直连」中填入 PipiClaw 地址与密钥，点击「测试并连接」。 |

关于浏览器直连的几点说明：

- **生成专用密钥**：在 PipiClaw 主机上运行 `pipiclaw webapi key add turnline`。
- **凭据存储与隐私**：浏览器将 PipiClaw 地址存于 `localStorage`，密钥仅存于当前标签页的 `sessionStorage`（关闭标签页即清除）。对话正文和密钥由浏览器直接发往 PipiClaw；麦克风音频与待播报的回复片段仍由 Turnline 服务端本地处理。
- **跨源与 HTTPS**：跨设备直连时，需为 PipiClaw 的 TCP 入口配置受信任的 HTTPS，并在 CORS 中允许 Turnline 页面来源。若 PipiClaw 与浏览器在同一设备上，可直接使用 `http://127.0.0.1:8787`（按浏览器提示允许本地网络访问）。
- **纯直连部署**：若实例不接本机 PipiClaw，运行 `make direct`（或加 `--direct-only`）即可关闭中转并默认进入直连页面。

## 跨设备访问方案

根据使用场景选择合适的访问方式：

| 方案 | 适用场景 | 证书要求 | 推荐命令 / 入口 |
| --- | --- | --- | --- |
| **SSH 端口转发** | 单人电脑远程访问，最省事 | 无需证书（走本机 `127.0.0.1`） | `ssh -N -L 8686:127.0.0.1:8686 ...` |
| **内置 HTTPS（局域网）** | 手机或同网段设备访问 | 自动签发本地 CA，需导入设备信任 | `make run-lan` / `make start MODE=lan` |
| **内置 HTTPS（公网）** | 单进程直接对外提供服务 | 正式 PEM 证书（如 Let's Encrypt） | `make run-public` / `make start MODE=public` |
| **HTTPS 反向代理 / 隧道** | 已有 Nginx、Caddy 或内网隧道 | 由代理层统一管理 | 反代至 `http://127.0.0.1:8686` |

### 方案一：SSH 本地端口转发（单人远程最简）

只需本机电脑访问远端 Turnline 时，不必折腾证书，建立端口转发后直接在本机浏览器打开 <http://127.0.0.1:8686>：

```bash
ssh -N -L 8686:127.0.0.1:8686 user@turnline-host
```

### 方案二：Turnline 直接提供 HTTPS（推荐单进程内网 / 公网部署）

Turnline 可直接提供 HTTPS 与内置口令访问控制，无需额外部署 Caddy 或 Nginx。仓库根目录的 `Makefile` 已封装好常用命令（运行 `make` 查看完整参数）：

1. **内网 / 局域网部署**（自动检测本机局域网 IP，签发本地自签证书并开启口令保护，状态目录默认 `~/.local/state/turnline-lan`）：

```bash
# 首次设置内网实例口令（至少 8 位）
make auth-set STATE_DIR=~/.local/state/turnline-lan

# 前台启动（也可显式指定 LAN_HOST=192.168.1.5 或 AUTH=none）
make run-lan
```

启动后，终端会打印本地 CA 证书路径。将该 CA 证书导入手机或电脑的系统信任库后，即可正常打开该 HTTPS 地址并使用麦克风。后续重启会自动复用状态目录中的 CA 与有效证书。

2. **公网部署**（使用受信任的 PEM 证书链与私钥，如 Let's Encrypt，自动开启 HSTS，状态目录默认 `~/.local/state/turnline-public`，默认会话有效期 14 天）：

```bash
# 首次设置公网实例口令
make auth-set STATE_DIR=~/.local/state/turnline-public

# 前台启动
make run-public \
  TLS_CERT=/etc/letsencrypt/live/your.domain/fullchain.pem \
  TLS_KEY=/etc/letsencrypt/live/your.domain/privkey.pem
```

等价的底层启动命令：

```bash
uv run python server.py --host 0.0.0.0 --port 8686 \
  --tls-cert /path/fullchain.pem --tls-key /path/privkey.pem \
  --state-dir ~/.local/state/turnline-public \
  --auth passcode --session-days 14
```

### 方案三：HTTPS 反向代理或隧道

将 Nginx、Caddy 或内网隧道的 HTTPS 入口转发到本机 `http://127.0.0.1:8686`，并满足以下条件：

- 支持 WebSocket 升级（`/speech/voice`）。
- 关闭或避免响应缓冲，以便及时转发 SSE 事件流和 PCM 音频流。
- 保留原始 `Host` 头；当代理从回环地址连接 Turnline 时，也可通过 `X-Forwarded-Host` 与 `X-Forwarded-Proto` 传递外部主机和协议。
- 为 Turnline 分配独立域名或端口，挂载在根路径 `/` 下。

> **安全提示**：启用服务端中转时，任何能够访问 Turnline 入口的人都可以借此操作本机 PipiClaw。Turnline 默认的匿名浏览器 Cookie 仅用于隔离不同浏览器的会话。暴露到局域网或公网时，请启用内置的 `--auth passcode` 访问控制（或在反向代理层配置访问控制）。

## 后台常驻运行

可通过 `Makefile` 与 `scripts/service.sh` 直接在后台启停 Turnline，支持 `MODE=local|lan|public`。各模式在各自的 `state-dir` 内独立维护 `turnline.pid` 与 `turnline.log`，可同机并存且互不干扰：

```bash
# 后台启动内网实例（自动检测本机 IP，也可显式传 LAN_HOST=192.168.1.5）
make start MODE=lan

# 后台启动公网实例（使用独立端口与状态目录）
make start MODE=public PUBLIC_PORT=8687 \
  TLS_CERT=/etc/letsencrypt/live/your.domain/fullchain.pem \
  TLS_KEY=/etc/letsencrypt/live/your.domain/privkey.pem

# 查看状态 / 实时日志 / 重启 / 停止
make status MODE=public
make logs MODE=public
make restart MODE=public PUBLIC_PORT=8687 TLS_CERT=... TLS_KEY=...
make stop MODE=public
```

## 访问控制与会话管理

启用 `--auth passcode` 后，未解锁的浏览器只能访问静态页面，所有 PipiClaw 中转接口与语音接口（含 WebSocket）均会被拦截；登录接口内置单 IP 渐进锁定与全局防爆破保护。同一实例的口令代表同一个所有者，所有已解锁设备可查看并操作共享的中转会话；退出或吊销设备仅收回登录权限，已保存的会话仍可从其他已解锁设备访问。

```bash
# 查看口令配置状态与当前已认证会话数（也可直接用 uv run python server.py auth ...）
make auth-status STATE_DIR=~/.local/state/turnline-public

# 设置或修改访问口令（至少 8 位，修改会自动吊销所有旧会话）
make auth-set STATE_DIR=~/.local/state/turnline-public

# 一键吊销所有已登录设备（设备丢失时使用）
make auth-revoke STATE_DIR=~/.local/state/turnline-public
```

也支持通过环境变量 `TURNLINE_PASSCODE_FILE`（推荐，后台启动时可传 `PASSCODE_FILE=/path/to/passcode`）或 `TURNLINE_PASSCODE` 提供口令，优先级高于状态目录中的 `auth.json`。

## 启动参数与环境变量

完整参数可用 `uv run python server.py --help` 查看，常用项如下：

| 参数 / 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `--host`、`--port` | `127.0.0.1`、`8686` | 监听地址与端口。监听非回环地址时必须提供 TLS 证书或 `--self-signed`，且必须显式指定 `--auth`。 |
| `--tls-cert`、`--tls-key` | 无 | 直接提供 HTTPS 时使用的 PEM 证书链与私钥（需成对传入，自动开启 HSTS）。 |
| `--self-signed` | 关闭 | 使用本地 Turnline CA 自动签发 HTTPS 证书，配合 `--public-url` 指定主机名。 |
| `--auth` | 回环默认 `none` | 访问控制模式，可选 `none` 或 `passcode`。非回环监听时必须显式指定。 |
| `--session-days` | `30` | `--auth passcode` 模式下已认证 Cookie 的有效期（1–365 天，支持滑动续期）。 |
| `TURNLINE_PASSCODE_FILE` / `TURNLINE_PASSCODE` | 无 | 可选环境变量口令来源，覆盖状态目录中的 `auth.json`。 |
| `--pipiclaw-socket` / `PIPICLAW_HOME` | `~/.pipiclaw/state/webapi/api.sock` | 显式指定 Socket 路径，或通过 `PIPICLAW_HOME` 定位 `state/webapi/api.sock`。 |
| `--state-dir` / `XDG_STATE_HOME` | `~/.local/state/turnline/` | 存放会话数据库、口令哈希 `auth.json` 与本地自签证书；设置 `XDG_STATE_HOME` 时落于其 `turnline/` 子目录。 |
| `--public-url` / `TURNLINE_PUBLIC_URL` | 无 | 指定启动日志中显示的访问地址，也作为 `--self-signed` 签发证书的主机名来源。 |
| `--direct-only` | 关闭 | 禁用服务端 PipiClaw 中转，仅提供浏览器直连。 |
| `--tts-threads` | `2` | 语音合成推理线程数。 |
| `--demo` | 关闭 | 仅限回环地址的独立演示模式，不连接 PipiClaw。 |

## 常见问题排查

- **麦克风无法开启**：确认访问地址是 `localhost` / `127.0.0.1` 或受设备信任的 HTTPS，并检查浏览器站点权限。使用局域网自签证书时，需将服务端打印的 CA 证书导入设备信任库（部分手机浏览器在导入后需重启浏览器生效）。
- **页面提示中转离线**：确认本机 PipiClaw Web API 正在运行，且 Turnline 进程对 `api.sock` 具备读写权限。
- **界面正常但语音无法识别或播报**：重新运行 `make models`（或 `uv run python setup_models.py`）校验模型文件，并检查服务端日志。
- **忘记访问口令**：直接在服务端运行 `make auth-set STATE_DIR=<你的状态目录>` 重新设置即可，新口令会立即生效并吊销旧会话。
- **从早期 `web/` 目录布局升级**：将启动脚本的工作目录改回仓库根目录并重新执行 `uv sync --locked --python 3.13`；原有的 `web/models/` 可直接移动到根目录 `models/` 复用，保留原访问地址与状态目录即可无缝延续旧的中转会话。
