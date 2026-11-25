# 项目架构

## Web

`server.py` 启动 `turnline/server.py` 中的 FastAPI 服务。它同端口提供 `public/` 中的静态页面、语音 WebSocket、音频响应和 PipiClaw 中转。浏览器直接加载 JavaScript 模块，Node.js 用于运行开发测试。

1. 浏览器通过 Web Audio 采集麦克风。音频重采样后，经 `/speech/voice` WebSocket 发给 Turnline。`voice_session.py` 和 `turn_engine.py` 管理收音、实时字幕、断句和提交，`speech.py` 使用 Silero VAD 和 SenseVoice-Small 处理语音。
2. 浏览器将提交后的转写文本或用户输入发为 Responses 请求，收到 SSE 后更新记录。中转模式经 `turnline/connection.py` 连接 PipiClaw 本机 Socket，直连模式由浏览器使用配置的 PipiClaw 地址和密钥。演示模式走内置回复。
3. 浏览器按可播片段请求合成。`phonemizer.py` 将数字、中文和英文转换为 Matcha 所需的音素，`synthesis.py` 调度生成并返回流式 PCM。浏览器负责播放、播报高亮和打断。

## 会话数据

- 对话正文保存在 PipiClaw。中转模式在 Turnline 的状态目录用 `devices.sqlite3` 记录浏览器身份和会话归属。浏览器携带会话 Cookie，服务端按归属查询和恢复对话。
- 直连模式按配置的 PipiClaw 地址在浏览器记录打开过的会话 ID，再向 PipiClaw 读取内容。密钥使用标签页会话存储，界面和通话偏好使用本地存储。
- Web 的原始语音和待播报文本由 Turnline 服务处理，PipiClaw 接收转写文本和其他文字消息。浏览器地址变化时，浏览器按新的站点来源管理麦克风权限和本地数据。

## Android

`clients/android/` 是原生 Kotlin 和 Jetpack Compose 项目，手机直接连接 PipiClaw 或兼容的 Responses API。语音识别使用 Android 系统服务，播报可选系统语音或 APK 内置的 Matcha 与 Vocos。

两个客户端复用 `turnline/setup_models.py` 定义的模型来源和仓库根目录的 `models/` 缓存。Android 的 Gradle 任务通过 `prepare_matcha.py` 准备 AAR、模型和词表，再打包进 APK。Android 的构建依赖仓库的共享文件，使用时只需手机和配置好的对话服务。
