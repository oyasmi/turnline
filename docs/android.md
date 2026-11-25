# Android 使用与构建

Turnline Android 是独立运行的原生客户端，支持 **Android 12 及以上**，采用 Kotlin 与 Jetpack Compose 编写，自动适配系统深色模式。手机直接与 PipiClaw 或任意兼容的 Responses API 通信，语音播报既可用系统语音，也内置了可离线运行的 Matcha 中英双语模型。

## 连接服务

首次打开应用，点击「连接服务」并选择后端类型：

| 模式 | 必填项 | 会话行为 |
| --- | --- | --- |
| **PipiClaw** | 服务地址、API 密钥 | 沿用 PipiClaw 服务端会话与工位上下文；前台空闲时自动同步当前会话的后台任务结果。 |
| **Responses API** | 服务地址、模型 ID、API 密钥 | 对话保存在手机本地，每轮携带近期文字上下文向 `POST /responses` 发起流式请求（也兼容非流式 JSON 返回）。 |

地址支持填写主机、Base URL 或完整端点，例如 `http://192.168.1.5:8787`、`http://192.168.1.5:8787/v1` 和 `http://192.168.1.5:8787/v1/responses` 均指向同一服务。HTTPS 遵循 Android 系统默认证书信任规则；HTTP 为明文传输，仅建议在可信局域网内使用。

### 局域网连接本机 PipiClaw

PipiClaw 默认只监听回环地址。若要让同一局域网下的手机连接：

1. 编辑 `~/.pipiclaw/channel.json`，将 `webapi.tcp` 改为电脑的局域网地址（例如 `192.168.1.5:8787`），保留其余配置并重启 PipiClaw。
2. 为手机生成专用密钥（默认授权 `default` 工位）：

```bash
pipiclaw webapi key add turnline-android
```

3. 在手机端填入 `http://192.168.1.5:8787/v1` 与刚生成的密钥，点击测试连接即可。PipiClaw 侧的完整配置见 [PipiClaw Web API 文档](https://github.com/oyasmi/pipiclaw/blob/master/docs/webapi.md)。

> PipiClaw 模式的连接测试仅检查鉴权与模型端点；通用 Responses API 模式的测试会向目标模型发送一条简短请求。

## 通话与文字对话

- **开始通话**：点击麦克风即可开麦。说完稍作停顿，应用会自动发送转写文字，读完回复后自动续听。播报中可随时点「打断」跳过朗读或停止等待，点「挂断」退回当前会话的文字输入页。
- **识别方式**：默认为「仅离线」，调用 Android 系统离线语音识别（需设备支持并安装对应离线语音包）；也可切换为「系统识别」，使用手机默认语音服务（可能涉及在线识别）。无论哪种模式，后端收到的始终是转写后的文字。离开应用时会自动释放麦克风与播报资源。
- **文字与历史**：点右上角历史图标可切换过往对话或开启新会话。PipiClaw 的后台更新会自动进入对话记录。聊天页支持选中复制和单条消息重读。
- **数据与断网处理**：API 密钥由 Android Keystore 加密保护；历史记录存放在应用本地数据库并按服务配置隔离（删除本地记录不会影响远端）。回复流入期间若网络中断，已收到的内容会完整保留，你可以将未成功的输入放回输入框重试，应用不会擅自重发。

### 开启内置 Matcha 双语播报

前往 **连接与语音 → 语音 → 播报引擎**，选择 **Matcha · 中英双语** 并点击「保存并返回」。此后通话回复与单条朗读均会使用随 APK 打包的 Matcha 与 Vocos，在手机端完全离线合成中文、英文与中英混读（首次播报会短暂加载模型）。默认选项为「系统播报」，优先使用手机已安装的本地语音。

## 构建

构建前请准备 **JDK 17+**、**Android SDK Platform 36** 与 **Python 3.12+**；安装到真机还需要 Android SDK Platform-Tools 提供的 `adb`。

因为 Gradle 需读取仓库根目录共享的模型脚本与 `models/` 缓存，请保持完整的 Turnline 仓库结构。首次构建会自动拉取 Sherpa-ONNX Android 运行库及 Matcha 模型（若仓库根目录已有 `models/`，会直接复用）。如果 Python 不在默认 `PATH` 中，可通过 `-PmatchaPython=/path/to/python` 指定。

你可以直接用 Android Studio 打开 `clients/android/`，或在命令行构建并安装（Windows 使用 `gradlew.bat`）：

```bash
cd clients/android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

构建经过 R8 压缩优化的未签名发布包：

```bash
./gradlew :app:assembleRelease
```

正式分发前请使用自己的发布密钥签名。

### 测试与真机检查

单元测试覆盖地址解析、HTTP 请求构造、SSE 多行与截断、PipiClaw 进展与会话条目、Responses JSON 回退、重定向及取消逻辑。设置环境变量 `TURNLINE_TEST_PIPICLAW_URL` 和 `TURNLINE_TEST_PIPICLAW_KEY` 后，单元测试还会针对临时 PipiClaw 实例执行同一会话的两轮只读联调。

真机安装后建议按以下路径做一次快速验收：

1. **文字与历史**：发一条消息并追问一轮，退出应用后重新打开，确认历史记录完整恢复。
2. **通话与打断**：开始通话，说一句带短暂停顿的话，检查转写、自动发送、播报与续听；播报时点「打断」，确认立即停播并可继续说下一句。
3. **断网恢复**：回复流入过程中断网或点击停止，确认已到达的文字保留，且下一轮发送正常。
4. **后台结果（PipiClaw 模式）**：在当前会话触发一项后台任务，确认结果返回后仅出现一次。
