# Turnline

Turnline 是为 [PipiClaw](https://github.com/oyasmi/pipiclaw) 打造的本地语音通话与文字对话界面。打开浏览器即可发起通话——语音识别与合成全部运行在你自己的机器上，无需云端语音服务；挂断或刷新后也能在同一会话里无缝切回打字并继续查看任务进展。

## 核心特性

- **自然轮次，随时插话**：自动感知句中停顿与说话结束，实时显示字幕，边生成回复边流式播报；支持随时打断、工作进行中补充指令，或切换为「按住说话」。
- **中英同声，本地合成**：在普通 CPU 上完成本地识别（SenseVoice）与合成（Matcha + Vocos），用同一副音色自然朗读中文、英文与中英混排，版本号、单位与代码术语同样清晰。
- **语音与文字同一会话**：对话记录统一保存在 PipiClaw。通话中可随时打字或静音阅读，挂断、刷新或切换会话不会中断正在执行的任务，重新打开即可继续接收进展。
- **单端口部署，多端可用**：Web 版作为主形态，内置直出 HTTPS、自签证书与口令访问控制，支持桌面与手机浏览器（可安装为 PWA）；仓库同时附带可独立运行的原生 Android 客户端。

## 快速开始

开始前请准备 [uv](https://docs.astral.sh/uv/)，以及 Chrome 或 Edge 浏览器。

### 1. 安装依赖并体验演示模式

无需安装 PipiClaw，在仓库根目录运行即可体验完整语音与文字交互：

```bash
make setup
make demo
```

首次运行会安装 Python 依赖并将本地语音模型下载到 `models/`（等价命令：`uv sync --locked --python 3.13 && uv run python setup_models.py && uv run python server.py --demo`）。启动后打开 <http://127.0.0.1:8686>，点击「开始通话」或直接发文字即可体验。

### 2. 连接本机 PipiClaw

启动本机 PipiClaw Web API 后，运行：

```bash
make run
```

Turnline 默认通过本机 Unix Socket 自动中转，无需额外配置。如需由浏览器直接连接远端或独立部署的 PipiClaw，可在页面右上角「通话设置」中切换到「浏览器直连」。

### 3. 手机、局域网或公网访问

跨设备访问 Web 版时，浏览器要求使用受信任的 HTTPS 才能开启麦克风，且建议使用内置口令访问控制保护服务：

```bash
# 首次设置访问口令，随后在局域网后台启动（自动签发本地 HTTPS 证书）
make auth-set STATE_DIR=~/.local/state/turnline-lan
make start MODE=lan
```

运行 `make`（或 `make help`）可查看全部快捷命令（公网证书部署、口令管理、后台启停、自动化测试与 Android 构建）。详细步骤见 [连接与部署](docs/deployment.md)。

## 文档导航

### 用户文档

| 文档 | 内容 |
| --- | --- |
| [Web 使用手册](docs/web-usage.md) | 发起与控制通话、中途补充与停工、通话设置、文字与历史会话、口令解锁、快捷键及通话诊断 |
| [连接与部署](docs/deployment.md) | 服务端中转与浏览器直连、SSH 转发、反向代理、内置 HTTPS 与口令保护、后台常驻与启动参数 |
| [Android 使用与构建](docs/android.md) | 独立 Android 客户端连接方式、后台通话与离线中英播报、设置说明及 APK 构建 |

### 开发与参考

| 文档 | 内容 |
| --- | --- |
| [项目架构](docs/architecture.md) | 仓库结构、语音与对话数据流、会话存储与安全边界、双语发音链路 |
| [测试手册](docs/testing.md) | 自动化回归、延迟与回声专项压测、实机验收清单与诊断计时口径 |

历史背景材料：[历史验证记录](docs/test-results.md) · [语音合成选型调研](docs/research/tts-selection.md)
