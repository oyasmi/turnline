# Turnline Web

Turnline 是连接 Pipiclaw 的语音通话界面。浏览器负责麦克风、播报与对话记录。Turnline 在服务端用 SenseVoice-Small 识别语音，用同一个 Matcha 音色合成中文、英文和中英混读。网页、语音 WebSocket、音频流和 Pipiclaw 中转共用一个端口，默认是 `8686`。

从仓库根目录进入 `web/`，在该目录中执行本页命令。

## 启动

要求 Python 3.11 或更新版本及正在运行的 Pipiclaw。语音模型在服务器 CPU 上运行。

```bash
uv sync --locked --python 3.13
uv run python setup_models.py
uv run python server.py
```

打开 `http://127.0.0.1:8686` 就能连接同机 Pipiclaw。点击「开始通话」并允许麦克风即可。同一浏览器刷新后可恢复最近一段对话。

## 连接 Pipiclaw

- **服务端中转**是默认模式，适合 Turnline 和 Pipiclaw 以同一系统用户运行。Turnline 自动使用 `~/.pipiclaw/state/webapi/api.sock`。从直连切回时，选择「通话设置 → 服务端中转」即可。`PIPICLAW_HOME` 或 `--pipiclaw-socket` 可以指定其他 Socket。
- **浏览器直连**适合公网 Turnline 访问浏览器所在内网的 Pipiclaw。从「通话设置 → 浏览器直连」进入，填写 Pipiclaw 地址和 Key，再点「测试并连接」。可以在 Pipiclaw 主机运行 `pipiclaw webapi key add turnline` 签发一把专用 Key。地址保存在浏览器，Key 保存在当前标签页会话。重新打开标签页时再次输入 Key。

浏览器直连时，Pipiclaw 的对话请求和 Key 由浏览器直接发送给 Pipiclaw。麦克风音频和需要播报的回复片段由 Turnline 处理。跨设备访问 Pipiclaw 时，请给它的 TCP 入口配置浏览器信任的 HTTPS。若 Pipiclaw 和浏览器在同一台设备，可用 `http://127.0.0.1:8787`，并在浏览器询问时允许网站访问本地网络。仅需直连的 Turnline 实例可用 `--direct-only` 启动。

## 通过隧道使用

在 Turnline 主机上正常启动服务，把 HTTPS 入口转发到 `http://127.0.0.1:8686`。

```bash
uv run python server.py
```

入口需要转发 WebSocket 升级和流式 HTTP 响应。保留浏览器的 `Host`，或由本机转发器设置 `X-Forwarded-Host`，并传递外部协议 `X-Forwarded-Proto`。浏览器直接打开当前 HTTPS 地址即可。换地址后服务继续运行，浏览器会按新站点保存麦克风权限、对话和直连设置。

**能访问中转入口的用户可以操作本机 Pipiclaw。** 将入口放在受信网络内，或在公网入口启用访问控制。Turnline 的浏览器 Cookie 用于隔离中转对话。

如果用 SSH，把当前设备的 `8686` 转发到远端的 `127.0.0.1:8686`，然后在当前设备打开 `http://127.0.0.1:8686`。

## 直接提供 HTTPS

局域网可以用 OpenSSL 生成证书。把下列 IP 换成设备实际访问的 IP 或主机名。

```bash
uv run python server.py --host 0.0.0.0 --self-signed --public-url https://192.168.1.5:8686
```

服务会打印 CA 证书路径。将该 CA 导入访问设备的信任库，然后打开 HTTPS 页面使用。服务会复用 CA，适用的服务器证书也会复用。已有受信 HTTPS 证书时，可直接提供 PEM 证书和私钥。

```bash
uv run python server.py --host 0.0.0.0 --tls-cert /path/fullchain.pem --tls-key /path/privkey.pem
```

浏览器会话和本地证书保存在 `~/.local/state/turnline/`，可用 `--state-dir` 指定其他路径。

## 通话

- 使用 Chrome 或 Edge 打开通话。默认「均衡」会在完整句后较快接话，遇到「然后」等没说完的表达会多等一会儿。通话设置提供「灵敏」「均衡」「耐心」三档。
- 说话时会出现实时字幕。停顿后自动发送，也可以点光球立即发送。光球跟随输入和播报音量，等待较久时会显示思考动画。
- 默认流式播报，收到短分句即可开始合成。设置里可以改为确认正文后播报、调整语速或关闭提示音。工具执行较久时仍会播出简短的进度回执。
- 播报时可点光球或「打断」。开口打断默认关闭，可在通话设置打开。网络短暂断开时语音通道会尝试自动恢复。挂断后仍可在同一会话发文字或查看后台任务结果。
- 对话保存在 Pipiclaw。中转模式自动创建浏览器会话，隔离各浏览器的对话记录。Pipiclaw 接收麦克风的转写文字。
- 默认使用深色主题，页首图标可切换并记住深浅主题。「文字输入」可展开对话记录下的输入框。「语音通话」卡片的 ⓘ 可查看诊断和导出逐轮计时。

## 语音模型

默认使用 `matcha-icefall-zh-en` 与 Vocos。中文沿用模型的数字、日期和电话归一化规则，再用 pypinyin 转成拼音。英文用 eSpeak NG 转成音素，字母数字混合的型号和版本号使用统一的结构规则。中英文在同一份音素序列中送给 Matcha，使用同一个音色。

- [Matcha 中英模型和上游样音](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/matcha-icefall-zh-en.html)
- [Sherpa-ONNX 中英混读音素输入示例](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/python-api-examples/test-offline-tts-matcha-zh-en-phonemize.py)

## 开发验证

```bash
npm ci
uv run --no-sync python -m unittest discover -s test
npm test
npm run test:browser
```

`uv run python server.py --demo` 可以显式启动独立的本机演示，便于离线复测。测试说明和本机验证记录见 [测试手册](docs/testing.md) 和 [测试报告](docs/test-results.md)。
