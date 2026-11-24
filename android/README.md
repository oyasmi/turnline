# Turnline for Android

Android 12 及以上。原生 Kotlin 与 Jetpack Compose 界面适配系统深色模式。手机直接向配置的服务发送文字请求，语音识别和播报由 Android 语音服务完成。

## 连接模型

首次打开后点「连接服务」，选一种连接方式。

| 模式 | 需要填写 | 会话行为 |
| --- | --- | --- |
| PipiClaw | 服务地址、API 密钥 | 使用 PipiClaw 会话和工位上下文。前台空闲时同步当前会话的后台结果。 |
| Responses API | 服务地址、模型 ID、该服务所需的 API 密钥 | 手机保存对话，每轮发送近期的文字上下文。通过 `POST /responses` 请求 SSE，也接收该端点直接返回的 Responses JSON。 |

地址可以填写主机、API Base URL 或完整的 Responses 端点。比如 `http://192.168.1.5:8787`、`http://192.168.1.5:8787/v1` 和 `http://192.168.1.5:8787/v1/responses` 指向同一个端点。HTTPS 使用 Android 应用默认的证书信任规则。HTTP 会以明文传输请求和密钥，适合可信网络。

PipiClaw 首次启动默认监听电脑的回环地址。给局域网手机使用时，把已有 `~/.pipiclaw/channel.json` 里的 `webapi.tcp` 改为电脑的局域网监听地址，例如 `192.168.1.5:8787`，保留其余 Web API 配置并重启 PipiClaw。用以下命令为手机创建密钥，默认授权 `default` 工位。

```bash
pipiclaw webapi key add turnline-android
```

手机填写 `http://192.168.1.5:8787/v1` 和生成的密钥。电脑与手机需要网络互通。PipiClaw 的连接测试检查鉴权和模型端点，普通 Responses 服务的测试会向指定模型发送一次简短请求。PipiClaw 配置细节见 [Web API 文档](https://github.com/oyasmi/pipiclaw/blob/master/docs/webapi.md)。

## 通话与文字

- 点麦克风开始通话。说完稍作停顿，Turnline 会发送转写文字，读完回复后自动续听。可点「打断」跳过播报或停止等待，点「挂断」回到当前对话的文字输入。
- 默认使用「仅离线」，调用 Android 的离线识别服务，需要设备支持并安装相应的系统语音包。「系统识别」使用手机的默认语音服务，该服务可能在线处理录音。PipiClaw 和 Responses API 收到的是转写文字。播报优先使用设备上已安装的语音，音色和语言包取决于手机的系统引擎。离开应用时会释放麦克风和播报。
- 点右上角历史图标可恢复对话或开启新对话。PipiClaw 的后台更新进入文字记录。复制、选中文本和单条朗读均可在聊天页操作。
- API 密钥由 Android Keystore 保护。对话存在应用本机数据库中，按服务配置隔离。删除本机历史仅移除手机上的记录。网络中断时保留已经显示的回复片段，用户可以把失败的输入放回输入框。应用不会自动重发消息。

## 构建

需要 JDK 17 或更新版本以及 Android SDK Platform 36。在 Android Studio 打开 `android/`，或从这个目录执行下列命令。

```bash
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`./gradlew :app:assembleRelease` 构建经过 R8 优化的未签名 APK。正式分发时使用自己的发布密钥签名。

协议回归覆盖地址解析、真实 HTTP 请求形状、SSE 多行与截断、PipiClaw 进展和会话条目、通用 Responses 的 JSON 回退，以及重定向和取消。设置 `TURNLINE_TEST_PIPICLAW_URL` 和 `TURNLINE_TEST_PIPICLAW_KEY` 可让单元测试连接临时 PipiClaw 实例，在同一会话执行两条只读命令。真机通话可用以下方式复测。

1. 在文字模式发送一条消息，再追问一轮，退出应用后重新打开历史。
2. 开始通话，说一句包含短暂停顿的话。检查转写、自动发送、播报和续听。播报时点「打断」，再说下一句。
3. 在回复流入时断开网络，或点停止。检查已经到达的文字和下一轮发送。
4. 在 PipiClaw 模式中用当前会话等待一个后台结果，检查它只出现一次。
