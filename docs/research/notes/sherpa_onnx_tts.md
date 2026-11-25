# sherpa-onnx 中文与中英 TTS 模型（相对 Matcha 的替换）

检索截止 2026-11-24。sherpa-onnx 最新发布版页面上的版本是 **v2.0.3（2026-11-22）**。TTS 权重不在版本号里，而在滚动 tag `tts-models`（页面标注首次发布 2023-11-21，资产持续追加，含 2026 年的 Pocket / Supertonic）。声码器在 tag `vocoder-models`（2024-12-30）。官方目录实际 URL 是 [pretrained_models/index.html](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/index.html)；用户给出的 `pretrained_models.html` 返回 404。

官方 RTF 表只测 **Raspberry Pi 4 Model B Rev 1.5**。没有 i5-8260U、也没有其它 x86 的公布 RTF。没有公布这些 TTS 模型的典型 RAM。参数量只在 Kokoro 的模型卡上写了 82M；其余模型没有官方参数量，下面不从文件大小反推。

## 2026-11 sherpa-onnx 官方在发哪些中文 / 中英 TTS？

### Takeaway
中英双语、并且出现在官方「Chinese+English」索引里的只有三套：`matcha-icefall-zh-en`、`kokoro-multi-lang-v1_0`、`kokoro-multi-lang-v1_1`。另外两套双语模型在别的文档页：`vits-melo-tts-zh_en` 和 ZipVoice zh-en Emilia。纯普通话还有 Matcha Baker、两到三套 Piper zh_CN、icefall AISHELL-3，以及一批约 115 MB 的 VITS 角色包。Kitten / Pocket / Supertonic 的 sherpa 包是英语（或未列入中文索引），不能当普通话替换。

