# Turnline 测试手册

## 自动化

在仓库的 `web/` 目录中执行下列命令。

```bash
uv sync --locked --python 3.13
uv run python setup_models.py
npm ci
uv run --no-sync python -m unittest discover -s test
npm test
npm run test:browser
```

Python 测试使用本地 Unix socket 验证配对、会话隔离、SSE 转发与断开取消，也覆盖合成取消及英文拼读。JavaScript 测试覆盖音频分块、SSE、断句、播报文本和附和过滤。浏览器用离线演示、虚拟麦克风、真实语音模型和可控的会话消息验证通话行为。缺少 Chromium 时，可以用 `npx playwright install --only-shell chromium` 安装。

## 实际通话

1. 启动正式入口。未配对浏览器应显示「等待配对」。用 `uv run python server.py pair` 生成链接，局域网部署时带上服务相同的 `--public-url`。
2. 打开链接，确认显示「Pipiclaw 已连接」。先发一条文字和一个只用于本次测试的代号，刷新后从麦克风问回代号。确认恢复对话、使用同一会话、听到正确的回复。
3. 用自然速度说「你帮我看一下，现在」，略停，再说「这台主机空间还剩多少」。比较快速和自然断句。用「曹雪芹」「脂砚斋」验证专名，观察识别不确定时能否先确认。
4. 播报时分别试纯附和、手动打断和开口打断。观察停播后是否从新问题继续。耳机和外放应分开测，记录误触发和漏检。
5. 让 Pipiclaw 做一次耗时的只读查询，观察工具等待提示及最终结果。再试一项后台任务，确认结果既能写入对话记录，也能在空闲时播报。
6. 结束通话，在「通话诊断」导出逐轮计时。抽查百分比、英文和目录格式，以设备实际听到的内容为准。

## 计时口径

- `asr` 记录本机识别耗时。合并两段时记录两次识别之和。
- `endpointToRequest` 记录浏览器收到断句事件后到发起 Responses 请求的间隔，包含等待后半句和首轮建会话。
- `text`、`speakable`、`audio` 分别记录到首字、首个可播片段和首声。用 HTTP 响应 ID 对照 Pipiclaw 记录。
- `synthesis` 来自服务端首块 PCM 计时，`gaps` 记录浏览器估算的片段间隙。浏览器的首声和停播计时以 Web Audio 调度为准。
- `outcome` 记录回复完成、失败或取消。中途挂断和新建对话各有自己的取消值。正文完成后打断播报会记录为 `playback_interrupted`。

用同一设备、音量、网络和默认音色对比多轮分布。冷启动与已预热的测试分别记录。导出文件没有录音和对话正文。
