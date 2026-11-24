# Turnline

Turnline 提供语音通话和文字对话，有 Web 和 Android 两个客户端。

- **Web**通过本机 Turnline 服务连接 PipiClaw。语音识别和中英双语播报在服务端运行，浏览器通过配对链接进入。见 [Web 安装、部署与测试](web/README.md)。
- **Android** 在 Android 12 及以上通过 HTTP 或 HTTPS 直连 PipiClaw 或兼容 Responses API 的服务，使用手机的语音识别和播报。见 [Android 连接与构建](android/README.md)。
