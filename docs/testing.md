# Turnline 测试与评估手册

这份手册可直接交给测试 Agent。先跑离线自动化，再检查实际的音频端点。根据条件联调本机 Pipiclaw，最后记录可用的实体设备测试。测试报告将功能通过、性能达标和听感验证分别列出。

## 1. 准备与启停

```bash
cd ~/projects/turnline
uv sync --locked --python 3.13
uv run python setup_models.py
npm ci
uv run --no-sync python -m unittest discover -s test
npm test
npm run test:browser
```

Python 单元测试覆盖英文拼读回退和合成取消。`npm test` 覆盖 SSE、PCM 分块、分句和 Base URL。`npm run test:browser` 自动启停独占的 Python 服务，用真实语音模型、虚拟麦克风和演示 Responses 后端验证整条链路。三项检查均应返回退出码 0。用 `TURNLINE_TEST_TTS_ENGINE=kokoro npm run test:browser` 可单测 Kokoro。只有 Playwright 明确报缺少 Chromium 时才运行 `PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install --only-shell chromium`。

进行 API 探测、手动浏览器操作或 Pipiclaw 联调时，在独立终端启动 Turnline。

```bash
cd ~/projects/turnline
uv run python server.py --host 127.0.0.1 --port 4173
```

终端出现 `Turnline http://127.0.0.1:4173` 后，用 `curl -fsS http://127.0.0.1:4173/ -o /dev/null` 检查。端口冲突时改用 `--port 0`，以终端打印的地址为准。测试结束后在自己启动的 Turnline 终端按 `Ctrl+C`，再确认该地址无法访问。Pipiclaw 使用现有运行实例，联调期间保持其进程和配置原样。

在运行探测命令的终端设置以下变量。

```bash
export TURNLINE_URL=http://127.0.0.1:4173
export TURNLINE_EVIDENCE="$(mktemp -d -t turnline-test.XXXXXX)"
printf '%s\n' "$TURNLINE_EVIDENCE"
```

将地址换成实际监听值。后续素材与结果都放进此临时目录。不同终端或工具调用之间，重新设置这两个变量。

## 2. 生成文本与音频素材

| 编号 | 文本或音频内容 | 测什么 |
| --- | --- | --- |
| basic | 你好，今天天气怎么样？ | 中文识别、短回合与首声 |
| followup | 那我们刚才聊到哪里？ | 同一会话接续 |
| slow | 说慢一点。 | 演示后端故意放慢 SSE，用于点按打断和实验性插话 |
| progress | 告诉我进度。 | 比较确认正文和分句即时播报 |
| mixed | 请记住，版本是二点五，名字叫 Kubernetes。 | 数字和英文专名的听写与播报 |
| mixed-lower | 名字叫 kubernetes。 | 小写英文专名 |
| known-en | 名字叫 hello。 | 词表内英文 |
| silence | 两秒空白 | 静音不触发识别或模型请求 |

以下命令在 Turnline 项目目录运行。它从实际的合成接口取 PCM，检查音频有效性，再生成可以播放或注入的 WAV 和文本清单。合成声适合做可重复回归。真实 ASR 样本使用模型包自带的 `test_wavs/zh.wav`，两种输入都要测。

```bash
uv run --no-sync python - <<'PY'
import json
import os
import time
import wave
from pathlib import Path
from urllib.request import Request, urlopen

import numpy as np
from setup_models import MODELS, SENSE_VOICE

base = os.environ["TURNLINE_URL"].rstrip("/")
out = Path(os.environ["TURNLINE_EVIDENCE"])
cases = {
    "basic": "你好，今天天气怎么样？",
    "followup": "那我们刚才聊到哪里？",
    "slow": "说慢一点。",
    "progress": "告诉我进度。",
    "mixed": "请记住，版本是二点五，名字叫 Kubernetes。",
    "mixed-lower": "名字叫 kubernetes。",
    "known-en": "名字叫 hello。",
}
(out / "cases.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n")
with urlopen(Request(base + "/speech/prepare", method="POST"), timeout=60) as result:
    voice_config = json.load(result)
    print("TTS ready", voice_config)

for name, text in cases.items():
    body = json.dumps({"text": text, "speaker": voice_config["voices"][0]["id"]}).encode()
    request = Request(base + "/speech/synthesize", data=body,
                      headers={"Content-Type": "application/json"})
    start = time.perf_counter()
    with urlopen(request, timeout=60) as result:
        rate = int(result.headers["X-Sample-Rate"])
        timing = result.headers["Server-Timing"]
        samples = np.frombuffer(result.read(), dtype="<f4")
    elapsed = time.perf_counter() - start
    assert rate > 0 and samples.size and np.isfinite(samples).all(), name
    assert np.abs(samples).max() > 0.001, f"{name}: near-silent output"
    pcm = np.rint(np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(str(out / (name + ".wav")), "wb") as wav:
        wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        wav.writeframes(pcm.tobytes())
    print(f"{name}: {elapsed*1000:.0f} ms, {samples.size/rate:.2f} s, RTF {elapsed/(samples.size/rate):.2f}, {timing}")

with wave.open(str(out / "silence.wav"), "wb") as wav:
    wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
    wav.writeframes(bytes(2 * 16000 * 2))
original = MODELS / SENSE_VOICE / "test_wavs" / "zh.wav"
(out / "recorded-zh.wav").write_bytes(original.read_bytes())
PY
```

