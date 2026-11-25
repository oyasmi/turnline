# 高质量开源中文 TTS 能否放进轻薄本 CPU

核对日期：2026-11-24。设备约束：Intel Core i5-8260U、无独显、内存只有数 GB，且要与浏览器、SenseVoice 和本地助手共享；回复必须实时。淘汰线：CPU 上慢于实时 10 倍（RTF ≥ 10）直接出局；没有磁盘或内存数字、或没有 CPU / 小显卡推理证据的模型也不留下。数字只来自下面引用的页面；写「未知」就是没查到，不是估计。

## 参数量、检查点体积、运行时，以及有没有 CPU 证据

### Takeaway

到 2026 年 11 月，带中文权重、体积最小的「明显强于小 VITS」公开系统是 Qwen3-TTS 12Hz 0.6B（整仓约 2.49 GB）和 F5-TTS Base（约 0.34B、953 MB）。两者都没有 i5-8260U 或同级 Intel U 系列的内存与 RTF。Fun-CosyVoice3-0.5B 的最小推理文件合计约 4.43 GB，已经占满这类机器的内存预算。没有一份官方 int4/int8 中文检查点把这条线拉回到数 GB 内存加实时 CPU。

### Cited Findings

#### CosyVoice 1 / 2 / 3 与 Fun-CosyVoice

