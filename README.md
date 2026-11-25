# Turnline

Turnline 是为 [PipiClaw](https://github.com/oyasmi/pipiclaw) 打造的本地语音通话与文字对话界面。打开浏览器即可发起通话——语音识别与合成全部运行在你自己的机器上，无需云端语音服务，挂断后也能在同一会话里无缝切回打字。

## 为什么用 Turnline

- **自然轮次，随说随播**：自动感知句中停顿与说话结束，实时呈现字幕，边生成回复边流式播报；也支持随时打断或切换为「按住说话」。
- **中英同声，本地合成**：在普通 CPU 上完成本地识别与合成，用同一副音色自然朗读中文、英文与中英混排，代码术语、版本号和数字同样清晰。
- **语音与文字同一会话**：对话记录统一保存在 PipiClaw。通话中可随时打字或静音阅读，挂断后仍可查看后台任务结果、翻阅历史会话并继续追问。
- **单端口运行，多端可用**：Web 版作为主形态，支持桌面与手机浏览器（可安装为 PWA）；仓库同时附带独立可用的原生 Android 客户端。

## 快速开始

开始前请准备 [uv](https://docs.astral.sh/uv/)，以及 Chrome 或 Edge 浏览器。在仓库根目录运行：

```bash
make setup
make demo
```

首次运行会安装 Python 依赖，并将语音模型下载到 `models/`（也可直接执行 `uv sync --locked --python 3.13 && uv run python setup_models.py && uv run python server.py --demo`）。服务启动后，打开 <http://127.0.0.1:8686> 即可在演示模式下发送文字，或点击「开始通话」体验完整语音交互。

### 连接本机 PipiClaw

启动本机 PipiClaw 的 Web API 后，直接运行：

```bash
make run
```

运行 `make`（或 `make help`）可查看全部快捷命令，包括内网/公网 HTTPS 部署、口令管理、systemd 后台服务安装、自动化测试与 Android 构建。Turnline 默认通过本机 Unix Socket 自动中转，无需额外配置。如果你希望由浏览器直接连接远端或独立部署的 PipiClaw，可在页面右上角「通话设置」中切换到「浏览器直连」。

> 手机、局域网或公网访问 Web 版时，浏览器要求使用受信任的 HTTPS 才能开启麦克风，且建议使用内置的 `--auth passcode` 访问控制保护服务。配置方式见 [连接与部署](docs/deployment.md)。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [Web 使用手册](docs/web-usage.md) | 通话操作、断句与播报设置、文字与历史会话、口令解锁与退出、快捷键及诊断工具 |
| [连接与部署](docs/deployment.md) | 本机中转、浏览器直连、反向代理、SSH 隧道、HTTPS 证书、口令访问控制与启动参数 |
| [Android 使用与构建](docs/android.md) | Android 独立客户端的连接方式、离线双语播报及 APK 构建 |
| [项目架构](docs/architecture.md) | 仓库结构、语音与对话数据流、会话存储边界与双语发音链路 |
| [测试手册](docs/testing.md) | 自动化回归、延迟与回声测试、实机验收清单与计时口径 |

历史背景材料：[历史验证记录](docs/test-results.md) · [语音合成选型调研](docs/research/tts-selection.md)
