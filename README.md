# Turnline

Turnline 是面向 PipiClaw 的语音通话和文字对话界面。主实现是 Web，在服务端 CPU 上用 SenseVoice-Small 转写麦克风音频，并用 Matcha 和 Vocos 以同一个音色播报中文、英文和中英混读。浏览器可以自动断句、按住说话、打断播报，也可以在挂断后回到同一会话继续打字。

## 快速开始

准备 [uv](https://docs.astral.sh/uv/) 和 Chrome 或 Edge。在仓库根目录执行以下命令。首次安装会下载 Python 依赖和语音模型，模型保存在 `models/`。

```bash
uv sync --locked --python 3.13
uv run python setup_models.py
uv run python server.py --demo
```

打开 <http://127.0.0.1:8686>。可以先发送一条文字，或点击「开始通话」并允许访问麦克风。演示模式使用内置回复，可独立体验语音和界面。

连接同机 PipiClaw 时，启动其 Web API，再用 `uv run python server.py` 启动 Turnline。默认由 Turnline 通过本机 Unix Socket 转发。也可以在「通话设置」中选择「浏览器直连」，填写 PipiClaw 地址和密钥。局域网手机访问 Web 版需要受设备信任的 HTTPS。详见[连接与部署](docs/deployment.md)。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `server.py`、`setup_models.py` | Web 启动和语音模型下载入口 |
| `turnline/` | Python 服务、PipiClaw 中转和语音处理 |
| `public/` | 浏览器界面、音频处理和 PWA 静态资源 |
| `test/` | Python、JavaScript 和浏览器测试，以及界面截图基线 |
| `clients/android/` | 可独立使用的 Android 客户端，支持 Android 12 及以上 |
| `docs/` | 使用、部署、架构、测试和语音选型文档 |

## 文档

- [Web 使用手册](docs/web-usage.md)介绍通话、快捷键和历史会话。
- [连接与部署](docs/deployment.md)涵盖本机中转、浏览器直连、HTTPS 和隧道转发。
- [Android 使用与构建](docs/android.md)介绍连接 PipiClaw 或通用 Responses API、本机语音和 APK 构建。
- [项目架构](docs/architecture.md)说明音频、对话请求和历史数据的流向。
- [测试手册](docs/testing.md)记录开发验证命令和实机检查方法，[历史验证记录](docs/test-results.md)保留各阶段测试结果。
- [语音合成选型](docs/research/tts-selection.md)收录早期调研、原始笔记和试听样本。