`RTF` 是合成请求耗时除以音频时长。低于 1 表示这个样本生成速度快于播放。命令包含本机 HTTP 与 PCM 传输时间。在有音频输出的环境播放 `basic.wav` 和 `mixed.wav`，记录中文自然度、数字和英文专名是否漏读或误读。声音大小与 PCM 有效性可以自动检查，实际听感由听过的人或可实际处理音频的测试 Agent 评估。

## 3. 单独验证 Silero 与 SenseVoice

用下面的探测把 WAV 送进正式的收音 WebSocket。它先按 16 kHz 单声道转换素材，再按 512 个 float32 样本一帧发送。末尾补静音，用于触发自然断句。需要 `ffmpeg`。该探测验证服务端音频处理，通过浏览器的实时收音则由浏览器自动化验证。

```bash
uv run --no-sync python - <<'PY'
import asyncio
import os
import re
import subprocess
from pathlib import Path

import aiohttp

directory = Path(os.environ["TURNLINE_EVIDENCE"])
url = os.environ["TURNLINE_URL"].rstrip("/") + "/speech/listen"
frame_size = 512 * 4

async def probe(session, name):
    wav = directory / (name + ".wav")
    audio = subprocess.check_output([
        "ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(wav),
        "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1",
    ])
    audio = bytes(4000 * 4) + audio + bytes(16000 * 4)
    audio += bytes((-len(audio)) % frame_size)
    expected = {
        "basic": ("你好", "今天天气怎么样"),
        "recorded-zh": ("早上", "下午"),
        "mixed": ("版本", "名字"),
        "mixed-lower": ("名字",),
        "known-en": ("名字",),
        "silence": (),
    }[name]
    async with session.ws_connect(url) as ws:
        ready = await ws.receive_json(timeout=60)
        assert ready["type"] == "ready", ready
        await ws.send_json({"type": "reset", "epoch": 1, "silence": 0.5})
        for start in range(0, len(audio), frame_size):
            await ws.send_bytes(audio[start:start + frame_size])
        events = []
        while not events or events[-1]["type"] != "transcript":
            try:
                event = await ws.receive_json(timeout=2 if name == "silence" else 20)
            except asyncio.TimeoutError:
                if name != "silence":
                    raise
                break
            assert event.get("epoch") == 1, event
            events.append(event)
        if name == "silence":
            assert events == [], events
        else:
            assert [event["type"] for event in events] == ["speech-start", "speech-end", "transcript"], events
            text = "".join(events[-1]["text"].split())
            assert all(term in text for term in expected), events
            if name == "recorded-zh":
                assert text.startswith(("开饭", "开放")), events
                assert any(term in text for term in ("9点", "九点")), events
                assert any(term in text for term in ("5点", "五点")), events
            if name in {"mixed", "mixed-lower", "known-en"}:
                expected_english = "hello" if name == "known-en" else "kubernetes"
                english = re.sub(r"[^a-z]", "", text.lower())
                if name == "mixed" and "kuubernetes" in english:
                    print("mixed: 专名已转写，拼写有偏差（多一个 u）")
                else:
                    assert expected_english in english, events
        print(name, events)

async def main():
    async with aiohttp.ClientSession() as session:
        for name in ("basic", "recorded-zh", "mixed", "mixed-lower", "known-en", "silence"):
            await probe(session, name)

asyncio.run(main())
PY
```

真实中文样本的首词应是「开饭」或「开放」，关键内容是「早上 9 点至下午 5 点」。英文回环接受大小写、空格与逐字母转写的差异。长句若出现 `kuubernetes`，测试会记录拼写偏差，评估时仍计为识别错误。该探测发包速度比实时说话快，输出的 `asrMs` 可用于定位模型开销，整体用时不填入通话延迟结果。

