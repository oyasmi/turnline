# Turnline

Turnline 提供语音通话和文字对话，有 Web 和 Android 两个客户端。

- **Web** 支持 Turnline 服务端中转或浏览器直连 PipiClaw。服务端用 SenseVoice-Small 识别语音，用 Matcha 合成中英双语播报。默认端口为 `8686`，支持 HTTPS 和隧道访问。见 [Web 安装、部署与测试](web/README.md)。
- **Android** 在 Android 12 及以上通过 HTTP 或 HTTPS 直连 PipiClaw 或兼容 Responses API 的服务，使用手机的语音识别和播报。见 [Android 连接与构建](android/README.md)。
