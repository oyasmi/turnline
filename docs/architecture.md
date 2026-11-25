# 项目架构

Turnline 以浏览器 Web 应用为主形态，同端口承载静态界面、本地语音识别与合成以及 PipiClaw 对话中转；同时在 `clients/android/` 维护一套共享模型资产的原生 Android 客户端。

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `server.py`、`setup_models.py` | 服务启动与本地语音模型下载校验入口 |
| `turnline/` | FastAPI 服务、PipiClaw 中转、断句引擎、双语音素化与合成调度 |
| `public/` | 无构建原生 ES Module 前端、Web Audio 采集/播放管线与 PWA 资源 |
| `clients/android/` | 独立运行的原生 Kotlin / Jetpack Compose Android 客户端 |
| `test/` | Python 单元测试、Node 协议测试、Playwright 浏览器语音与界面截图回归 |
| `models/` | 本地下载的语音模型缓存（不纳入版本库，Web 与 Android 共享） |
| `docs/` | 使用、部署、架构、测试手册及早期调研与验证记录 |

## Web 语音与对话流

`server.py` 启动 `turnline/server.py` 中的 FastAPI 应用。浏览器直接加载 `public/` 中的原生模块（Node.js 仅用于开发测试，无打包构建步骤）。一轮完整的语音交互沿以下三条链路流转：

```text
麦克风 (Web Audio) ──/speech/voice (WS)──▶ TurnEngine + Silero VAD + SenseVoice-Small
                                                              │ 转写提交
对话面板 (SSE) ◀── /api/pipiclaw 或直连 ◀─────── 浏览器发起 Responses 请求
     │ 可播短分句
     └── /speech/synthesize (流式 PCM) ──▶ MatchaFrontend (pypinyin + eSpeak NG) ──▶ Matcha + Vocos
```

1. **收音与断句**：浏览器通过 `AudioWorklet` 采集麦克风并重采样，经 `/speech/voice` WebSocket 送入服务端。`voice_session.py` 与 `turn_engine.py` 结合 `speech.py` 中的 Silero VAD 与 SenseVoice-Small，在采集采样时钟上完成实时草稿字幕、句中停顿合并、自适应等待与最短有效语音过滤，最终触发整轮提交。
2. **对话请求与流式更新**：浏览器将提交的转写文字或手动输入组织为 Responses API 请求，接收 SSE 事件并实时刷新界面。
   - **服务端中转（默认）**：经 `turnline/connection.py` 通过本机 Unix Socket 转发至 PipiClaw。
   - **浏览器直连**：浏览器直接携带用户配置的 PipiClaw 地址与密钥发起请求。
   - **演示模式（`--demo`）**：由服务内置的 `/demo/v1/responses` 生成模拟事件流。
3. **双语音素化与流式播报**：浏览器将回复切分为可播短句并请求 `/speech/synthesize`。`phonemizer.py` 先对文本做口语清洗与结构化展开（如百分比、容量单位、版本号与混合型号），再分别用中文归一化 + `pypinyin` 和英文 `eSpeak NG` 生成统一的音素序列；`synthesis.py` 调度 Matcha 与 Vocos 以同一副音色流式输出 PCM，由浏览器播放并负责逐句高亮与打断控制。

> 关于为何采用自建双语音素前端搭配 Matcha，背景调研见 [语音合成选型](research/tts-selection.md)。

## 会话存储与安全边界

- **对话正文**：始终保存在 PipiClaw 侧，Turnline 不复制完整聊天内容。
- **服务端中转隔离**：Turnline 在状态目录（默认 `~/.local/state/turnline/`）使用 `devices.sqlite3` 维护匿名浏览器身份与会话归属，并通过 `HttpOnly` + `SameSite=Strict` 会话 Cookie 校验权限。
- **浏览器直连隔离**：浏览器按 PipiClaw 地址在 `localStorage` 中记住打开过的会话 ID，页面偏好同样保存在 `localStorage`；API 密钥仅保存在当前标签页的 `sessionStorage`，关闭标签页即失效。
- **语音隐私边界**：Web 版的麦克风音频与待播报文本由 Turnline 服务端本地处理，PipiClaw 只接收转写后的文字消息。服务端通过同源检查与 CSP 限制接口仅对 Turnline 页面开放。

## Android 客户端

`clients/android/` 是基于 Kotlin 与 Jetpack Compose 的独立应用，直接与 PipiClaw 或兼容 Responses API 的后端通信，不依赖 Turnline Python 服务。语音识别调用 Android 系统服务，播报可在系统语音与 APK 内置的 Matcha + Vocos 之间切换。

构建时，Android 的 Gradle 任务通过 `clients/android/prepare_matcha.py` 复用 `turnline/setup_models.py` 与 `turnline/pronunciation.py` 中的模型清单与发音规则，直接共享仓库根目录的 `models/` 缓存并将运行库和模型打入 APK。构建完成后，应用只需手机与对话后端即可独立运行。