## 4. 验证通话交互

使用本地演示时保持「连接设置」里的 Base URL 为空。用桌面 Chromium 自动化可以完成主链路。可用真实设备时，再执行额外的耳机和外放验证。需要让 Playwright 播放自定义 WAV 时，可以沿用现有测试的虚拟麦克风。Node 侧将文件转为 Base64，传给 `page.addInitScript`，浏览器用 `AudioContext.decodeAudioData` 得到音频。等待状态变为「正在聆听」后，将音频送进 `MediaStreamDestination`。 [浏览器测试源码](../test/browser.mjs)

| 场景 | 执行 | 通过证据 |
| --- | --- | --- |
| 文字与上下文 | 不开麦，输入 `basic`、`followup` 两轮。再点「新对话」 | 两轮都收到完整 SSE，第二轮识别到存在历史。新对话后界面清空，下轮从第一轮上下文开始 |
| 自动断句 | 点「开始通话」，等待「正在聆听」，说 `basic`。播完后继续说 `followup` | 每段只提交一次，转写保留关键含义，回复播完恢复聆听 |
| 点按打断 | 说或输入 `slow`。在等待或播报时点「打断」，再提交 `followup` | 浏览器撤销旧 SSE，旧播报停止，迟到的回复不会重新播放，新一轮正常结束 |
| 正文与进度 | 在本地演示用两种播报方式执行 `progress` | 两种模式都只把最终两条正文发给 `/speech/synthesize`，进度仅出现在文字区。用 `slow` 确认即时模式仍能在整轮完成前播报。接 Pipiclaw 时记录有没有先读出后来才标成进度的文字 |
| 开口插话 | 打开「允许在播报时开口打断」，即时模式发送 `slow`，第一句话播放时插入 `basic` | 有插话停播指标，旧回复标记「已打断」，新语音成功发送。虚拟麦克风验证事件和状态，实际外放另外验证 |
| 静音、挂断、再次通话 | 静音后说一句，再取消静音并说话。播报中挂断，随后重新开始通话 | 静音期间无语音回合，解除后恢复。挂断关闭收音 WS、停止本地播放，重新开麦正常 |
| 连接故障 | 只对独占测试实例断开服务，或在 Playwright 对相应请求注入失败。恢复后重新建立通话 | 页面提示可以采取的操作，无旧音频或重复回合，重连后恢复 |

物理测试先戴耳机，再用外放，分别记录插话成功次数、把自身播报当成人声的次数、是否吞掉插话前几个字。再用同一句话中间停顿和说完后停顿对比误断句。没有实体设备时，将这些项目记为「未测」。

## 5. 连接已运行的本机 Pipiclaw Web API

从 `~/.pipiclaw/channel.json` 读取 `webapi.enabled`、`webapi.tcp` 和 `webapi.tls`。这段只输出联调需要的地址与密钥记录数。

```bash
python3 - <<'PY'
import json
from pathlib import Path

config = Path.home() / ".pipiclaw" / "channel.json"
webapi = json.loads(config.read_text())["webapi"]
tcp = webapi.get("tcp")
if not webapi.get("enabled") or not tcp:
    raise SystemExit("本机配置未启用 Web API TCP 监听。记录为联调受阻。")
host, port = tcp.rsplit(":", 1)
host = {"0.0.0.0": "127.0.0.1", "[::]": "[::1]"}.get(host, host)
scheme = "https" if webapi.get("tls") else "http"
print(f"Base URL: {scheme}://{host}:{port}/v1")
print(f"Configured key entries: {len(webapi.get('keys', []))}")
PY
```

本机测试使用名为 `turnline-test` 的 Web API key，授权工位是 `default`。明文保存在 `~/.pipiclaw/credentials/turnline-webapi.key`，文件权限是 `0600`。`channel.json` 中的 `webapi.keys[].sha256` 用于服务端验签。测试脚本从凭据文件读取明文，证据中只保留 HTTP 状态、脱敏的请求字段、会话 ID 和时序。

运行下面的只读探测，确认 `GET /v1/models` 返回 HTTP 200 并列出 `pipiclaw`。若端口或协议发生变化，使用上一步输出的 Base URL。401 时检查凭据文件是否仍对应已配置的测试 key。连接拒绝时复核已经运行的实例的监听地址。

