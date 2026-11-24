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

- 默认用 800 毫秒断句，给明显没说完的短前缀留一次接续机会。「嗯」这类纯附和会被略过，确认词和问题仍可提交。
- 助手在后台工具等待较久时给一句短的语音回执。最终回答确认后播报，百分比、容量和常见目录名会转换成适合朗读的表达。
- 播报时可按「打断」。需要免手操作时，在通话设置中开启开口打断。挂断后仍可在同一会话发文字或查看后台任务结果。
- 对话保存在 Pipiclaw。中转模式自动创建浏览器会话，隔离各浏览器的对话记录。Pipiclaw 接收麦克风的转写文字。
- 「通话诊断」可导出最近一通的逐轮 JSON。它记录识别、后端、合成、首声和取消时间，省去录音和对话正文。

## 语音模型

默认使用 `matcha-icefall-zh-en` 与 Vocos。中英文共用一套声学模型和音色。Sherpa-ONNX 2.x 通过词表输入发音，安装脚本另外下载并校验英文词表，与模型原装的中文词表结合。常见技术名有专门发音，未收录的英文名称按字母拼读。

- [Matcha 中英模型和上游样音](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/matcha-icefall-zh-en.html)
- [Sherpa-ONNX 英文发音词表](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/lexicon-en-us.txt)

## 开发验证

```bash
npm ci
uv run --no-sync python -m unittest discover -s test
npm test
npm run test:browser
```

`uv run python server.py --demo` 可以显式启动独立的本机演示，便于离线复测。测试说明和本机验证记录见 [测试手册](docs/testing.md) 和 [测试报告](docs/test-results.md)。