- Fun-CosyVoice3-0.5B-2512 于 2025 年 12 月发布，模型卡自称 0.5B；运行时是 PyTorch，可选 vLLM，另有 NVIDIA Triton + TensorRT-LLM 服务路径。模型卡没有给出最低 RAM/VRAM，也没有 CPU 安装说明。— [Fun-CosyVoice3-0.5B-2512](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
- 同一仓库 Hugging Face 文件接口的字节数：`llm.pt` 2,024,669,519；`llm.rl.pt` 2,024,682,701；`flow.pt` 1,329,116,148；`hift.pt` 83,202,622；`speech_tokenizer_v3.onnx` 969,451,503；`speech_tokenizer_v3.batch.onnx` 969,451,579；`campplus.onnx` 28,303,423；`flow.decoder.estimator.fp32.onnx` 1,326,216,933。只保留一份 LLM、flow、HiFT、一份 tokenizer 和 campplus 时，合计 4,434,743,215 字节（4.43 GB）。fp32 flow ONNX 与 RL 权重是额外文件，不是替代品。`CosyVoice-BlankEN` 目录的体积不在这条文件列表里。— [HF tree API](https://huggingface.co/api/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/tree/main)
- 官方路线图：2024-07 起有流式；2024-09 发布 25 Hz CosyVoice-300M；2024-12 发布 CosyVoice2-0.5B；2025-05 给 CosyVoice2 加 vLLM；2025-08 加入 Triton/TensorRT-LLM；2025-12 发布 Fun-CosyVoice3-0.5B-2512 的 base 与 RL。300M 与 0.5B 都没有附官方磁盘或内存表。— [Fun-CosyVoice3-0.5B-2512](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
- 第三方在 2026-11-21 用官方 PyTorch 路径、Intel Core Ultra 5 322（6 核、核显、无独显）测同一句约 8 秒中文：CPU 34 秒，RTF 4.6；Intel iGPU（PyTorch XPU）17.7 秒，RTF 2.1。作者写完整下载约 9.8 GB，跳过若干不用的文件后约 5.1 GB。这台 CPU 不是 i5-8260U。— [Terry L, 2026-11-21](https://terryl.in/en/blog/cosyvoice-3-voice-cloning)
- 社区 GGUF（非官方）把 LLM 压到 Q8_0 约 0.88 GiB、Q4_K_M 约 0.59 GiB、Q2_K 约 0.42 GiB，运行时是独立的 cosyvoice.cpp。模型卡写明这不是官方发布。flow 与声码器不在这些 GGUF 体积里。— [Lourdle/Fun-CosyVoice3-0.5B-2512-GGUF](https://huggingface.co/Lourdle/Fun-CosyVoice3-0.5B-2512-GGUF)
- 一个仍开放的上游 PR 给 CosyVoice3 加 llama-cpp-python。文中唯一速度表是 NVIDIA T4 上的 fp16：PyTorch RTF 约 1.17，F16 GGUF RTF 约 0.45。没有 CPU 速度。— [CosyVoice PR 1872](https://github.com/QwenAudio/CosyVoice/pull/1872)
- TensorRT-LLM 离线表（CosyVoice3 0.5B LLM + Token2Wav）batch 1 的 RTF 为 0.1091，batch 16 为 0.0501。页面没有写这张表用的 GPU 型号。— [Triton TRT-LLM CosyVoice3 README](https://github.com/funaudiollm/cosyvoice/blob/main/runtime/triton_trtllm/README.Cosyvoice3.md)
- 租卡站把 CosyVoice3 三份 fp32 权重合计写成 3.44 GB（llm 2.02 GB、flow 1.33 GB、hift 83.2 MB），并建议单路 8 GB、有 vLLM 时 12 GB。llm/flow/hift 与上面的 HF 字节数同量级，8/12 GB 是该站建议，不是官方最低内存。— [NexGPU CosyVoice](https://nexgpu.net/en/models/cosyvoice/)

#### Qwen3-TTS、Qwen2.5-Omni

- Qwen3-TTS 12Hz 的 0.6B 与 1.7B 已于 2026-01-22 发布权重；技术报告里的 25Hz 变体在 README 中写「即将发布」，这次看到的可下载行是 12Hz。语言：中、英、日、韩、德、法、俄、葡、西、意。代码路径是 PyTorch，并推荐 FlashAttention 2；vLLM-Omni 有离线推理，在线服务当时还没落地。README 没有 CPU 运行说明，也没有最低 RAM。— [QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS/)
- `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` 的 safetensors 合计 905,788,672 个 BF16 参数（含语音 tokenizer，所以大于名字里的 0.6B），仓库 `usedStorage` 为 2,493,919,668 字节（2.49 GB）。许可证标签 apache-2.0。— [HF API](https://huggingface.co/api/models/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice)
- 技术报告 Table 2：12Hz-0.6B 在并发 1 时首包 97 ms、RTF 0.288。测量条件写明是内部 vLLM V0，tokenizer 解码用了 `torch.compile` 和 CUDA Graph。GPU 型号没有点名。这是 GPU 数字。— [Qwen3-TTS Technical Report](https://arxiv.org/pdf/2601.15621)
- 一篇 2026 年 8 月的综述把 Qwen3-TTS 0.6B 写成最低约 2 GB、典型约 3 GB 显存，并在「CPU-only?」一栏写 No。显存是该文「实践中测得」的汇总数，不是 Qwen 模型卡。— [Local AI Zone, 2026-08](https://local-ai-zone.github.io/blog/local-voice-models-2026.html)
- Qwen2.5-Omni-3B 不是专用小 TTS。目录站按官方 safetensors 统计为 5.54B，BF16 权重大约 11.1 GB，并把许可证记为 qwen-research、非商用；显存表被该站标成估算。这次没有打开官方 LICENSE 文件。— [AIMap Qwen2.5-Omni-3B](https://aimap.page/zh-hans/models/compute/open-models/qwen2-5-omni-3b/)

#### Fish Speech / OpenAudio / Fish Audio S2

- 官方 S1 模型卡：S1 为 4B 且专有，权重不公开；S1-mini 为 0.5B 蒸馏，公开，CC-BY-NC-SA-4.0。语言含中文、英文及日、德、法、西、韩、阿、俄、荷、意、波、葡。卡片没有磁盘、VRAM、RTF 或 CPU 说明。— [fishaudio/openaudio-s1-mini](https://huggingface.co/fishaudio/openaudio-s1-mini)
- 官方安装文档：S2-Pro 推理「GPU memory 24 GB」，并提供 CPU 安装与只含 S2-Pro 的 CPU Docker。Drama 3 写明至少 48 GB（FP8），且只要 NVIDIA GPU，不要 CPU、MPS 或 ROCm。文档没有 S2-Pro 的 CPU RTF，也没有参数量。— [Fish Audio install](https://speech.fish.audio/install/)
- 租卡站综述（二手）：S2-Pro 约 4B 慢自回归 + 400M 快自回归，合计约 5B，官方门槛 24 GB；S1-mini bf16 权重约 1 GB，该站把 4 GB 当作沿用 1.x 的估计，并声明没有单独的官方部署数字；Fish Speech 1.5 的官方数字是推理 4 GB、微调 8 GB，许可证 CC-BY-NC-SA-4.0。同一页把 S2 的许可证写成 FISH AUDIO RESEARCH LICENSE。这些除 24 GB 以外都不是本次打开的官方句子。— [NexGPU Fish Speech](https://nexgpu.net/en/models/fish-speech/)
- S1 博客：S1 在 RTX 4090 上约 1:7（生成快于实时约 7 倍）。没有 S1-mini 的速度，也没有 CPU。— [Fish Audio S1 blog](https://fish.audio/blog/introducing-s1/)
- 社区 GGUF 目录把 S1-mini 的 Q4 文件记在约 1.0 GB 一档。不是官方量化，也没有 CPU RTF。— [selfhost.directory s1-mini](https://selfhost.directory/models/fishaudio/s1-mini)

#### IndexTTS / IndexTTS2 / IndexTTS-2.5

- 官方 `IndexTTS2` 在 `device="cpu"` 时关闭 fp16 和 CUDA kernel，并打印 “Be patient, it may take a while to run in CPU mode.” 这只证明代码能走到 CPU，没有时间。— [indextts/infer_v2.py](https://github.com/index-tts/index-tts/blob/main/indextts/infer_v2.py)
- 官方速度表只在 RTX 4090、`kv_cache=True`：IndexTTS 2.0 fp16 总 RTF 0.3257，fp32 0.3748；2.5 bf16 0.2065，fp32 0.2060。README 写 FP16/BF16 更快、更省显存，「quality loss 很小」。没有 CPU RTF，没有官方最低显存。— [index-tts/index-tts](https://github.com/index-tts/index-tts/)
- Hugging Face 文件列表把 `gpt.pth` 标为 3.48 GB。— [IndexTeam/IndexTTS-2](https://huggingface.co/IndexTeam/IndexTTS-2/tree/main)
- 一篇 2026-08 的安装文按 HF API 把检查点合计写成约 5.9 GB：`gpt.pth` 3.48 GB、`s2mel.pth` 1.2 GB、`qwen0.6bemo4-merge` 1.19 GB。同一文引用 issue：RTX 3060 12 GB 默认设置约 228 秒生成约 17 秒音频（RTF 13.1），加上 `--fp16` 和更小分段后帖子里的日志大约降到 RTF 1.6–2.2；RTX 4050 6 GB 能跑但很慢。官方 README 没有这些 CPU/低端卡数字。— [localaimaster IndexTTS-2](https://localaimaster.com/blog/indextts-2-setup-guide)
- 能力表把 IndexTTS-2 记为 1.5B（2025-06，中英），IndexTTS-2.5 记为 0.97B（2025-08，5 种语言），两行 CPU 列都是勾。该表没有 RTF。1.5B 与 FunAudioLLM 对比表里的 Index-TTS2 1.5B 一致。— [tts-bench capabilities](https://5uck1ess.github.io/tts-bench/capabilities.html)；[Fun-CosyVoice3 模型卡](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
- 第三方 ONNX 包把 GPT 步做成 int8，DiT 保持 fp32 363 MB、BigVGAN 保持 fp32 429 MB，并写 int8 会损伤 flow matching。没有 CPU RTF。文件表里的 GPT 三份 int8 分别是 837 MB、476 MB、826 MB，整体仍然是数 GB。— [vra/indextts-onnx](https://github.com/vra/indextts-onnx)

#### F5-TTS 与 F5R-TTS

- 官方仓库只公布 L20 GPU：F5-TTS Base（Vocos）PyTorch 离线 RTF 0.1467，TensorRT-LLM 离线 RTF 0.0402，客户端/服务端并发 2 时 RTF 0.0394。没有 CPU，没有中文专用小模型。— [SWivid/F5-TTS](https://github.com/SWivid/F5-TTS/)
- FunAudioLLM 的对比表把 F5-TTS 记为 0.3B，并给出中文 CER 1.52、说话人相似度 74.1。— [Fun-CosyVoice3 模型卡](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
- 独立基准（2026-08-22，Apple M2，英语语料）：F5-TTS 0.34B，权重 953 MB，磁盘 953 MB，RSS 1.1 GB，RTF 2.69，许可证 CC-BY-NC-4.0。机器不是 i5，语料不是中文。— [OrcaBot, 2026-08-22](https://orcabot.com/benchmarks/open-weight-tts)
- .NET ONNX 移植：F32 模型 1.32 GB，FP16 630 MB。同一段参考与文本，CPU 上 F32 总时间 19.6 秒，FP16 40.1 秒（CPU 没有原生 FP16，运行时在做仿真）。音频时长没有写出，因此不能换成 RTF。作者写中文/日文需要自己的分词器，base 检查点覆盖英语和中文。— [Horus.F5Tts.Onnx](https://github.com/nibor1896/Horus.F5Tts.Onnx)
- F5R-TTS 是在 F5-TTS 结构上改最后一层、用 WenetSpeech4TTS Basic（7,226 小时普通话）训练的版本。论文没有新的参数量、磁盘或 RTF。中文测试集上，他们自己的 F5 基线 WER 2.10%、SIM 0.698，F5-R 为 1.48% 和 0.730。仓库推理命令要求用户自己填 `ckpt_file`。这次没有找到带文件大小的公开权重页。— [arXiv:2504.02407](https://arxiv.org/html/2504.02407v3)；[FrontierLabs/F5R-TTS](https://github.com/FrontierLabs/F5R-TTS)

#### ChatTTS、Spark-TTS、MegaTTS3、FireRedTTS-2、GLM-TTS、Step-Audio-TTS

- ChatTTS 官方 FAQ：30 秒音频至少 4 GB 显存；RTX 4090 上大约每秒 7 个语义 token，RTF 约 0.3。语言是中文和英文。没有 CPU 数字。开放权重被说明为 4 万小时预训练、未做 SFT，且「仅学术用途」。— [2noise/ChatTTS](https://github.com/2noise/ChatTTS/)
- Spark-TTS 仓库许可证为 Apache-2.0，权重名是 `Spark-TTS-0.5B`，骨干是 Qwen2.5，由 LLM 码直接还原波形，不再加 flow。仓库摘要没有磁盘、VRAM 或 RTF。FunAudioLLM 表把它记为 0.5B，中文 CER 1.2，说话人相似度 66.0。— [SparkAudio/Spark-TTS](https://github.com/SparkAudio/Spark-TTS/)；[Fun-CosyVoice3 模型卡](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
- MegaTTS3：扩散 Transformer 骨干 0.45B，Apache-2.0，中英及 code-switching。Docker 有 CPU 镜像。WebUI 说明写 “We also support cpu inference, but it may take about 30 seconds (for 10 inference steps).” 没有这句话对应的音频时长，所以 RTF 未知。WaveVAE 编码器权重因安全原因不发布，任意说话人要预抽取的 `.npy`。— [bytedance/MegaTTS3](https://github.com/bytedance/MegaTTS3)
- FireRedTTS-2：HF 树页面上 `codec.pt` 4.3 GB、`llm_posttrain.pt` 8.27 GB；骨干在对比表里是 Qwen2.5-1.5B / 1.5B。示例代码把 `device` 写成 `"cuda"`，安装索引是 cu126。语言含英、中、日、韩、法、德、俄。L20 上首包低至 140 ms。没有 CPU 速度。— [FireRedTeam/FireRedTTS2](https://huggingface.co/FireRedTeam/FireRedTTS2)；[Fun-CosyVoice3 模型卡](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
- GLM-TTS 仓库为 Apache-2.0，2025-12-11 公开推理脚本和权重，架构是 LLM token 再加 flow，并写明支持流式。FunAudioLLM 表把 GLM-TTS 与 GLM-TTS RL 都记为 1.5B。没有官方磁盘或 CPU RTF。目录站的约 8.9 GB 被标成估计。— [zai-org/GLM-TTS](https://github.com/zai-org/GLM-TTS)；[Fun-CosyVoice3 模型卡](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)；[whatmodel tts.md](https://github.com/jakemanger/whatmodel/blob/main/pages/tts.md)
- Step-Audio-TTS-3B 的 HF 模型卡写模型大小 4B、张量类型 BF16，仓库同时含双码本 LLM 与声码器。Seed 中文 CER 1.31（3B 行）对比表里还有一个未标明体积的 Step-Audio-TTS。卡片摘录没有许可证、CPU 或 RTF。— [stepfun-ai/Step-Audio-TTS-3B](https://huggingface.co/stepfun-ai/Step-Audio-TTS-3B)

#### GPT-SoVITS、Bert-VITS2、XTTS、MaskGCT、E2 TTS、Amphion

- GPT-SoVITS 官方 README 给出 v2 ProPlus 的 RTF：4060 Ti 为 0.028，4090 为 0.014，Apple M4 CPU 为 0.526。支持英、日、韩、粤、中。安装表含一条 CPU 的 PyTorch 2.2.2 / Python 3.9。README 摘录没有参数量、磁盘或最低 RAM。— [bilibili/GPT-SoVITS](https://github.com/bilibili/GPT-SoVITS)
- 一个多引擎封装把 GPT-SoVITS v2 写成约 2.5 GB、显存 8 GB+、CPU 列「No」。这与上游 README 的 M4 数字冲突，体积也不是官方句子，不采用它做裁定。— [oddmeta/oddtts](https://github.com/oddmeta/oddtts)
- 同一封装把 Bert-VITS2 写成约 2 GB、显存 5 GB+、可纯 CPU，把 ChatTTS 写成约 2.4 GB。都不是上游文件大小。一项 Bert-VITS2 普通话实验（AISHELL-3）MOS 2.90、WER 0.27，同表 fish-speech MOS 3.57、MeloTTS-Chinese MOS 3.04，并写明不能做中英混读。— [oddmeta/oddtts](https://github.com/oddmeta/oddtts)；[VoicePing Bert-VITS2](https://voiceping.net/en/blog/research-bert-vits2-tts/)
- XTTS：OrcaBot 在同一台 M2 上测得权重 1.8 GB、RSS 4.0 GB、RTF 1.69、参数量写成 0.47B、许可证 CPML。租卡站写 `model.pth` 1.87 GB（fp32）、DVAE 211 MB，单路峰值约 4 GB，并称中文单段 82 字上限。能力表把参数量写成 750M。三处参数量不一致，磁盘都在 1.8–2.1 GB。没有 i5 或 Intel CPU 的 RTF。Coqui 原仓库已不维护。— [OrcaBot](https://orcabot.com/benchmarks/open-weight-tts)；[NexGPU XTTS](https://nexgpu.net/models/xtts/)；[tts-bench](https://5uck1ess.github.io/tts-bench/capabilities.html)
- MaskGCT 在 Qwen 的 Seed 表里有中文 WER 2.27。Colab 示例把权重建模为必须 GPU、约 10–12 GB，代码 MIT、权重 CC-BY-NC-4.0，语言含英、中、日、韩、法、德。目录站的约 6.6 GB 是估计。Amphion 是装 MaskGCT 等模型的工具箱，不是另一份更小的中文检查点。— [Qwen3-TTS README 评测表](https://github.com/QwenLM/Qwen3-TTS/)；[shinshin86/local-tts-on-google-colab](https://github.com/shinshin86/local-tts-on-google-colab)
- E2 TTS 论文：Transformer 335M，再加 BigVGAN。Qwen 的表给了中文 WER 1.97，说明该系统做过中文评测。这次没有找到带文件大小的公开权重。按「权重未发布则排除」处理。— [arXiv:2406.18009](https://arxiv.org/html/2406.18009)；[Qwen3-TTS README](https://github.com/QwenLM/Qwen3-TTS/)

#### 体积锚点：OuteTTS、Llasa、Kokoro

- OuteTTS 0.2 500M 的 GGUF 目录：Q4_K_M 文件 0.4 GB，该站估计 8K 上下文约 1.0 GB 内存；中文被写成实验支持；许可证 cc-by-nc-4.0。内存是估计。后续 Colab 笔记写 OuteTTS 0.6B 代码和权重都是 Apache-2.0，并标「CPU OK」，1B 权重则是 CC-BY-NC-SA-4.0 加 Llama 3.2。两处都没有 RTF。— [ggufmodels.com](https://ggufmodels.com/model/outetts-0-2-500m-by-outeai)；[local-tts-on-google-colab](https://github.com/shinshin86/local-tts-on-google-colab)
- Llasa-8B 出现在 Qwen 的中英 WER 表里。目录站把 Llasa-3B 记成 4B 参数、CC-BY-NC-4.0、中英，Q8 文件 4.0 GB、合计约 5.3 GB，其余档是估计。没有 CPU RTF。— [selfhost.directory Llasa-3B](https://selfhost.directory/models/hkustaudio/llasa-3b)
- 作为对照而不是调查对象：Kokoro 82M，综述写 CPU、约 2 GB RAM、Apache-2.0；多引擎封装写约 376 MB、中英、纯 CPU。这是「数 GB 内存里还能实时」的体量，上面的 codec/LLM 系统没有一个公开变体落到同一档并带中文质量数字。— [Local AI Zone](https://local-ai-zone.github.io/blog/local-voice-models-2026.html)；[oddmeta/oddtts](https://github.com/oddmeta/oddtts)

### Inferences

- i5-8260U 是 15 W 级 4 核旧超低压 CPU。已有的「能在 CPU 上跑」证据要么来自 2026 年的 Core Ultra 5 322（CosyVoice3，RTF 4.6），要么来自 Apple M2/M4（F5-TTS、XTTS、GPT-SoVITS）。不能把这些 RTF 换算成这台机器的 RTF。
- 最小权重已经说明内存不够共享：CosyVoice3 单套文件 4.43 GB，XTTS 在 M2 上 RSS 4.0 GB，FireRedTTS-2 单是 LLM 检查点就有 8.27 GB。再加上浏览器、SenseVoice 和助手，这些都不是「数 GB 共享内存」里的模型。
- Qwen3-TTS 0.6B 的 2.49 GB 仓库是这份名单里唯一同时满足「官方、Apache、中文、整仓小于约 3 GB、GPU 上 RTF < 1」的检查点。缺的是 CPU 证据。CUDA Graph 上的 RTF 0.288 不能当成核显或 CPU 结果。
- 社区 GGUF 只压了 CosyVoice3 或 Fish 的语言模型。flow、DiT、BigVGAN、tokenizer 仍在，所以「Q4 只有 0.5 GB」不是整条语音管线的内存。

### Gaps

- CosyVoice-300M、CosyVoice2-0.5B、Spark-TTS-0.5B、GLM-TTS、IndexTTS-2.5、S1-mini、GPT-SoVITS 的官方解压后字节数，这次没有逐个打开 HF tree。
- 没有任何一个模型在 i5-8260U、i5-8265U 或同代 Whiskey Lake / 8 代 U 上的 RAM 峰值或 RTF。
- S2-Pro 的许可证文件、Step-Audio-TTS-3B 的许可证、IndexTTS 上游 LICENSE 原文，这次没有打开。
- E2 TTS 与 F5R-TTS 是否有可下载的完整中文检查点，没有文件大小可引用。

## CPU 与 GPU 的 RTF，以及谁已经慢于 10 倍实时

### Takeaway

名单里没有任何一个中文模型在 Intel 低功耗 CPU 上公布 RTF < 1。唯一低于 1 的 CPU 数字是 GPT-SoVITS v2 ProPlus 在 Apple M4 上的 0.526。CosyVoice3 在更新的 6 核 CPU 上是 4.6，已经不能边播边合成。IndexTTS2 在 RTX 3060 上的默认社区日志是 RTF 13.1，按规则直接出局；官方 4090 数字不能把它救回这台无显卡机器。

### Cited Findings

- 慢于或等于 10 倍、因而对 CPU 路径出局：IndexTTS2 在 RTX 3060 12 GB、默认设置下约 RTF 13.1（社区 issue，经安装文转述）。同一文说 fp16 加小分段后大约 1.6–2.2，那仍是 12 GB 独显，不是 CPU。— [localaimaster](https://localaimaster.com/blog/indextts-2-setup-guide)
- CPU 上测到、但已经不是实时，且 CPU 强于目标机：CosyVoice3，Core Ultra 5 322，约 8 秒中文用 34 秒，RTF 4.6；核显 RTF 2.1。— [Terry L](https://terryl.in/en/blog/cosyvoice-3-voice-cloning)
- Apple Silicon，不是 Intel，且不是实时：F5-TTS 在 M2 上 RTF 2.69；XTTS 在 M2 上 RTF 1.69。— [OrcaBot](https://orcabot.com/benchmarks/open-weight-tts)
- Apple Silicon 且快于实时，但是 M4：GPT-SoVITS v2 ProPlus RTF 0.526。同文 GPU 为 0.014（4090）和 0.028（4060 Ti）。— [bilibili/GPT-SoVITS](https://github.com/bilibili/GPT-SoVITS)
- 只存在 GPU 实时数字：Qwen3-TTS-12Hz-0.6B 并发 1，RTF 0.288、首包 97 ms，CUDA Graph + vLLM；1.7B 同设置 RTF 0.313、首包 101 ms。— [Qwen3-TTS Technical Report](https://arxiv.org/pdf/2601.15621)
- 只存在高端 GPU 数字：IndexTTS 2.0/2.5 在 RTX 4090 上 RTF 0.21–0.37；F5-TTS 在 L20 上 PyTorch RTF 0.1467、TRT-LLM 0.0402；Fish S1（4B，权重不公开）在 RTX 4090 上约 1:7；ChatTTS 在 4090 上 RTF 约 0.3；FireRedTTS-2 在 L20 上首包 140 ms，没有整句 RTF；CosyVoice3 TensorRT-LLM batch 1 RTF 0.1091。— [index-tts](https://github.com/index-tts/index-tts/)；[SWivid/F5-TTS](https://github.com/SWivid/F5-TTS/)；[Fish S1 blog](https://fish.audio/blog/introducing-s1/)；[ChatTTS](https://github.com/2noise/ChatTTS/)；[FireRedTTS2](https://huggingface.co/FireRedTeam/FireRedTTS2)；[TRT-LLM README](https://github.com/funaudiollm/cosyvoice/blob/main/runtime/triton_trtllm/README.Cosyvoice3.md)
- MegaTTS3 的 CPU 句子是「10 步扩散大约 30 秒」，没有音频长度。30 秒的墙钟时间本身就做不到一句语音助手回复的实时播放。RTF 仍标未知。— [MegaTTS3](https://github.com/bytedance/MegaTTS3)
- F5 ONNX 的 CPU 19.6 秒（F32）和 40.1 秒（FP16）没有分母，不能与 RTF 10 比较。能说的是：在该作者的 CPU 上，FP16 比 F32 更慢。— [Horus.F5Tts.Onnx](https://github.com/nibor1896/Horus.F5Tts.Onnx)
- 没有找到 CPU 或小显卡 RTF 的公开中文系统：Spark-TTS、GLM-TTS、Step-Audio-TTS-3B、S1-mini、S2-Pro（虽有 CPU 安装文档）、FireRedTTS-2、MaskGCT、Llasa、Qwen2.5-Omni、E2 TTS、F5R-TTS、OuteTTS。

### Inferences

- RTF > 1 时，流式首包不能维持连续播放，缓冲会被生成速度拖干。CosyVoice3 的 RTF 4.6 和 F5-TTS 的 RTF 2.69 都属于这一类。150 ms 或 97 ms 的首包数字来自 GPU 或未标明的服务栈，不能抵消 CPU RTF。
- 「10 倍线」只明确打到 IndexTTS2 的那条 3060 默认日志。其余大模型是因为没有 CPU 实时证据、或已有 CPU 证据已经是数倍实时，而不是因为查到了 RTF ≥ 10。
- GPT-SoVITS 的 M4 数字是这份材料里唯一的 CPU 亚实时结果。M4 的神经网速度不能代表 i5-8260U；而且它是 GPT + SoVITS，不是这份简报要找的 codec/LLM 音质台阶。

### Gaps

- S2-Pro 有 CPU Docker，但没有 CPU RTF。未知是「能装」还是「能实时」。
- Qwen3-TTS、CosyVoice3 GGUF、IndexTTS ONNX 都没有公开的 Intel CPU RTF。
- OrcaBot 的 RTF 用英语语料，中文 token 密度不同，不能直接当成普通话 RTF。

## 许可证

### Takeaway

真正 Apache-2.0 且权重在线的中文系统包括 Fun-CosyVoice3、Qwen3-TTS、Spark-TTS、MegaTTS3、GLM-TTS。音质和体积最接近门槛的另外两支，F5-TTS 与 Fish S1-mini，都是非商用；XTTS 是 CPML。许可证不是这次淘汰的主因，速度和内存才是。

### Cited Findings

- Apache-2.0：Fun-CosyVoice3 / CosyVoice2 模型卡头部、Spark-TTS 仓库、MegaTTS3 仓库、GLM-TTS 仓库、Qwen3-TTS 仓库与 HF 标签。— [CosyVoice3 模型卡](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)；[Spark-TTS](https://github.com/SparkAudio/Spark-TTS/)；[MegaTTS3](https://github.com/bytedance/MegaTTS3)；[GLM-TTS](https://github.com/zai-org/GLM-TTS)；[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS/)
- CC-BY-NC-SA-4.0：Fish S1-mini 官方模型卡，并有门禁字段「仅非商用」。— [openaudio-s1-mini](https://huggingface.co/fishaudio/openaudio-s1-mini)
- CC-BY-NC-4.0：OrcaBot 给 F5-TTS 的许可证列。F5 官方 README 摘录没有再贴一次许可证全文。— [OrcaBot](https://orcabot.com/benchmarks/open-weight-tts)
- CPML（非商用）：OrcaBot 与能力表对 XTTS-v2 的记载。— [OrcaBot](https://orcabot.com/benchmarks/open-weight-tts)；[tts-bench](https://5uck1ess.github.io/tts-bench/capabilities.html)
- ChatTTS：README 写发布模型仅供学术使用。— [2noise/ChatTTS](https://github.com/2noise/ChatTTS/)
- FireRedTTS-2：零样本克隆「仅用于学术研究」，并禁止非法用途。这是使用声明，不是 SPDX 许可证名。— [FireRedTTS2](https://huggingface.co/FireRedTeam/FireRedTTS2)
- MegaTTS3 虽然代码是 Apache-2.0，但编码器权重不发布，克隆新说话人要走他们的 latent 队列。— [MegaTTS3](https://github.com/bytedance/MegaTTS3)
- 二手、未核对上游 LICENSE 文件：IndexTTS2 被 Colab 笔记写成 bilibili Model Use License，且依赖的 MaskGCT 语义 codec 为 CC-BY-NC-4.0；MaskGCT 权重 CC-BY-NC-4.0；Qwen2.5-Omni 为 qwen-research；S2 为 FISH AUDIO RESEARCH LICENSE；OuteTTS 0.2 500M 为 CC-BY-NC-4.0，0.6B 为 Apache-2.0，1B 非商用；Llasa-3B 为 CC-BY-NC-4.0。— [Colab 笔记](https://github.com/shinshin86/local-tts-on-google-colab)；[AIMap](https://aimap.page/zh-hans/models/compute/open-models/qwen2-5-omni-3b/)；[NexGPU Fish](https://nexgpu.net/en/models/fish-speech/)；[selfhost Llasa](https://selfhost.directory/models/hkustaudio/llasa-3b)

### Inferences

- 若项目要商用，F5-TTS、S1-mini、XTTS、ChatTTS 即使突然出现 CPU 实时构建也不能直接用。Qwen3-TTS 0.6B 和 CosyVoice3 在许可证上是开放的，卡在机器上。
- FireRedTTS-2 的学术克隆声明，加上 8 GB 级 LLM 文件，使它不适合这台设备上的产品语音。

### Gaps

- Step-Audio-TTS-3B、GPT-SoVITS、Bert-VITS2、IndexTTS 上游许可证原文没有在这次打开。
- CosyVoice 模型卡页脚另有一句「以上内容仅供学术演示」。这与 Apache-2.0 标签同时出现，商业使用应以仓库 LICENSE 为准；这次没有单独打开 LICENSE 文件正文。

## 官方小模型、蒸馏或量化，以及作者承认的质量损失

### Takeaway

官方缩小只发生在 Fish S1-mini（0.5B，相对专有 4B）和 Qwen3-TTS 0.6B（相对 1.7B）。两份材料都只用识别错误率说明变小以后的损失，没有承认听感崩溃，也没有给出 CPU 速度。CosyVoice、IndexTTS、F5、FireRed、GLM、Step 都没有官方 int4/int8 中文整模。社区 Q4 把 CosyVoice3 听感写成发闷和读音缺陷，那是第三方听感，不是阿里的结论。

### Cited Findings

- Fish 官方：S1-mini 是 S1 的蒸馏版。英语自动评测，S1 的 WER 0.008、CER 0.004、说话人距离 0.332；S1-mini 为 0.011、0.005、0.380。没有中文对照，没有「可在 CPU 实时」的句子。S1 本身不发布权重。— [openaudio-s1-mini](https://huggingface.co/fishaudio/openaudio-s1-mini)；[S1 blog](https://fish.audio/blog/introducing-s1/)
- Qwen 官方 Seed test-zh WER：12Hz-0.6B-Base 0.92，12Hz-1.7B-Base 0.77；25Hz-0.6B-Base 1.18，25Hz-1.7B-Base 1.10。报告写「从 0.6B 放到 1.7B 有稳定收益」，并把「人类水平」特别安在 1.7B 上。同一张表里 12Hz-0.6B 的中文 WER 仍低于 F5-TTS 1.56、Spark 1.20、FireRedTTS 2 1.14。这是可懂度，不是 MOS。25Hz 权重在 2026-01-22 的 README 里尚未发布。— [Qwen3-TTS README](https://github.com/QwenLM/Qwen3-TTS/)；[技术报告](https://arxiv.org/pdf/2601.15621)
- IndexTTS 官方只承认半精度「quality loss 很小」，换来的是 4090 上的速度和显存，不是 CPU 小模型。— [index-tts](https://github.com/index-tts/index-tts/)
- CosyVoice3 的 RL 权重是质量后训练，不是缩小：模型卡上中文 CER 从 base 的 1.21 降到 RL 的 0.81，文件大小与 `llm.pt` 相同，都是约 2.02 GB。没有官方 int4/int8。— [模型卡](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)；[HF tree](https://huggingface.co/api/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/tree/main)
- 社区 GGUF 作者的听感：Q8_0 接近 F16；Q4_K_M / Q4_K_S 相对 Q5 下降，偶尔发闷，大多还能接受；Q4_0 常常含糊；Q2 噪声严重。这不是 FunAudioLLM 的声明。— [Lourdle GGUF](https://huggingface.co/Lourdle/Fun-CosyVoice3-0.5B-2512-GGUF)
- F5R-TTS 是同尺寸上的 RL，不是蒸馏。作者报告相对他们自己的 F5 基线，中文 WER 相对下降，SIM 相对上升。没有说模型变小。— [arXiv:2504.02407](https://arxiv.org/html/2504.02407v3)
- ONNX 第三方写 DiT/BigVGAN 保持 fp32，因为 int8 会损伤 flow matching。F5 的 FP16 ONNX 在 CPU 上更慢，且同一随机种子与 F32 生成的音频不同。— [vra/indextts-onnx](https://github.com/vra/indextts-onnx)；[Horus.F5Tts.Onnx](https://github.com/nibor1896/Horus.F5Tts.Onnx)
- 没有找到官方「lite / int4 / int8 中文检查点」的系统：CosyVoice 全系、Spark-TTS、MegaTTS3、FireRedTTS-2、GLM-TTS、Step-Audio-TTS、GPT-SoVITS、MaskGCT、XTTS。

### Inferences

- 把 Qwen3 从 1.7B 收到 0.6B，中文 WER 从 0.77 变到 0.92，损失的是一点可懂度余量，不是退回 VITS 量级的错误率。换不来的是 CPU 实时。0.6B 的速度证据仍然是 CUDA。
- 把 CosyVoice3 收到社区 Q4，听感已经开始发闷，而整条管线的 flow 与 tokenizer 仍是 1 GB 这一档的 fp32 文件。量化没有把系统送回轻薄本。
- 留在 Kokoro / 小 VITS / Matcha，放弃的是这些 0.5B–1.7B 系统在模型卡上展示的零样本克隆、方言/指令（CosyVoice3 的 9 语言和 18 种以上汉语方言）、以及 Qwen3 那种 GPU 上 100 ms 内的首包。本次材料里没有一份 MOS 直接写「0.6B 仍明显高于 Matcha」。

### Gaps

- Qwen3 0.6B 相对 1.7B 的主观 MOS 或 AB 偏好没有在摘到的表格里。
- S1-mini 相对 S1 的中文 WER/MOS 没有公布。
- 没有任何作者写「int4 中文检查点在 CPU 上仍明显好于 VITS，且 RTF < 1」。

## 能否在整句编码完成前吐出音频

### Takeaway

CosyVoice2/3、Qwen3-TTS 和 FireRedTTS-2 在设计上可以首包先出。已经公布的首包时间都是 GPU 或未绑定 CPU 的数字：Qwen3 12Hz 0.6B 为 97 ms，CosyVoice 宣传 150 ms，FireRedTTS-2 在 L20 上 140 ms。在 RTF > 1 的 CPU 上，首包流式不能变成实时回复。

### Cited Findings

- Fun-CosyVoice 3.0 与 CosyVoice 2.0 模型卡：双向流式，文本边进、音频边出，延迟低至 150 ms。150 ms 没有绑定某块 CPU 或 GPU。配置里 `chunk_size: 25` token。示例 API 有 `stream=False`，也有把文本生成器逐段送入 `inference_zero_shot` 的双流用法。— [Fun-CosyVoice3 模型卡](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
- Qwen3-TTS：双轨 LM，收到文本 token 后立刻预测对应声学 token。12Hz tokenizer 是纯左上下文，不必等未来帧；一个包定义为 4 个 token，即 320 ms 音频。Table 2 的 97 ms 是 CUDA Graph + vLLM 上的端到端首包。25Hz 因为 DiT 需要前瞻，要先生成 16 个 token，首包音频大约只有 190 ms，并发 1 的 0.6B 首包是 138 ms。— [技术报告](https://arxiv.org/pdf/2601.15621)
- FireRedTTS-2：12.5 Hz tokenizer，双 transformer，按句生成；L20 上首包低至 140 ms。示例是整段对话生成后一次保存。— [FireRedTTS2](https://huggingface.co/FireRedTeam/FireRedTTS2)
- GLM-TTS 仓库简介写支持流式。没有延迟数字。— [GLM-TTS](https://github.com/zai-org/GLM-TTS)
- F5-TTS 官方基准是整段离线 RTF。这次没有找到官方「未等整句就出声」的 CPU/GPU 延迟表。F5R-TTS 推理脚本同样是整段 CLI。— [SWivid/F5-TTS](https://github.com/SWivid/F5-TTS/)；[F5R-TTS](https://github.com/FrontierLabs/F5R-TTS)
- MegaTTS3 的 CPU 说明按扩散步数计时，读起来是整段合成。— [MegaTTS3](https://github.com/bytedance/MegaTTS3)
- IndexTTS、ChatTTS、Spark-TTS、Step-Audio-TTS、GPT-SoVITS、XTTS、MaskGCT、OuteTTS：这次打开的页面没有给出可引用的首包时间。IndexTTS 的 ONNX 与 PyTorch 路径都是整段 `infer`。XTTS 的流式能力不在已打开的页面里，标为未知。

### Inferences

- 对这台机器，流式是必要但不够。Qwen3 12Hz 的结构确实能在整句结束前出 320 ms 的包，但解码栈是 CUDA。把同一结构放到没有 GPU 的 4 核上，没有测量说首包仍是几十到几百毫秒。
- CosyVoice3 在更新 CPU 上整句 RTF 已经是 4.6。即便官方 150 ms 首包在那台机器上成立（博客测的是整句，没有首包），播放也会在第一段之后断流。

### Gaps

- CosyVoice 150 ms 的测试硬件未在模型卡写出。
- XTTS、GPT-SoVITS、Spark-TTS、IndexTTS 的流式是否在当前版本默认开启，没有从本次打开的 README 确认。

## 裁定：这台 CPU 上留下谁

### Takeaway

没有模型被留下。高质量中文开源 TTS 在 2026 年 11 月仍是 GPU 模型。最小的官方中文变体要么没有 CPU 速度，要么在更强的 CPU 上已经数倍于实时，并且权重本身就超过这台机器能分给语音的内存。

### Cited Findings

留下：无。

排除，且理由只使用上面已经引用的事实：

- Fun-CosyVoice3-0.5B、CosyVoice2-0.5B、CosyVoice-300M：3.0 的最小文件集 4.43 GB；唯一 CPU RTF 是更强 CPU 上的 4.6，不是实时。没有官方 int4 整模。300M 与 2.0 没有 CPU RTF。
- Qwen3-TTS 12Hz 0.6B / 1.7B：0.6B 仓库 2.49 GB，Apache-2.0，中文 WER 0.92，GPU RTF 0.288。速度栈是 vLLM + CUDA Graph。无 CPU RTF。1.7B 更大。25Hz 在已读 README 中尚未发布。
- Qwen2.5-Omni-3B：5.54B 全模态，不是小 TTS；显存估算在 4 GB 以上，许可证被目录站标为研究用。
- Fish S1 4B：权重不公开，排除。S1-mini：0.5B 蒸馏、非商用，无 CPU RTF。S2-Pro：官方 24 GB GPU 内存，CPU 安装存在但无 CPU RTF。Fish 1.5：官方推理显存 4 GB 来自二手综述，无 CPU RTF。
- IndexTTS2 / 2.5：4090 RTF 约 0.2–0.4；`gpt.pth` 3.48 GB；CPU 只有「请耐心」；3060 默认社区 RTF 13.1，超过 10 倍线。第三方 int8 不覆盖 DiT/BigVGAN，也无 CPU RTF。
- F5-TTS：953 MB、M2 RTF 2.69、CC-BY-NC。不是实时，也不是这颗 Intel CPU。F5R-TTS：无磁盘与 CPU RTF。
- ChatTTS：学术许可；4 GB 显存 / 4090 RTF 0.3；无 CPU RTF。
- Spark-TTS-0.5B：无磁盘字节与 CPU RTF。
- MegaTTS3：0.45B，CPU 路径约 30 秒 / 10 步，编码器权重不发布。
- FireRedTTS-2：`llm_posttrain.pt` 8.27 GB，示例为 CUDA，首包 140 ms 在 L20 上。
- GLM-TTS：对比表 1.5B，无 CPU RTF。
- Step-Audio-TTS-3B：4B BF16，无 CPU 证据。
- GPT-SoVITS v2 ProPlus：M4 CPU RTF 0.526 是名单里唯一的 CPU 亚实时，但机器级别不同，且系统仍是 SoVITS，不是要求的音质台阶。无 i5 数字，无官方磁盘字节。
- Bert-VITS2：一项普通话实验 MOS 2.90，低于同表 fish-speech，且不能混读。它就是要被超越的 VITS 类，不是更小的高质量变体。
- XTTS-v2：M2 RTF 1.69、RSS 4.0 GB、CPML。1.69 已非实时，RSS 占满共享内存，维护停在 2023 权重。
- MaskGCT / Amphion：二手资料为 10–12 GB 级 GPU、权重非商用。Amphion 不是另一份小模型。
- E2 TTS：论文 335M，未找到公开权重文件大小，排除。
- Llasa、OuteTTS：只作体积参照。Llasa-3B 的 Q8 文件已是 4.0 GB。OuteTTS 0.2 的 Q4 文件 0.4 GB 说明「0.5B 量化后可以很小」，但中文是实验支持，内存数字是估计，且没有 RTF，不能当成 CosyVoice/Qwen 的替代。

### Inferences

- 留在小 VITS、Matcha 或 Kokoro 这一档，放弃的是 2025–2026 这些模型卡上的克隆、方言和指令控制，以及它们在 GPU 上已经做到的亚实时。换到任何一个带公开中文权重的 codec/LLM 系统，要么内存先满，要么没有证据表明 i5-8260U 能在 1 倍实时内出声。
- 若以后只放宽一件事，最值得重新测的是 Qwen3-TTS-12Hz-0.6B：它是唯一官方、可商用、整仓 2.49 GB、中文可懂度仍高于表内多个更大模型的候选。必须在这台 CPU 上测 RTF；现有文献不能把它判进范围。其次才是 CosyVoice3，而它在更强 CPU 上已经是 4.6 倍，先验上更不乐观。

### Gaps

- 没有在目标笔记本上复测。裁定依据是公开数字与设备约束，不是本地跑分。
- 「明显好于小 VITS/Matcha」缺少与 Kokoro 或 Matcha 的同场 MOS。排除这些大模型，是因为它们进不了这台机器，不是因为已经证明音质不值得。