```bash
(
  set +x
  set -euo pipefail
  PIPICLAW_BASE_URL=http://127.0.0.1:8787/v1
  PIPICLAW_KEY_FILE="$HOME/.pipiclaw/credentials/turnline-webapi.key"
  IFS= read -r TURNLINE_PIPICLAW_KEY < "$PIPICLAW_KEY_FILE"
  printf 'header = "Authorization: Bearer %s"\n' "$TURNLINE_PIPICLAW_KEY" |
    curl --fail-with-body -sS --noproxy 127.0.0.1 --max-time 5 \
      --config - "$PIPICLAW_BASE_URL/models"
)
```

在 Turnline 点「连接设置」，填入下表中的值并保存。

| 字段 | 值 |
| --- | --- |
| Base URL | 上面得到的地址。本机常见值是 `http://127.0.0.1:8787/v1` |
| 模型 | `pipiclaw` |
| API 密钥 | `~/.pipiclaw/credentials/turnline-webapi.key` 的内容 |
| 上下文 | 后端会话 |

使用 Playwright 时，可以把文件内容直接填入密码框。含密钥的操作应在关闭跟踪的浏览器上下文执行。

```js
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const keyFile = join(homedir(), '.pipiclaw', 'credentials', 'turnline-webapi.key');
await page.locator('#api-key').fill(readFileSync(keyFile, 'utf8').trim());
```

可以先发 `/status` 验证命令入口，然后点「新对话」，从下面两句纯对话开始记录会话和请求数。第一轮「本轮代号是海星。请用一句话确认。」第二轮「本轮代号是什么？只说代号。」第二轮应回答「海星」。有模型额度或权限限制时，以离线结果为准并注明联调范围。

通过浏览器 Network 检查新对话只有一次 `POST /v1/conversations`，随后两次 `POST /v1/responses` 使用同一 `conversation` ID。每轮请求包含 `model: "pipiclaw"`、`stream: true`、当轮 `instructions` 和本轮文本 `input`。最终回复应有 `response.completed`。切换客户端后端或点「新对话」后，下次发送应新建会话。用文字发第一轮、用语音发第二轮，还能验证语音转写进入同一会话。

## 6. 评估与交付

功能冒烟通过后，再测延迟。每组分别记录首次启动与模型已预热的结果。对比确认正文和即时播报时，使用相同的音色、断句时间、输入、后端和负载。建议每组采集至少 20 个成功样本，报告样本数、中位数、P95、最大值及失败数。样本不足时报告实际样本数，给出单次或少量观测。把演示后端和 Pipiclaw 的结果分别记录。

| 指标 | 当前测量起点与终点 |
| --- | --- |
| 语音识别 | Python VAD 确认断句到识别结果。含服务内等待 |
| 请求到首字 | 浏览器发起 Responses 请求到显示第一段助手文本。进度文字也可能成为首字 |
| 请求到首段可播文本 | 浏览器发起 Responses 请求到首段文本进入合成队列 |
| 首次合成排队 | Python 校验首个合成请求后到合成线程取得模型锁 |
| 合成到首块 PCM | 合成线程取得模型锁到首批有效 PCM 生成，冷态含加载时间 |
| 首段文本到浏览器收到 PCM | 首段文本入队到浏览器读到首批可用样本，含请求、排队、推理和传输 |
| 本轮播报间隙累计 | 相邻音频缓冲之间超过 30 ms 的调度间隙之和。音频内的停顿另外听测 |
| 断句到首声 | 浏览器收到断句事件到首段音频计划开始播放。真实停顿与扬声器延迟另测 |
| 插话事件处理 | 浏览器收到语音开始事件到发出本地停止播放命令。从开口到扬声器停下需要另测 |
| TTS 耗时与 RTF | 使用第 2 节输出。共用服务器时注明其他负载 |

用 `TURNLINE_TEST_LATENCY_SAMPLES=20 npm run test:browser` 测本地演示的连续热态短问答。体验目标为断句到首声中位数 1.5 秒。现场验证时，用同一录音或外部回环捕捉用户开口、旧播报停下和新播报开始的实际时间。

按下面四项交付测试报告。

- 测试日期、项目版本或关键文件哈希、操作系统、浏览器、CPU、语音模型、音频输入方式、后端及断句设置。
- 每个场景的结论（通过／失败／未测）、复现命令和可检查证据。涉及实体收音或网络条件时写明设备和场景。
- 延迟数据及样本数，合成声、录制样本和真实用户说话的结果各自注明。
- 一段体验结论。指出会卡在哪里、是否容易误判停顿或插话，并按影响列出优先修复项。
