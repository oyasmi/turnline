# Web 连接与部署

在仓库根目录按[快速开始](../README.md#快速开始)准备依赖和模型，再启动服务。

```bash
uv run python server.py
```

Turnline 默认监听 `127.0.0.1:8686`，页面、语音 WebSocket、音频流和对话中转共用一个端口。跨设备访问时，用受浏览器信任的 HTTPS 提供页面和麦克风访问。

## 连接 PipiClaw

| 方式 | 连接路径 | 配置 |
| --- | --- | --- |
| 服务端中转 | 浏览器 → Turnline → 本机 PipiClaw | 默认使用 `~/.pipiclaw/state/webapi/api.sock`。以有权访问该 Socket 的用户运行 Turnline。 |
| 浏览器直连 | 浏览器 → PipiClaw | 在「通话设置 → 浏览器直连」填写 PipiClaw 地址和密钥，点击「测试并连接」。 |

浏览器直连适合 Turnline 已部署在外网、PipiClaw 只在浏览器所在网络可达的场景。可在 PipiClaw 主机上执行 `pipiclaw webapi key add turnline` 创建专用密钥。浏览器把地址保存在本地，把密钥保存在当前标签页的会话存储中。对话请求和密钥由浏览器直接发送给 PipiClaw，麦克风音频和待播报的回复片段仍由 Turnline 处理。

跨设备直连时，为 PipiClaw 的 TCP 入口配置受信 HTTPS，并允许来自 Turnline 页面来源的跨源请求。PipiClaw 与浏览器位于同一设备时，可以使用 `http://127.0.0.1:8787`。如果浏览器请求本地网络权限，请按提示允许。只提供直连的实例可用 `--direct-only` 启动。

## HTTPS 反向代理或隧道

把 HTTPS 入口转发到本机的 `http://127.0.0.1:8686`。入口应支持 WebSocket 升级，及时转发 SSE 和音频流，并保留浏览器的 `Host`。代理从回环地址连接 Turnline 时，也可覆盖 `X-Forwarded-Host` 与 `X-Forwarded-Proto`，以传递外部主机和协议。使用独立域名或端口，让 Turnline 在该来源的根路径提供服务。

**启用中转时，能访问 Turnline 入口的用户可以通过它操作本机 PipiClaw。** 仅向可信网络开放，或在外部入口配置访问控制。Turnline 的浏览器 Cookie 用于隔离中转会话。入口的访问控制由部署者配置。

单用户也可通过 SSH 本地端口转发访问远端。保持以下命令运行，在本机浏览器打开 <http://127.0.0.1:8686>。

```bash
ssh -N -L 8686:127.0.0.1:8686 user@turnline-host
```

## Turnline 直接提供 HTTPS

已有受信证书时，可向 Turnline 提供 PEM 证书链和私钥。

```bash
uv run python server.py --host 0.0.0.0 \
  --tls-cert /path/fullchain.pem --tls-key /path/privkey.pem
```

可信局域网里也可以自建 CA。此方式需要 OpenSSL 和支持 `fcntl` 的系统。把下列地址替换为设备实际访问的 IP 或主机名。

```bash
uv run python server.py --host 0.0.0.0 --self-signed \
  --public-url https://192.168.1.5:8686
```

把程序打印的 CA 证书导入访问设备的信任库，再打开该 HTTPS 地址。Turnline 会在状态目录中复用 CA 和有效的服务端证书。

## 配置与迁移

| 配置 | 用途 |
| --- | --- |
| `--host`、`--port` | 监听地址和端口。非回环监听要求 TLS。 |
| `--pipiclaw-socket`、`PIPICLAW_HOME` | 显式指定 Socket，或通过 PipiClaw 根目录定位 `state/webapi/api.sock`。 |
| `--state-dir`、`XDG_STATE_HOME` | 设置中转会话和本地证书的存放位置。默认使用 `~/.local/state/turnline/`，有 `XDG_STATE_HOME` 时使用其下的 `turnline/`。 |
| `--public-url`、`TURNLINE_PUBLIC_URL` | 设置启动时显示的访问地址，也用于确定自建证书覆盖的主机。 |
| `--direct-only` | 禁用 PipiClaw 中转。 |
| `--tts-threads` | 设置合成线程数，默认为 2。 |
| `--demo` | 仅在回环地址提供独立演示。 |

从旧布局升级时，把启动脚本和服务的工作目录从 `web/` 改到仓库根目录，在根目录执行 `uv sync --locked --python 3.13` 重建 Python 环境。可将旧的 `web/models/` 移到 `models/` 复用模型。保留相同的访问地址和状态目录可继续访问原有的中转会话。

若麦克风不可用，先检查访问地址的 HTTPS 信任状态与浏览器麦克风权限。若中转显示离线，检查 PipiClaw Web API 和 Socket 权限。若界面本身正常但语音模型加载失败，重新运行 `uv run python setup_models.py` 并查看服务日志。命令行参数可用 `uv run python server.py --help` 查看。
