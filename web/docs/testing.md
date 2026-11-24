# Turnline 测试手册

## 自动化

在仓库的 `web/` 目录中执行。

```bash
uv sync --locked --python 3.13
uv run python setup_models.py
npm ci
uv run --no-sync python -m unittest discover -s test
npm test
npm run test:browser
npm run test:interface
```

Python 测试覆盖自适应断句、长口述、立即提交、会话隔离和合成后的识别回听。JavaScript 测试覆盖状态机、分句、SSE 和回声文字比对。浏览器测试使用真实语音模型和虚拟麦克风，验证字幕、句中停顿、长口述、播报尾部接话、插话与恢复、语音通道重连和 Pipiclaw 会话串行提交。转发用例需要 OpenSSL，以本地 HTTPS 模拟两个地址，检查 WSS、直连 CORS 和 Key 的去向。缺少 Chromium 时，可用 `npx playwright install --only-shell chromium` 安装。

单独运行 20 轮热态延迟回归，分别检查 P50、P95 和字幕延迟。回声长跑和延迟回归分别执行，避免在同一台机器上争用语音推理资源。

```bash
TURNLINE_TEST_LATENCY_SAMPLES=20 npm run test:browser
```

还可运行句中停顿和插话延迟抽样，以及持续回声注入测试。回声夹具将播报 PCM 以 −20 dB、约 60 毫秒延迟混入虚拟麦克风。已安装 Chrome 或 Edge 时，可设置 `TURNLINE_TEST_BROWSER_CHANNEL=chrome` 或 `TURNLINE_TEST_BROWSER_CHANNEL=msedge`。

```bash
TURNLINE_TEST_HESITATION_SAMPLES=20 TURNLINE_TEST_BARGE_SAMPLES=20 npm run test:browser
TURNLINE_TEST_ECHO_SECONDS=600 npm run test:browser
```

## 实际通话

用 Chrome 和 Edge 分别测试笔记本外放、有线耳机和蓝牙耳机。另用 Android Chrome 验证屏幕唤醒锁、设备切换与网络恢复。

1. 启动 Pipiclaw 和 Turnline。开始通话并说一句问句，观察草稿字幕、提交提示音和回复首声。刷新页面后确认恢复同一会话。
2. 以自然速度说「我想问一下」，停约 0.9 秒，再接「明天北京天气怎么样」。确认只发送一轮。复测一段超过 20 秒的连续口述，抽查开头、中间和结尾。
3. 关闭开口打断，在最后一句播报将结束时开口，比较转写和原话。打开开口打断，分别测试实际插话、纯附和、咳嗽和键盘噪声。用外放连续运行 10 分钟记录误打断次数。
4. 在通话中断网约 5 秒再恢复，确认界面保留通话并可继续说话。用设备切换测试确认麦克风恢复，设置中检查语速和提示音开关。
5. 通话中发起一次耗时的只读查询，观察工具进度和最终播报。再试一次会话后台更新，确认空闲时播报且文字记录只出现一次。
6. 结束通话，在诊断面板导出逐轮计时。以设备实际听感抽查英文、百分比、容量和目录的朗读。

## 计时口径

- `perceived` 从最后一个有声采集帧算到达到幅度门槛的首个播报样本。起点使用麦克风采集时钟，终点使用 Web Audio 设备播放时钟估算，包含断句等待。
- `silenceWait` 是最后一个有声采集帧到服务端提交的音频时长。`partialLag` 是开口到浏览器收到首条字幕的时间。`asr` 是本轮可用转写作业的累计耗时。
- `endpointToRequest` 是浏览器收到提交事件到发送 Responses 请求的间隔。`audio` 记录提交到首声，文字输入时从请求发出起算。`text` 和 `speakable` 从请求发出起算。
- `bargeDuck`、`bargePause`、`bargeStop` 分别记录开口到该轮首次压低、首次暂停和确认停止的时间。浏览器可先做一次可恢复的暂停，收到有效转写后再停播。`false_barge` 计数暂降后恢复，包含附和、噪声及回声被正确拦下的情况。`cut` 标记提交后 1.5 秒内又开口的上一轮。
- `synthesis` 记录合成耗时。`underrun` 与 `gaps` 记录播报段间欠载次数和累计时间。标点停顿属于正常 PCM 播放时长。
- `outcome` 记录完成、失败或取消。正文完成后打断播报会记录为 `playback_interrupted`。

用同一设备、音量、网络和音色比较多轮分布，分别记录冷启动、热态和实机回环。导出文件只含计时、状态和响应 ID。

## 第二轮界面回归

`npm run test:interface` 检查 1440×900、1280×720、390×844、360×640 四种尺寸的深浅主题，在空闲和等待提交状态对比 16 张截图。测试也覆盖缩小视口后的输入框、Markdown 链接、思考音、语音高亮与断点、按住说话和 axe 严重问题。用 `npm run test:interface -- --update-snapshots` 刷新基线。

`npm test` 里的心跳回归模拟后台定时器间隔跳到 60 秒，检查恢复后先发探测，以及前台连续无响应时依然断开。滤波测试覆盖常见设备采样率、语音频段和高频混叠。实际 Android 设备上的外放、蓝牙和锁屏音频仍需现场验证。