### Cited Findings
- 「Chinese+English」索引只列三套：`matcha-icefall-zh-en`、`kokoro-multi-lang-v1_0`、`kokoro-multi-lang-v1_1`。[索引](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/index.html)
- 「Chinese」索引只列：`vits-piper-zh_CN-chaowen-medium`、`vits-piper-zh_CN-xiao_ya-medium`、`matcha-icefall-zh-baker`。[索引](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese/index.html)
- 总目录还单列 Melo（中英）、Kokoro、Matcha Baker、Kitten（页面上的包名是英语 nano/mini）、以及若干 VITS 中文包。ZipVoice 在独立页，不在上述两个语言索引里。[TTS 总目录](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/index.html)、[ZipVoice](https://k2-fsa.github.io/sherpa/onnx/tts/zipvoice.html)

**中英双语（可直接对照现用 Matcha）**

- `matcha-icefall-zh-en`：来自 [modelscope dengcunqin/matcha_tts_zh_en_20251010](https://www.modelscope.cn/models/dengcunqin/matcha_tts_zh_en_20251010)。1 说话人，16000 Hz。包内 `model-steps-3.onnx` **72M**，`lexicon.txt` 1.3M，`tokens.txt` 21K，另有 `espeak-ng-data`、`phone-zh.fst` / `date-zh.fst` / `number-zh.fst`。压缩包 [75.4 MB](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)。声码器 `vocos-16khz-univ.onnx` 文档 `ls` 为 **51M**，release 资产 **51.4 MB**。没有单独声码器以外的说话人嵌入。参数量、许可证，sherpa 这一页都没写。[样本页](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/matcha-icefall-zh-en.html)、[vocoder-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/vocoder-models)
- 维护者示例里还出现过 `model-steps-6.onnx`（2025-11-10 的 PR，以及 2025-12-04 的英文修复）。**当前 release 包里列出的是 steps-3，不是 steps-6。** [PR 2763](https://github.com/k2-fsa/sherpa-onnx/pull/2763)、[PR 2853](https://github.com/k2-fsa/sherpa-onnx/pull/2853)
- `kokoro-multi-lang-v1_0`：来自 kokoro-onnx v0.2.0。文档标题写 **53** 个说话人，同一页正文写 **54** 个、sid `0–53`。Hugging Face 发布表写 v1.0 为 8 种语言、54 个声音；sherpa 明确说多语模型但**只加了英语和中文前端**。采样率固定 **24000 Hz**。`model.onnx` **310M**，`voices.bin` **26M**，`lexicon-us-en.txt` 5.6M，`lexicon-gb-en.txt` 6.0M，`lexicon-zh.txt` 2.3M，`tokens.txt` 687B，包内有 LICENSE 11K。压缩包 fp32 **333.7 MB**，int8 **126.2 MB**。int8 包内部的 onnx 尺寸没有 `ls`。[Kokoro 文档](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html)、[HF 发布表](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)、[tts-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)
- `kokoro-multi-lang-v1_1`：即 [hexgrad/Kokoro-82M-v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)（2025-02-26）。**82M 参数**，与 Kokoro-82M 相同架构（StyleTTS 2 + ISTFTNet，decoder only，无 diffusion）。语言：英语 + 中文。**103** 说话人，24000 Hz：sid 0–1 `af_*` 美式女声 2 个，sid 2 `bf_vale` 1 个，sid 3–57 `zf_*` 中文女声 55 个，sid 58–102 `zm_*` 中文男声 45 个。样本页配置 `lexicon-us-en.txt,lexicon-zh.txt`，但**没有**像 v1.0 那样给出 `ls` 后的 onnx / voices 字节数。压缩包 fp32 **348.0 MB**，int8 **140.2 MB**。模型卡写明 “This Apache licensed model”；上游仓库 [hexgrad/kokoro](https://github.com/hexgrad/kokoro/) 为 Apache-2.0，并称权重为 Apache。中文数据由 LongMaoData 许可提供；另有 3 小时合成英语（Maple / Sol / Vale）。作者说明 v1.1-zh **不是** v1.0 的严格升级，因为丢掉了许多 v1.0 声音。[样本页](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html)
- `vits-melo-tts-zh_en`：由 [myshell-ai/MeloTTS-Chinese](https://huggingface.co/myshell-ai/MeloTTS-Chinese) 转来。1 说话人，**44100 Hz**，`model.onnx` **163M**，`lexicon.txt` **6.5M**，`tokens.txt` 655B，包内 LICENSE 1.0K（正文未打开）。压缩包 **159.3 MB**。文档写明支持中文和英语。[VITS 文档](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html)
- ZipVoice（零样本克隆，不是普通多说话人 TTS）：文档给出的命令用 `sherpa-onnx-zipvoice-distill-int8-zh-en-emilia` 的 `encoder.int8.onnx` + `decoder.int8.onnx`，外加 `vocos_24khz.onnx`，以及 lexicon、tokens、`espeak-ng-data`。必须同时提供 `--reference-audio` 和与之**逐字一致**的 `--reference-text`，并用 `--num-steps`（示例为 4）。文档称该示例模型为中英双语。压缩包：distill-int8 **104.1 MB**，distill-fp32 **455.7 MB**，非 distill 的 zh-en 与 distill 旧资产各约 **605 MB**。`vocos_24khz.onnx` **51.6 MB**。参数量、说话人数、许可证、包内各 onnx 的 `ls` 尺寸，这一页都没有。[ZipVoice](https://k2-fsa.github.io/sherpa/onnx/tts/zipvoice.html)、[tts-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)

**纯普通话（官方写成 Chinese，不是中英）**

- `matcha-icefall-zh-baker`：只支持中文，1 女声，**22050 Hz**。`model-steps-3.onnx` **72M**，`lexicon.txt` 1.3M，`tokens.txt` 19K。压缩包 **72.0 MB**。示例声码器 `vocos-22khz-univ.onnx` **51M**（release **51.4 MB**）。文档写可以用 hifigan_v1 / v2 / v3 代替 Vocos；release 上这三份分别是 **53.2 / 3.6 / 5.6 MB**。训练数据来自 DataBaker 免费数据集，sherpa 原文：“The dataset is for **non-commercial** use only.” [Matcha 文档](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/matcha.html)、[Baker 样本页](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese/matcha-icefall-zh-baker.html)
- Piper：`vits-piper-zh_CN-chaowen-medium` 与 `vits-piper-zh_CN-xiao_ya-medium` 均来自 [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN) 的对应子目录，**1 说话人，22050 Hz**。v2 示例走包内 `lexicon.txt`，不走 `data_dir`。压缩包：chaowen **57.6 MB**（int8 **13.4 MB**，fp16 **27.8 MB**），xiao_ya **57.7 MB**（int8 **13.4 MB**，fp16 **27.8 MB**）。包内 onnx 的未压缩尺寸没有在已打开的页面上给出。sherpa 页面没有引用 LICENSE 正文。[chaowen](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese/vits-piper-zh_CN-chaowen-medium.html)、[xiao_ya](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese/vits-piper-zh_CN-xiao_ya-medium.html)
- 同一 release 还有更早的 `vits-piper-zh_CN-huayan-medium.tar.bz2` **64.1 MB**，但 2026-11 的中文索引没有它。没有打开它的样本页，所以说话人数和采样率不在本笔记里写死。
- `vits-icefall-zh-aishell3`：icefall 在 AISHELL-3 上训练，**只支持中文，174 说话人**（sid 0–173）。`model.onnx` **29M**。压缩包 **30.1 MB**。同一篇 VITS 文档的汇总表把 “aishell3” 写成 **116 MB、8000 Hz**；RTF 表最后一列是 **30 MB**。29M 的 `ls` 旁边没有再打印采样率。[VITS 文档](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html)
- release 上另有 `vits-zh-aishell3.tar.bz2` **140.1 MB**。当前文档的 AISHELL-3 小节下载的是 icefall 那份 30.1 MB，不是这一份。
- 文档汇总表里的其它普通话 VITS（“Model filesize” 列，不是压缩包）：`sherpa-onnx-vits-zh-ll` 5 说话人、16000 Hz、115 MB；`vits-zh-hf-fanchen-C` 187 说话人、16000 Hz、116 MB；`vits-zh-hf-fanchen-wnj` 1 男声、16000 Hz、116 MB；`vits-zh-hf-theresa` 804 说话人、22050 Hz、117 MB；`vits-zh-hf-eula` 804 说话人、22050 Hz、117 MB。对应压缩包约 113.3–115.0 MB。这些行都标成 Chinese，没有写中英。[VITS 文档](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html)、[RTF 表](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/rtf.html)
- 同一 release 还有文档汇总表未逐条展开、但文件名是中文 VITS 的包，压缩包均约 113.6–115.0 MB：`vits-zh-hf-bronya`、`echo`、`abyssinvoker`、`keqing`、`doom`、`zenyatta`，以及 fanchen 的 `ZhiHuiLaoZhe`、`ZhiHuiLaoZhe_new`、`unity`。本轮没有打开每个样本页，说话人数不以文件名推测。[tts-models 资产列表](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)

**粤语，以及名字里像“新 TTS”但不是普通话包的**

- `vits-cantonese-hf-xiaomaiiwn.tar.bz2` **103.0 MB** 在 `tts-models` 里。没有打开样本页，不能说它是否也会普通话。它不在普通话索引里。
- sherpa 已发的 Kitten 资产都是 `kitten-*-en-*`（nano/mini/micro，fp16/fp32/int8，压缩包约 25–149 MB）。C API 示例是 `kitten-nano-en-v0_1-fp16` 加 `lexicon-en-us.txt`。上游 KittenTTS 2 自称含中文，但那不是这些 sherpa 英语包；上游还写模型许可证与代码 Apache-2.0 分离，KittenTTS 2 为 Stellon Labs Community License。[C API](https://k2-fsa.github.io/sherpa/onnx/c-api/html/tts.html)、[KittenML/KittenTTS](https://github.com/KittenML/KittenTTS/)
- Pocket 与 Supertonic 在 C API 里有英文示例包：`sherpa-onnx-pocket-tts-int8-2026-01-26`（压缩包 int8 **93.8 MB**、fp32 **160.4 MB**）、`sherpa-onnx-supertonic-3-tts-int8-2026-05-11`（**122.8 MB**）和更早的 `sherpa-onnx-supertonic-tts-int8-2026-03-06`（**80.8 MB**）。二者自带文本前端，不需要 lexicon。Pocket 上游 README 的语言列表是英、法、德、葡、意、西、荷，没有中文；并写 100M 参数、以及更小的英语变体。Supertonic 3「31 种语言、没有中文」来自 2026-11-11 的二手对比文，不是 sherpa 文档。[Pocket README](https://github.com/kyutai-labs/pocket-tts/)、[二手对比](https://ai-opensource.com/news/tiny-text-to-speech-models-run-on-a-cpu/)

### Inferences
- 和现用栈（`matcha-icefall-zh-en` 的 `model-steps-3.onnx` + `vocos-16khz-univ.onnx`）文件名一致的，就是官方仍在发的那一包：声学模型 72M + 声码器约 51M，再加不到 2M 的词典和 FST。
- 若只看「官方标明中英、且是普通 TTS 而不是克隆」：Matcha zh-en、Kokoro v1.0/v1.1、Melo 四选一。ZipVoice 是另一类 API。
- Baker 的非商业限制写在数据集上，不能套到 zh-en 那一包；zh-en 的许可证要单独看 ModelScope，而本轮没有拿到模型卡正文。

### Gaps
- `matcha-icefall-zh-en` 的许可证和参数量：ModelScope 页面抓取几乎是空的。一份 AI 生成的 AtomGit 卡片写 Apache-2.0 和约 300M 参数；300M 的 fp32 权重量级是 GB，与官方 72M 的 onnx 对不上，该卡片不作数。gomodels/sherpa 的转载仓写全集 Apache-2.0，并单独提醒 DataBaker 非商业，仍不是 dengcunqin 模型卡原文。
- Kokoro v1.1 fp32/int8 包内 `model.onnx` 与 `voices.bin` 的未压缩尺寸没有 `ls`。v1.0 标题 53 与正文 54 说话人互相矛盾，以 Hugging Face 的 54 和 sherpa 正文 sid `0–53` 更一致，但没有第三处官方勘误。
- Melo 包内 LICENSE 只有 1.0K 的 `ls`，正文未读。Piper zh、ZipVoice、粤语包、各 `vits-zh-hf-*` 的许可证页面都没打开；角色音色（原神等名字）还有肖像/声音权，sherpa 汇总表没有声明。
- ZipVoice 各 onnx 分文件大小、参数量、采样率（只知道声码器文件名是 24 kHz Vocos）、RTF 均未在已打开的 sherpa 页给出。
- `vits-piper-zh_CN-*` 未压缩 onnx 大小、huayan 的采样率/说话人数、粤语包是否含普通话，本轮没有打开对应文件。
- icefall AISHELL-3 的采样率：汇总表写 8000 Hz，但同一行的 116 MB 和后文 29M 的 `ls` 冲突，不能把 8000 Hz 当成已核实。

## 各模型公布的 CPU RTF、内存，以及第一包 PCM 要等多久？

### Takeaway
官方速度数字全部来自树莓派 4。Matcha Baker 在 2 线程 RTF 0.536，是表上唯一接近「1–2 线程还能实时」的中文 Matcha；Kokoro fp32 在同一台机器 2 线程 RTF 约 4.5，Melo 约 3.9，都远慢于实时。**没有 int8 的官方 RTF，没有 x86 RTF，没有 RAM 数字。** 第一段音频要等一整句（或一个音素块）合成完，回调里才能拿到 PCM，不是逐帧流式。

### Cited Findings
RTF 定义沿用 sherpa 示例：耗时 / 音频时长。下表为 Raspberry Pi 4 Model B Rev 1.5，列是 1/2/3/4 线程。来源：[RTF 表](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/rtf.html)，Kokoro 的测量命令写在 [Kokoro 文档的 v1.0 小节](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html)（命令用的是 `kokoro-multi-lang-v1_0/model.onnx`）。

| 模型 | 1 线程 | 2 | 3 | 4 | 表上的体积列 |
| --- | --- | --- | --- | --- | --- |
| matcha-icefall-zh-baker + vocos-22k | 0.892 | 0.536 | 0.432 | 0.391 | 73 MB |
| vits-icefall-zh-aishell3（表名 aishell3） | 0.365 | 0.220 | 0.171 | 0.156 | 30 MB |
| vits-zh-ll | 4.275 | 2.494 | 1.840 | 1.593 | 116 MB |
| vits-zh-hf-fanchen-C | 4.306 | 2.451 | 1.846 | 1.600 | 116 MB |
| vits-zh-hf-fanchen-wnj | 4.276 | 2.505 | 1.827 | 1.608 | 116 MB |
| vits-zh-hf-theresa | 6.032 | 3.448 | 2.566 | 2.210 | 117 MB |
| vits-zh-hf-eula | 6.011 | 3.473 | 2.537 | 2.231 | 117 MB |
| vits-melo-tts-zh_en | 6.727 | 3.877 | 2.914 | 2.518 | 163 MB |
| kokoro（见下，数字与 v1.0 测量相同） | 7.635 | 4.470 | 3.430 | 3.191 | 311 MB |

- RTF 表把 7.635 那一行标成 `kokoro-multi-lang-v1_1`，体积 311 MB。详细测量命令用的是 **v1.0** 的 `model.onnx`，而 v1.0 的 `ls` 正是 **310M**。v1.1 压缩包是 348.0 MB，对不上 311 MB。因此这组 RTF 可以确定是 **v1.0 fp32 在 Pi 4 上**；把它当成 v1.1 或 int8 没有依据。
- `matcha-icefall-zh-en` **不在** 官方 RTF 表。唯一公开数字是用户在 12 核 Arm Cortex-A78AE 上、`num_threads=4`、2025-11-11 的自测 **RTF=0.103**。维护者没有给出对齐后的官方 RTF。同一帖里 Kokoro 示例在该板上墙钟 6–12 秒，但没有音频时长，算不出 RTF。[issue 2762](https://github.com/k2-fsa/sherpa-onnx/issues/2762)
- 英文 Piper（glados / lessac / libritts medium）在同一张 Pi 4 表上 2 线程 RTF 约 0.48–0.49、体积 61–75 MB。**中文 Piper（chaowen / xiao_ya / huayan）没有 RTF 行。** 不能用英文 Piper 的 RTF 代替。
- Matcha / Kokoro 的 `Generate` 是离线实现：回调在**这一块样本已经生成之后**才被调用，并且注释写明回调返回后缓冲会被释放，调用方必须在回调内拷贝。音素输入会按标点切开，默认单句大约最多 200 个 codepoint。[offline-tts-matcha-impl.h](https://github.com/k2-fsa/sherpa-onnx/blob/9a2737b3/sherpa-onnx/csrc/offline-tts-matcha-impl.h)
- Kokoro 模型卡：decoder only，无 diffusion。这只说明它不是扩散模型，**没有** sherpa 侧的首包毫秒数。[HF 模型卡](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)
- ZipVoice 用 `--num-steps` 做质量/速度折中；文档没有 RTF，也没有首包延迟。Pocket 上游自称 M4 上约 6 倍实时、首包约 200 ms，那是 Pocket 自己的运行时，不是 sherpa 中文包，也不是 i5-8260U。
- v2.0.1 有一项实现说明：Kokoro int8 量化时把 STFT 卷积保持为 float32。[CHANGELOG 2.0.1](https://github.com/k2-fsa/sherpa-onnx/blob/master/CHANGELOG.md) 没有伴随的 int8 vs fp32 RTF。

### Inferences
- 在目标机「1–2 线程、还要同时跑 VAD 和 SenseVoice、播放从第一块 PCM 开始」的约束下，官方数字只支持 Matcha Baker 和 icefall AISHELL-3 这一档（Pi 4 上 2 线程 RTF 0.22–0.54）。i5-8260U 比 Pi 4 的 A72 快，但快多少没有公布，不能把 Pi 4 的 RTF 4.5 直接换成「这台超极本一定不实时」或「一定实时」。
- 现用 Matcha zh-en 与 Baker 同是 72M 的 `model-steps-3.onnx`，声码器同属 Vocos 约 51M，只是 16 kHz 对 22 kHz。A78AE 上 4 线程 RTF 0.103 说明在比 Pi 4 更强的 ARM 上它很富余；这不能外推成 i5-8260U 的 1 线程数字，但量级上它是轻量档，不是 Kokoro/Melo 那一档。
- 首包延迟 ≈ 第一句的整句合成时间。句子越长，播放起音越晚。`max_num_sentences` 和按标点切块只能把等待切到「第一句」，不能切到第一个音素帧。
- int8 能把 Kokoro 下载从约 334–348 MB 降到 126–140 MB，但是否把 Pi 4 上 4.5 的 RTF 拉进实时，没有测量。

### Gaps
- i5-8260U、任何 x86、以及 1–2 线程下 Matcha zh-en / Kokoro int8 / Piper zh / ZipVoice 的 RTF：未找到。
- 进程 RSS、峰值 RAM：未找到。
- 首包毫秒数：未找到。只有「回调发生在整块样本完成之后」。
- Baker 的 RTF 用的是 vocos-22k，没有 hifigan_v2（3.6 MB）的对照 RTF。
- steps-3 与 steps-6 的速度差：未公布。

## 文本怎么进去？未知英语是跳过、拼读，还是音素化？

### Takeaway
v2.0.0（2026-10-23）起，sherpa-onnx **不再内置 espeak-ng / piper-phonemize**。`data_dir` 被忽略。剩下两条路：词典查词，或调用方事先音素化后经 `phoneme_codepoints` / `tokens` 传入。词典未命中时，当前 master **丢掉该词并打日志，不拼读、不自动 G2P**。维护者在 2026-10-30 明确拒绝在库内加 G2P 模型。这就是 Kokoro 把 “Kubernetes” 念丢、把词典里的 “hello” 留下的原因。Matcha 的音素路径对不在 `tokens.txt` 里的符号同样丢弃，日志是 `Skip unknown token`。

### Cited Findings
- v2 变更说明：v1 用 `--vits-data-dir`（或模型配置的 `data_dir`）在库内跑 espeak。v2 起 `data_dir` 废弃并忽略；若只给原文、没有词典也没有音素，报错 `phoneme_codepoints is empty, no lexicon, and no frontend available`。替代是 (1) 词典，或 (2) 库外用 piper-phonemize 音素化，再把结果传进去。官方示例包括 `test-offline-tts-matcha-en-phonemize.py`、`test-offline-tts-kokoro-en-phonemize.py`、`test-offline-tts-zipvoice-phonemize.py`、`test-offline-tts-kitten-phonemize.py`。espeak 的 voice（如 `en-us`）只属于外部音素器；包里的 `espeak-ng-data` sherpa 自己不再读。[v1 到 v2 的 espeak 说明](https://k2-fsa.github.io/sherpa/onnx/faqs/update-v1.x-to-v2.x-espeak-ng.html)
- C API：多数家族要 lexicon；Pocket 与 Supertonic 自带前端。也可以让 lexicon 为空，改传 `SherpaOnnxGenerationConfig::phoneme_codepoints` 或 `::tokens`。[C API TTS](https://k2-fsa.github.io/sherpa/onnx/c-api/html/tts.html)
- Matcha 实现（`offline-tts-matcha-impl.h`，检索到的 blob `9a2737b3`）三条相关行为：
  - 拉丁词不在词典：先按连字符拆开再查；仍没有则 `OOV word skipped`，该词不进入 token 序列。
  - CJK 不在词典：拆成单字再查；单字也没有则 `OOV character skipped`。
  - `phoneme_codepoints` 且 token 是多字符（拼音这类，注释举例 `"dang1"`）：按空格切开，每个片段必须在 `token_str2id_`（即 `tokens.txt`）里，否则 `Skip unknown token`。
  - 回调只在该块 PCM 完成后触发。[源文件](https://github.com/k2-fsa/sherpa-onnx/blob/9a2737b3/sherpa-onnx/csrc/offline-tts-matcha-impl.h)
- Kokoro 配置允许多个词典，逗号分隔，例如 `lexicon-us-en.txt,lexicon-zh.txt`；注释写后加载的文件覆盖先前的同词条。[offline-tts-kokoro-model-config.h](https://github.com/k2-fsa/sherpa-onnx/blob/c6691594/sherpa-onnx/csrc/offline-tts-kokoro-model-config.h)
- 2026-10-29 issue 4139（仍开放，维护者 2026-10-30 回复）：自 #4055 移除 espeak 后，**2.0.1 的 Kokoro 英语前端只靠词典**。不在词典里的词被丢掉。“The budget is 1969 dollars” 会念成 “The budget is dollars”；自造词 “Hedy / Paradee / Xylophonix” 整词消失。#4075 修的是标点和词边界，**数字、货币、未知人名仍然消失**。维护者原话方向：数字用 FST；未知词则 “We ignore OOVs”，可以往 `lexicon.txt` 加词，或在送进 sherpa 之前自己 tokenize。**不希望内置 G2P 模型**，因为每种语言一个模型，维护成本太高。[issue 4139](https://github.com/k2-fsa/sherpa-onnx/issues/4139)
- 2026-11-20 issue 4247（仍开放）：即使用较新的 sherpa，Kokoro 仍会漏词。机器人对照当时的 master：未命中英语词日志为 `OOV word skipped`，该路径没有音素器回退。缺失的不只是专名，还有 her、or、per、seem、technician，以及 offence、programme、organisation 等英式拼写。变通仍是另写一份 lexicon，用逗号接在后面，音素必须来自该模型的 `tokens.txt`，不支持的音素会被丢掉。[issue 4247](https://github.com/k2-fsa/sherpa-onnx/issues/4247)
- 更早的预期行为（2024-06，英语 VITS，已关闭）：`ConvertTextToTokenIdsNotChinese` 日志 `OOV {word}. Ignore it!`。维护者说词典不可能收进所有英语词；要用 espeak 的 Piper、字符模型，或自己把 OOV 写进 lexicon。当时「改用 Piper 就没有 OOV」依赖的是**库内 espeak**，这条在 v2 已不成立。[issue 929](https://github.com/k2-fsa/sherpa-onnx/issues/929)
- Matcha zh-en 的设计（仍是 v1 时代的命令行）：中文走 `lexicon.txt`，**英语不需要英文 lexicon**，靠 `--matcha-data-dir=espeak-ng-data`。PR 2763（2025-11-10）和 PR 2853（2025-12-04，标题 “Fix the English part for Matcha TTS”）都是这样写的。2853 还感谢 dengcunqin 提供英语 G2P 脚本。[PR 2763](https://github.com/k2-fsa/sherpa-onnx/pull/2763)、[PR 2853](https://github.com/k2-fsa/sherpa-onnx/pull/2853)
- 因此 zh-en 包里那份 1.3M 的 `lexicon.txt` 与 Baker 的中文词典同量级，包内虽然带着 `espeak-ng-data`，在 **2.0.3 里 sherpa 不会读它**。英语只能来自外部音素，或来自你另外接上的英文词典。
- Melo 文档直接写：英语词只有出现在 `lexicon.txt` 里才会被念；加词见 PR 1209。它的 lexicon 是 6.5M，比 Matcha 的 1.3M 大，但仍然是闭集。[VITS 文档](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html)
- 2025-11-11，在 Matcha zh-en 刚接上时，用户反馈英文「很生硬，很难听懂」，维护者指向 ModelScope 模型卡，并说那里已经写了**英文效果不好**。本轮没抓到模型卡正文，这句话的出处是维护者回复，不是独立测听。[issue 2762](https://github.com/k2-fsa/sherpa-onnx/issues/2762)
- Piper zh 的 v2 示例把 `lexicon` 设为包内 `lexicon.txt`。页面把它们标成中文模型，没有承诺英语。未知词会落到上面的词典 OOV 路径，但是否真的零英语词条，没有打开 lexicon 核对。
- ZipVoice 同样有库外音素化示例（FAQ 列出 `test-offline-tts-zipvoice-phonemize.py`），同时命令行仍接受 `--zipvoice-lexicon` 和 `--zipvoice-data-dir`。v2 下 `data_dir` 被忽略，所以 ZIP 的 espeak 目录也只对外置音素器有用。
- 2026-10-21 维护者对**西班牙语** Kokoro 表示可以同时做 lexicon 和 C++ G2P（issue 3731 评论）。这是西语，而且 9 天后的 4139 对英语未知词的决定仍是忽略 OOV、不加 G2P 模型。不能把它读成「英语 OOV 已有内置回退」。

### Inferences
- Turnline 现在的前端（中文 pypinyin TONE3，拉丁片段 piper_phonemize / espeak en-us，再丢掉不在 `tokens.txt` 的 token）就是 v2 要求的「库外音素化」。英语被跳过，是因为 espeak `en-us` 的符号没有全部落在 Matcha zh-en 那份 21K 的 `tokens.txt` 里，实现会 `Skip unknown token`。这和 Kokoro 的 `OOV word skipped` 不是同一行日志，但是同一类结果：没映射上的片段不进声学模型。
- 把 Kokoro 换成「仍喂原始英文词」不会解决 Kubernetes。hello 在美式词典里，Kubernetes 不在，所以一个念、一个丢。要念出来，必须在进 sherpa 之前变成 **该模型 tokens.txt 里存在的音素**（Misaki 音素，或 espeak 再映射到 Kokoro 的 token），走 `phoneme_codepoints`；或者把词条追加进 lexicon。逐字母拼读只有在字母本身是合法 token 时才会出声。
- Matcha zh-en 的英语音质上限，维护者已经按模型卡说「不好」。即便 token 对齐、词不再被丢，也不等于英语变得能听。这是模型问题，不是 2.0.3 的一个小 bug。

### Gaps
- 没有逐行核对 `matcha-icefall-zh-en/tokens.txt` 与 espeak `en-us` 符号的差集，所以不能列出具体缺哪些音素。
- 没有在 Kokoro `lexicon-us-en.txt` 里检索 “Kubernetes”。issue 4247 已说明连一些常用词都缺，专名覆盖不能假设为完整；具体缺词表没有在本轮生成。
- Piper zh、AISHELL-3、fanchen 各包的 lexicon 是否含任何英语词：未打开文件。
- `phoneme_codepoints` 若传入的是 IPA 码点而该模型用拼音式多字符 token，会走另一分支。本笔记只确认了「多字符 token 查 `tokens.txt`，查不到就 Skip」这一支，因为这和「pypinyin TONE3 + 丢掉未知 token」的描述一致。

## 谁有持续维护的中英词典？覆盖专名还是常用词？

### Takeaway
有现成双语词典的是 Kokoro（美式/英式英语 + 中文拼音）和 Melo（一份 6.5M 的 `lexicon.txt`）。两者都是闭集：Kokoro 英语来自 Misaki 的 gold/silver 常用词，中文来自 pypinyin 的字表和短语表；技术专名不在设计目标里。Matcha zh-en 官方并没有英文词表，英语原来靠 espeak。

### Cited Findings
- Kokoro v1.0 包内同时有 `lexicon-us-en.txt`（5.6M）、`lexicon-gb-en.txt`（6.0M）、`lexicon-zh.txt`（2.3M）。v1.1 样本页同样要求 us-en 与 zh 两份，逗号拼接。[Kokoro 文档](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html)、[v1.1 样本页](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html)
- issue 4247 的回复写：英语词典生成器的底表是 **Misaki 的 US/GB gold 与 silver**，并支持 `user_defined` 追加。2026-11-20 仍有常用词和英式拼写缺失。缩写被描述成「至少好绕过」。[issue 4247](https://github.com/k2-fsa/sherpa-onnx/issues/4247)
- 中文词典生成脚本 `scripts/kokoro/v1.1-zh/generate_lexicon_zh.py`：用 `misaki.zh`（version `"1.1"`）和 pypinyin。遍历 pypinyin 的 CJK 统一表意文字单字，再遍历 pypinyin 短语表。另有一小份用户短语（「还田」「行长」「银行行长」）。输出是「词 + 空格分隔的 token」。这是通用拼音覆盖，不是技术专名词表。[生成脚本的提交副本](https://gitlab.xuedianyun.com/xuning/sherpaonnx/commit/dfcbc8d40b222296d855a526f61261b00e0a792d)
- Melo：英语只念 lexicon 里有的词；lexicon 6.5M。加词流程在 PR 1209，说明维护方式是手工补词典，不是开放词表 G2P。[VITS 文档](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html)
- Matcha zh-en / Baker：lexicon 1.3M，配套的是中文 phone/date/number FST。zh-en 的 PR 写明英语不要英文 lexicon，用 espeak。Baker 页面写 `dict` 目录已不再需要。[zh-en 样本页](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/matcha-icefall-zh-en.html)、[PR 2763](https://github.com/k2-fsa/sherpa-onnx/pull/2763)
- 多个词典文件时，后者覆盖前者。因此可以加一份很小的 `user-lexicon.txt` 接在官方文件后面，而不改官方文件。音素必须属于该模型 `tokens.txt`。[Kokoro 配置头文件](https://github.com/k2-fsa/sherpa-onnx/blob/c6691594/sherpa-onnx/csrc/offline-tts-kokoro-model-config.h)、[issue 4247](https://github.com/k2-fsa/sherpa-onnx/issues/4247)
- 数字：Kokoro 英语在 2.0.1 仍会把 “1969” 整段丢弃。中文侧 Matcha/Melo/AISHELL-3/Kokoro v1.0 包内带 `number.fst` / `date.fst` / `phone.fst`，文档示例用它们做中文数字、日期、电话的规则展开。这是中文 FST，不是英语数字展开。维护者希望英语数字也走 FST，但 4139 里这还是待做，不是 2.0.3 已发布功能。[issue 4139](https://github.com/k2-fsa/sherpa-onnx/issues/4139)

### Inferences
- 「有中英词典」不等于「技术英语不会丢」。Kokoro 的英语词典是常用词闭集；Turnline 已经看到的 Kubernetes 被跳过，和 4247 里 technician、downloadable 被跳过是同一机制。
- 中文侧覆盖较好：单字走 pypinyin 字表，多音和少量短语有专门条目。这不能外推到英语专名。
- 对未知英语，可持续的做法是库外 G2P（他们已经在用的 piper_phonemize，或 Kokoro 对应的 Misaki），再映射到目标 `tokens.txt`。补词典只适合高频词，不适合开放的产品名。

### Gaps
- Misaki gold/silver 的词条数没有在 sherpa 文档给出。5.6M / 6.0M 是文件大小，不是词数。
- Melo lexicon 的英语词头规模、是否含技术词：未统计。
- 没有核对 pypinyin 短语表的版本日期，不能声称「词典仍在每月更新」。能说的是生成脚本仍在 Kokoro v1.1-zh 的转换目录里，词表内容是 pypinyin 自带字典加上少量手写短语。

## 有没有比 2.0.3 更新、并且修好 OOV 或换上更好双语模型的版本？

### Takeaway
没有。2026-11-24 能看到的最新版本就是 **v2.0.3（2026-11-22）**。OOV 丢词是 2.0.0 去掉 espeak 之后的既定行为，2.0.1 的维护者拒绝内置 G2P，2.0.2 和 2.0.3 的变更列表里没有「未知英语改为拼读或音素化」。比 2.0.3 更新的双语声学模型也没有出现在 `tts-models` 的中英索引里。

### Cited Findings
- 发布页顶部是 v2.0.3，2026-11-22，commit `38016c6`。该版变更是说话人日志、Pali TTS APK、Whisper 语言概率、PocketTTS README 的许可证注记（改为 CC-BY-4.0，不是非商业）、w2v-BERT 导出、示例里的 piper phonemize 升到 1.6.1、Linux x64 node-addon 构建。**没有 TTS 前端 OOV 修复，没有新的中英模型。** [Releases](https://github.com/k2-fsa/sherpa-onnx/releases)、[v2.0.3 变更列表](https://github.com/k2-fsa/sherpa-onnx/releases)
- v2.0.2（2026-11-19）：词典路径相对模型目录解析（Android）、Pali lexicon。没有英语 G2P。[CHANGELOG](https://github.com/k2-fsa/sherpa-onnx/blob/master/CHANGELOG.md)
- v2.0.1：Kokoro int8 时 STFT 卷积保持 fp32。没有 OOV 行为变更。
- v2.0.0（2026-10-23）：`Remove espeak-ng and piper-phonemize`（#4055）；`Fix word boundaries, OOV words and Unicode handling in lexicon TTS`（#4075）。4139 的作者把 #4075 的效果限定为标点/边界，未知词和数字仍然消失。[v2.0.0](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.0)、[issue 4139](https://github.com/k2-fsa/sherpa-onnx/issues/4139)
- 2.0.0 的说明页把 piper-phonemize 留在库外，理由是 espeak-ng 为 GPL，sherpa-onnx 本身要保持无 GPL。[FAQ](https://k2-fsa.github.io/sherpa/onnx/faqs/update-v1.x-to-v2.x-espeak-ng.html)
- Matcha 中英支持更早：#2763 在 2025-11-10 合并，#2853 在 2025-12-04 修英语，1.12.19/1.12.20 的 changelog 有 “Fix the English part for Matcha TTS” 和中英 APK。那是 **1.12.x，且依赖 data_dir=espeak**。升到 2.0.3 不会带回这条路径。
- issue 4139 截至 2026-10-30、issue 4247 截至 2026-11-20 仍开放。4247 对照的是 2026-11-20 的 master，仍是 `OOV word skipped`。2.0.3 在那之后两天发布，changelog 未声称已修。
- 2026 年新进 `tts-models` 的 Pocket、Supertonic 不是中英普通话包（见第一节）。

### Inferences
- 为了「未知英语不要丢」而从 2.0.3 再往上升级，目前没有可升的版本。
- 若目标是恢复「库内 espeak 直接念英语」，那是退回 1.12.x（Matcha zh-en 的 data_dir 路径在 1.12.19 之后），不是升级。v2 的替代是继续在进程外调用他们已经依赖的 piper_phonemize，把结果送进 `phoneme_codepoints`，并保证每个 token 都在 `tokens.txt`。
- 2.0.3 的 “Update piper phonemize in examples to v1.6.1” 只更新示例所用的**外部**音素器，不表示库内恢复了音素器。

### Gaps
- 没有逐提交核对 2026-11-20 的 master 与 v2.0.3 tag（2026-11-22）之间是否有未写入 changelog 的前端提交。公开 changelog 和两份仍开放的 issue 都不支持「已经修好」。
- 1.12.x 最后一个仍带 espeak 的具体小版本，本轮没有单独标出；能确定的是移除发生在 2.0.0 的 #4055，Matcha 中英的 espeak 用法在 1.12.19 的 #2853 还在。

## 哪一个离现有 Matcha 最近，哪一个是 sherpa 里更好的体积/音质折中？

### Takeaway
改动最小的是继续用 `matcha-icefall-zh-en` + `vocos-16khz-univ.onnx`，不要换声学模型。英语丢词要用现有外部音素器对齐 `tokens.txt`，而不是换包。若目标是「英语专名真的被念出来，而且英语能听」，sherpa 里唯一标成中英、又有 82M 多说话人、许可证写明 Apache 的是 **Kokoro v1.1-zh int8（压缩包 140.2 MB，24000 Hz，103 说话人）**；它必须走库外音素或自建词条，原始文本仍会丢 OOV。它在 Pi 4 上的 fp32 近亲是 2 线程 RTF 4.5，int8 在 i5-8260U 上快不快没有公布。Melo 更大更慢，而且同样丢 OOV。Piper int8 最小（13.4 MB）但是普通话包，不是中英包。

### Cited Findings
- 现用文件名与官方包一致：`model-steps-3.onnx` 72M、16000 Hz、1 说话人、`vocos-16khz-univ.onnx` 约 51M。这就是 `matcha-icefall-zh-en`，不是另一套同名模型。[样本页](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/matcha-icefall-zh-en.html)
- 该模型的英语路径在 v1 是 espeak（`data_dir`），词典是中文。v2.0.3 忽略 `data_dir`。音素路径对未知 token 的行为是跳过而不是拼读（上一节）。
- 维护者 2025-11-11 认为该模型英文效果不好，依据是作者的 ModelScope 说明。用户同时给出 A78AE、4 线程 RTF 0.103。[issue 2762](https://github.com/k2-fsa/sherpa-onnx/issues/2762)
- Kokoro v1.1-zh：82M、Apache、103 个中英说话人、24000 Hz、int8 压缩包 140.2 MB。原始英语 OOV 会被跳过；`phoneme_codepoints` 是 v2 的正式入口。fp32 v1.0 在 Pi 4 上 2 线程 RTF 4.470；v1.1 int8 无官方 RTF。[HF](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)、[RTF 表与测量命令的不一致见上一节](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html)
- Melo：163M onnx、44.1 kHz、1 说话人、Pi 4 上 2 线程 RTF 3.877，英语仅限 lexicon。下载和 CPU 都差于 Matcha，OOV 行为同类，没有公布的音质优势数字。
- Piper zh int8 压缩包 13.4 MB、22050 Hz、1 说话人，是发布列表里最小的普通话包。索引把它放在 Chinese 而不是 Chinese+English。无中文 Piper RTF。
- Baker：体积与 zh-en 几乎相同，但是 22 kHz、仅中文，且数据集非商业。对「要念英语」是退步。
- icefall AISHELL-3：29M、174 说话人、仅中文、Pi 4 上 2 线程 RTF 0.220，是表上最快的中文模型。采样率记载互相矛盾。不是中英模型。
- ZipVoice distill-int8 压缩包 104.1 MB，再加 51.6 MB 的 24 kHz Vocos。要参考音频和逐字参考文本，`num-steps` 可调，有库外音素化示例。API 与 Matcha 不同，无 RTF。
- 不在候选内：Kitten 的 sherpa 包是英语；Pocket / Supertonic 的 sherpa 示例与上游语言列表不含普通话。KittenTTS 2 即使上游有中文，也还不是 `tts-models` 里的中文资产，且权重许可证单独约定。

### Inferences
- **最小改动：** 保持 Matcha zh-en + Vocos-16k。把外部 espeak/`en-us` 音素映射成 `tokens.txt` 里实际存在的符号再送入；映射失败时用该 token 集里的字母逐个送入，这样未知词会出声，而不是被 `Skip unknown token` 吃掉。这不需要新模型，也不需要升级过 2.0.3。音质上限仍是「英文效果不好」。
- **要更好的英语、且仍留在 sherpa：** Kokoro v1.1-zh int8 是唯一同时满足「官方中英、多中文说话人、82M、Apache、有 int8 包」的选项。集成成本不是换一个 onnx 路径：前端要从 Matcha 的拼音/espeak token 换成 Kokoro 的 token（或 Misaki），并走 `phoneme_codepoints`，否则 Kubernetes 会继续以 `OOV word skipped` 消失。速度是否满足「1–2 线程、旁边还有 SenseVoice」没有 x86 数据；Pi 4 上的 fp32 测量说明不能假设它和 Matcha 一样便宜。
- Melo 和 ZipVoice 都不比上面两个更贴这个约束：Melo 更慢且仍闭集；ZipVoice 要参考音频，延迟和 CPU 未公布。
- 若商业许可是硬条件，Baker 应排除。zh-en 的许可证仍未从模型卡核实，不能把它写成已确认的 Apache。Kokoro v1.1-zh 的 Apache 有模型卡和上游仓库两处表述。

### Gaps
- 没有同一台 i5-8260U、同一句中英混读上的听感或 RTF 对比。音质结论只有维护者对 Matcha zh-en 的「英文不好」，以及 Kokoro 作为 82M 双语模型的模型卡定位；没有 sherpa 官方的 MOS。
- Kokoro int8 相对 fp32 的音质损失未公布（只知道 STFT 卷积在量化时留在 float32）。
- 现有前端的 token 与 Matcha `tokens.txt` 的差集没有在本轮算出来，所以「最小改动」是对齐 token，具体改哪几个符号还要看那份 `tokens.txt`。
