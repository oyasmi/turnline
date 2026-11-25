# 测试手册

本文汇总 Turnline 的自动化回归命令、专项压测、实机验收清单及通话诊断的计时口径。各阶段历史测量数据保留在 [历史验证记录](test-results.md)。

## 自动化测试

Web 测试在仓库根目录执行，需要 **uv** 与 **Node.js 22+**；浏览器测试需要 Playwright Chromium，HTTPS 转发用例还依赖 OpenSSL。

```bash
# 准备依赖、语音模型与浏览器运行环境
uv sync --locked --python 3.13
uv run python setup_models.py
npm ci
npx playwright install --only-shell chromium

# 运行四套核心测试
uv run --no-sync python -m unittest discover -s test
npm test
npm run test:browser
npm run test:interface
```

各套测试的覆盖范围：

| 命令 | 覆盖内容 |
| --- | --- |
| `unittest` | 自适应断句、长口述、立即提交、最短语音过滤、中转会话隔离，以及合成后的回听识别 |
| `npm test` | 前端状态机、分句逻辑、SSE 解析、回声文字比对、重采样滤波与后台心跳恢复 |
| `npm run test:browser` | 基于真实语音模型与虚拟麦克风的端到端通话（字幕、句中停顿、长口述、播报尾接话、插话与恢复、通道重连、PipiClaw 串行提交），以及本地 HTTPS 转发、WSS 与直连 CORS 边界 |
| `npm run test:interface` | 4 种视口（`1440×900`、`1280×720`、`390×844`、`360×640`）× 深浅主题 × 空闲/等待提交共 16 张截图基线，以及软键盘视口缩放、Markdown 链接、思考音、语音高亮断点、按住说话与 axe 无障碍检查 |

更新界面截图基线时使用 `npm run test:interface -- --update-snapshots`。

### 延迟、插话、回声与后台专项回归

专项压测会占用较多本地语音推理资源，建议与常规回归分开执行。本机装有 Chrome 或 Edge 时，可通过 `TURNLINE_TEST_BROWSER_CHANNEL=chrome`（或 `msedge`）切换浏览器通道。

```bash
# 20 轮热态延迟分布（P50 / P95 / 字幕延迟）
TURNLINE_TEST_LATENCY_SAMPLES=20 npm run test:browser

# 句中停顿合并与开口插话抽样
TURNLINE_TEST_HESITATION_SAMPLES=20 TURNLINE_TEST_BARGE_SAMPLES=20 npm run test:browser

# 10 分钟持续回声注入（以 -20 dB、约 60 ms 延迟将播报 PCM 混回虚拟麦克风）
TURNLINE_TEST_ECHO_SECONDS=600 npm run test:browser
```

后台保活测试会按 Chrome 真实后台计时策略隐藏通话标签页 605 秒，确认复原后仍复用原 WebSocket。运行前需安装完整版 Chromium（`npx playwright install chromium`）：

```bash
npm run test:background
# 无桌面环境的 Linux 可配合 Xvfb：
xvfb-run -a npm run test:background
```

## 实机验收清单

虚拟麦克风无法替代真实声学环境。发布或大改前，建议用 Chrome 和 Edge 分别在笔记本外放、有线耳机与蓝牙耳机上完成以下检查，并在 Android Chrome 上验证屏幕唤醒锁、音频设备切换与网络恢复：

1. **基础通话与会话延续**：同时启动 PipiClaw 与 Turnline，开麦说一句问句，确认实时字幕、提交提示音与首声正常；刷新页面后确认自动回到同一会话。
2. **句中停顿与长口述**：自然语速说出「我想问一下」，停顿约 0.9 秒后接「明天北京天气怎么样」，确认合并为一轮发送；再连续口述 20 秒以上，抽查开头、中段与结尾是否完整。
3. **接话与开口打断**：关闭开口打断，在最后一句播报即将结束时开口，核对转写完整度；随后开启开口打断，分别测试真实插话、纯附和、咳嗽与键盘噪声，并用外放连续运行 10 分钟记录误打断次数。
4. **异常恢复与偏好生效**：通话中断网约 5 秒再恢复，确认会话保持且可继续说话；切换麦克风/扬声器设备确认收放音恢复；抽查语速、提示音与思考音开关。
5. **工具进度与后台结果**：在通话中触发一次耗时只读查询，观察思考提示与最终播报；再触发一次后台任务，确认空闲时播报且文字记录不重复。
6. **听感与计时导出**：结束通话，在诊断面板导出逐轮计时；用真实听感抽查英文专名、百分比、存储容量与路径目录的朗读自然度。

## 诊断计时口径

通话诊断面板导出的 JSON 仅包含计时、状态与响应 ID，便于在同一设备、音量、网络与音色下对照冷启动与热态分布：

| 字段 | 口径说明 |
| --- | --- |
| `perceived` | 最后一个有声采集帧（麦克风时钟）到首个达到幅度门槛的播报样本（Web Audio 播放时钟估算），包含断句等待 |
| `silenceWait` | 最后一个有声采集帧到服务端提交之间的音频时长 |
| `partialLag` | 开口到浏览器收到首条实时字幕的耗时 |
| `asr` | 本轮可用转写作业的累计推理耗时 |
| `endpointToRequest` | 浏览器收到提交事件到发出 Responses 请求的间隔 |
| `text` / `speakable` | 请求发出到收到首字 / 首段可播文本的耗时 |
| `audio` | 语音提交（文字输入则从请求发出）到首声的耗时 |
| `synthesis` | 单段语音合成耗时 |
| `underrun` / `gaps` | 播报段间欠载次数与累计间隙时长（正常标点停顿不计入） |
| `bargeDuck` / `bargePause` / `bargeStop` | 开口到首次压低音量、首次可恢复暂停、确认停播的耗时 |
| `false_barge` / `cut` | 暂降后恢复次数（含被拦截的附和、噪声与回声）；`cut` 标记提交后 1.5 秒内再次开口的上一轮 |
| `outcome` | 本轮最终状态（完成、失败、取消；正文完成后打断播报记为 `playback_interrupted`） |

## Android

Android 客户端的单元测试、Lint 检查与真机验收路径见 [Android 使用与构建](android.md#构建)。
