# Turnline

Turnline 是一个用于个人通话的 Web 语音助手原型。浏览器负责录音、界面和播放。Python 服务用 sherpa-onnx 跑 Silero VAD、SenseVoice-Small INT8 和语音合成。浏览器通过 Responses API 向 Pipiclaw 或其他兼容后端发送文本。

## 启动

```bash
cd ~/projects/turnline
uv sync --locked --python 3.13
uv run python setup_models.py
uv run python server.py
```

用 Chrome 或 Edge 打开 <http://127.0.0.1:4173>，点「开始通话」并允许麦克风。下载脚本将模型安装到 `models/`，并校验发布包的 SHA-256。

默认音色用 Matcha 快速播报中文，遇到含英文字母的段落时用 Kokoro 保留英文和专名，切换段落时音色可能有变化。首次用到 Kokoro 时才加载它。想让整轮使用同一种声音，可在设置中选择 Kokoro 音色。只安装原有的 Kokoro 模型也能启动；若要只下载 Kokoro，在 `setup_models.py` 和 `server.py` 后都加 `--tts-engine kokoro`。

默认使用本地演示，无需密钥。可以说「你好」并继续追问以验证多轮对话，说「说慢一点」以测试打断，说「告诉我进度」以区分正文和进度。文字输入也可以单独验证 Responses 流。

## 接入文本后端

在「连接设置」填写 Base URL、模型和密钥。连接本机 Pipiclaw 时可点击预设并填入 Web API key，对应 `http://127.0.0.1:8787/v1` 和 `pipiclaw` 模型。远程 Responses 地址使用 HTTPS，并允许浏览器通过 CORS 访问。密钥只在当前页面内存里保留。

通用模式每轮带最近的文本历史。后端会话模式首轮创建 `/v1/conversations`，后续复用会话 ID。通话期间每轮通过 `instructions` 设置通话语气，通话中打字也走这条路径。挂断后可以在同一会话里继续文字交流。点「新对话」或切换后端会从新会话开始。

语音传到 Turnline 所在主机的 Python 进程，进程处理完即丢弃音频。Responses 后端只收到文本。默认监听回环地址。将 Python 放到另一台机器时，个人原型可以用 SSH 本地端口转发访问。正式开放访问需要给 Turnline 自身提供 HTTPS 和访问控制。

## 验证项目

- **连续对话**。说完后按所选的静音时间自动断句。默认播报期间暂停识别，播完恢复。实验性语音插话可在连接设置打开，适合先用耳机验证。
- **打断**。开口时先暂停播报。仅识别到「嗯」一类的附和就接着播，识别到新问题或指令才取消旧回合。手动点「打断」会立即取消。下一轮会带上最后完整播完的一句。Python 会在推理批次之间响应取消。远端任务是否停止由 Responses 后端决定。
- **播报时机**。默认只播类别已确认的正文。「分句即时播报」可以边接收 SSE 边播报。Pipiclaw 部分进度输出会在完整后改成进度类别，即时模式可能先读出这些内容。
- **后台结果**。使用 Pipiclaw 的「后端会话」时，Turnline 会读取新到的会话消息。完整内容显示在对话记录，通话空闲时播报第一句。挂断后继续显示文字。普通前台回复会按消息 ID 去重。
- **英文专名**。技术词的专用读音可加到项目自带的 `kokoro-lexicon.txt`，重启 Turnline 加载。词表外的英文会退回逐字母播报。
- **延迟**。「语音链路明细」查看后端排队、首字到可播、合成排队、首块 PCM 和累计播报间隙。首声以浏览器播放调度估算，插话暂停从浏览器收到语音开始事件计时。物理设备延迟需要实测。

## 开发验证

[测试与评估手册](docs/testing.md) 包含可交给测试 Agent 的启停步骤、素材生成、通话用例和本机 Pipiclaw 联调方法。

运行服务只需要 Python。Node.js 和 Playwright 用于协议及 Chromium 自动化检查。

```bash
npm ci
# 仅当缺少 Playwright Chromium 时，安装这一个无界面浏览器
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install --only-shell chromium
uv run --no-sync python -m unittest discover -s test
npm test
npm run test:browser
```

浏览器检查用同一 Python 服务合成一段普通话并接入虚拟麦克风，验证收音、识别、Responses 流、流式播报和插话。麦克风、耳机和外放回声需要手动验证。模型对比和回归数据见 [测试报告](docs/test-results.md)。

## 开源参考

- [Pipecat](https://github.com/pipecat-ai/pipecat) 是 BSD-2-Clause 的 Python 实时语音框架，支持 Python 语音模型、WebRTC 传输、轮次策略和控制帧。Turnline 借鉴把语音开始、轮次结束和取消输出拆开的做法。语音一开始就停掉旧回复，等 VAD 确认断句后才发出新文本。[Pipecat 轮次策略](https://docs.pipecat.ai/api-reference/server/utilities/turn-management/user-turn-strategies) 还提供 Smart Turn，可用于后续对比短暂停顿时的误断句。对于本机或近端验证，Turnline 用单进程和简单的 WebSocket 音频上传。远程弱网语音可用 Pipecat 的 [SmallWebRTC](https://docs.pipecat.ai/client/concepts/choosing-a-transport) 作对照。
- [pipecat-voice-agents](https://github.com/LPK3215/pipecat-voice-agents) 的 MIT 子项目把 SenseVoice 和 Kokoro 放在 Python 运行，也演示了独立的语音模块连接外部代理。
- [Hugging Face speech-to-speech](https://github.com/huggingface/speech-to-speech) 有可替换的 SenseVoice 和 Kokoro 模块，以及浏览器通话和分段延迟测量。它的浏览器端使用 Realtime 语音协议。
- [inbrowser-ai](https://github.com/Superactive-AI/inbrowser-ai) 是浏览器端推理的对照，用 WebGPU 跑 Whisper 和 Kokoro，也能从 OpenRouter 接收文本。
- [Kokoro INT8 的 WASM 问题](https://github.com/k2-fsa/sherpa-onnx/issues/3960) 能在旧的浏览器路线复现，合成结果可能出现 NaN。本项目使用 Python 原生运行时。该问题也值得在 Android 目标设备上单独复测。
