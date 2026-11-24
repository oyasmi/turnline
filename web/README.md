# Turnline Web

Turnline 是连接本机 Pipiclaw 的语音通话界面。浏览器负责麦克风、播报与对话记录。Turnline 在本机识别语音，调用 Pipiclaw 处理文字，再用同一个 Matcha 音色播报中文、英文和中英混读。

从仓库根目录进入 `web/`，在该目录中执行本页命令。

## 启动

要求 Python 3.11 或更新版本及正在运行的 Pipiclaw。语音模型在服务器 CPU 上运行。

```bash
uv sync --locked --python 3.13
uv run python setup_models.py
uv run python server.py
```

在另一个终端运行 `uv run python server.py pair`，在要使用的浏览器里打开输出的链接。点击「开始通话」并允许麦克风即可。链接有效期 15 分钟，可使用一次。配对有效期七天，同一浏览器刷新后会恢复登录和最近一段对话。

Turnline 自动使用 `~/.pipiclaw/state/webapi/api.sock`。浏览器不需要填写 URL、模型或 API 密钥。`PIPICLAW_HOME` 指定其他 Pipiclaw 目录时，Turnline 会从该目录查找 socket。服务端也可以设置 `--pipiclaw-socket`。

## 在局域网使用

麦克风要求安全上下文。将 Turnline 部署在 HTTPS 反向代理后，再用同一个公开地址生成配对链接。以下命令使用主机地址 `192.168.1.5`。

```bash
uv run python server.py --port 4180 --public-url https://192.168.1.5:4173
uv run python server.py pair --public-url https://192.168.1.5:4173
```

反向代理应保留浏览器的 Host，支持 WebSocket 和即时转发 SSE 与音频流。下面的 Caddy 配置监听私有网络。

```caddyfile
https://192.168.1.5:4173 {
    tls internal
    reverse_proxy 127.0.0.1:4180 {
        flush_interval -1
    }
}
```

测试设备需要信任签发 HTTPS 证书的 CA。把配对链接交给有权操作这台 Pipiclaw 的使用者。Turnline 的设备状态保存在 `~/.local/state/turnline/`，可用 `--state-dir` 指定其他路径。浏览器中的「解除设备配对」会撤销当前设备会话。

## 通话

- 默认用 800 毫秒断句，给明显没说完的短前缀留一次接续机会。「嗯」这类纯附和会被略过，确认词和问题仍可提交。
- 助手在后台工具等待较久时给一句短的语音回执。最终回答确认后播报，百分比、容量和常见目录名会转换成适合朗读的表达。
- 播报时可按「打断」。需要免手操作时，在通话设置中开启开口打断。挂断后仍可在同一会话发文字或查看后台任务结果。
- 对话保存在 Pipiclaw，Turnline 通过设备配对隔离会话。麦克风音频留在 Turnline 的识别链路，Pipiclaw 只接收转写文字。
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
