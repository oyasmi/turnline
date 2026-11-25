# 中英混读：哪些开源本地 TTS 不会静默丢掉英文词

检索截止 2026-11-24。没有人发表过对原句「请记住，版本是 2.5，名字叫 Kubernetes」的听测。下面凡是写「会读出」的，都只对应已发表的句子、源码分支或维护者原话；没有听测的地方标成缺口。云端 API 不在范围内。

## 中英 code-switching 有哪些文本前端，哪些从设计上就不会丢掉未知词？

### Takeaway

会整词消失的是「只查词表、查不到就 continue」的前端。不会因为词表缺失而整词消失的，是下面三类：任意拼写都能产出音素的 G2P（espeak、神经 G2P）、把英文保留成字母再送进字符模型，以及调用方事先转成模型词表里的 token。字母逐个拼读也算可接受，但 sherpa-onnx 2.x 的 OOV 重试并不会把未知英文拆成字母。

### Cited Findings

- 五类前端，按「未知英文会不会被删掉」区分：
  1. 共享音素表，中英各自 G2P 后再映射。Matcha zh-en 的 `tokens.txt` 是一套 IPA 风格符号；v1 对非中文 OOV 调 espeak `en-us`，再把 `eɪ→A`、`aɪ→I`、`oʊ/əʊ→O` 等替换后按 Unicode 字符查表。查不到的音素打日志并丢掉，词本身不一定整段删除。源码在 `sherpa-onnx/csrc/matcha-tts-lexicon.cc`（commit `b74c4dfe`）：`config.voice = "en-us"`，以及 `SHERPA_ONNX_LOGE("Skip token: %s", p.c_str())`。[matcha-tts-lexicon.cc](https://github.com/k2-fsa/sherpa-onnx/blob/b74c4dfe/sherpa-onnx/csrc/matcha-tts-lexicon.cc)；[tokens.txt](https://huggingface.co/csukuangfj/matcha-icefall-zh-en/blob/main/tokens.txt)
  2. 词表，未命中则 espeak。sherpa-onnx 移除 espeak 之前，`kokoro-multi-lang-lexicon.cc` 写明：词表未命中且 voice 为空时 “fallback to espeak”；音素不在 `token2id_` 里则 `Skip OOV token`。[kokoro-multi-lang-lexicon.cc](https://github.com/k2-fsa/sherpa-onnx/blob/3193519a/sherpa-onnx/csrc/kokoro-multi-lang-lexicon.cc)。Misaki 英文 G2P 同样：词典没有的词交给 `EspeakFallback`，README 的例子是造词 `outofdictionary` 仍被转成音素。[misaki README](https://github.com/hexgrad/misaki)
  3. 中文拼音与英文 ARPAbet 分开，再拼进同一条音素序列。MeloTTS `ZH_MIX_EN` 用正则抽出 `[a-zA-Z]+`，中文走 pypinyin / opencpop，英文走 CMU dict，不在词典里则调用 `g2p_en`。Kyubyong g2p 的算法第 4 步是 “For OOVs, we predict their pronunciations using our neural net model.” [chinese_mix.py](https://github.com/myshell-ai/MeloTTS/blob/main/melo/text/chinese_mix.py)；[g2p README](https://github.com/Kyubyong/g2p/)
  4. 字符或 BPE，不按整词查表。F5-TTS：英文直接用字母，中文用 jieba + pypinyin 转成完整拼音；字符表大小 2546，「counting in the special filler token and all other language characters exist in the Emilia dataset as there are many code-switched sentences.」[F5-TTS 论文](https://arxiv.org/abs/2410.06885)。Fish Speech 用 tiktoken BPE 对原始字符串 `encode`，没有词表未命中就跳过的分支。[fish_speech/tokenizer.py](https://huggingface.co/spaces/fishaudio/s1-mini/raw/main/fish_speech/tokenizer.py)
  5. 只查词表。未命中就记日志并 `continue`。这是会静默丢词的设计。sherpa-onnx 2.x 的 Matcha / Kokoro / VITS / ZipVoice 都走这条路径，日志是 `OOV word skipped`。[offline-tts-matcha-impl.h](https://github.com/k2-fsa/sherpa-onnx/blob/9a2737b3/sherpa-onnx/csrc/offline-tts-matcha-impl.h)；维护者原话见下一节。
- 2024 年 sherpa-onnx 对 Melo 词表有过「未知英文拆成单字母」的行为：PR #1266 写道 “If an English word does not exist in the lexicon, we split it into characters. For instance, if the word TTS does not exist in lexicon.txt, we split it into 3 characters T, T, and S.” 这符合「逐字母拼读也可接受」。[PR #1266](https://github.com/k2-fsa/sherpa-onnx/pull/1266)
- 2.x 的 OOV 修复不是逐字母拼读。PR #4075（2026-10-22 合并，进入 v2.0.0）只做了：去掉词缘标点再查、按非词字符切开再查、连字符分段。作者写明 “The whole token is still tried first”。`Kubernetes` 没有连字符或标点，整词仍会跳过。同一 PR：“OOV words continue to be reported unconditionally, not behind the debug flag.” [PR #4075](https://github.com/k2-fsa/sherpa-onnx/pull/4075)
- piper-plus 的 `chinese_loanword.hpp` 是另一套可接受策略：嵌入英文先查借词表和缩写表，再对剩下的字母做 `letter_fallback`，输出普通话拼音，而不是删词。这是第三方分支，不是上游 Piper。[chinese_loanword.hpp](https://github.com/ayutaz/piper-plus/blob/dev/src/cpp/chinese_loanword.hpp)

### Inferences

- 「不能因未知词而整词消失」的设计只有：规则/神经 G2P 对任意字母串都吐音素、字符或字节模型保留英文字母、以及调用方预先生成且全部落在模型词表内的 token。词表未命中再跳过，从设计上就会丢词。
- 共享音素表加 espeak 仍可能丢掉单个音素（`Skip token`）。若一个词的音素全部不在 `tokens.txt`，听感上仍是这个词没了。对普通英文拼写，Matcha 的替换表覆盖了常见双元音，所以 v1 通常是读错或读得怪，而不是整词删除；这和 2.x 的整词 `OOV word skipped` 不是同一失败模式。
- BERT / tiktoken 的 `[UNK]` 或子词不是词表跳过。子词还在序列里，但是否被听成那个词，源码证明不了。

### Gaps

- 没有找到一份把上述五类策略放在同一句「Kubernetes」上做听测的论文。
- F5 的字符表包含 Emilia 里出现过的字符；论文没有逐项列出 `a-z` 的 id。英文「直接用字母」意味着这些字母在训练字符表里，但页面没有贴出 vocab 文件。

## Matcha、Kokoro、Melo、Piper、VITS-zh、CosyVoice、Fish、IndexTTS、F5、ChatTTS 以及更新的小模型，对混读句有什么证据？

### Takeaway

「支持中文和英文」都不是「未知英文不会被跳过」的证据。源码或官方示例能证明混读管线的，是 MeloTTS 官方 API、F5-TTS 的拼音+字母前端、以及 sherpa-onnx 1.x 的 espeak 回退。2.x 词表模型、默认不接 `en_callable` 的 Kokoro 中文，会把词丢掉。没有一个上游页面用「请记住，版本是 2.5，名字叫 Kubernetes」做过公开示例。

### Cited Findings

- **Matcha-icefall-zh-en。** 模型卡只写 “It supports `Chinese` and `English`.” 官方示例句是「我最近在学习machine learning，希望能够在未来的artificial intelligence领域有所建树。在这次vocation中，我们计划去Paris欣赏埃菲尔铁塔……」这些是常见词，页面没有给出音频听测记录，也没有 `Kubernetes`。[示例页](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/matcha-icefall-zh-en.html)。声学模型文件 `model-steps-3.onnx` 在该页列为 72M。v1 前端对不在词表里的非中文调用 espeak，再 `Skip token`（上一节）。v2 起 `--matcha-data-dir` 的帮助文本是 “Deprecated. Ignored since v2.0.0: espeak-ng is no longer used.” 未命中词表则 `OOV word skipped`。[offline-tts-matcha-model-config.cc](https://github.com/k2-fsa/sherpa-onnx/blob/9a2737b3/sherpa-onnx/csrc/offline-tts-matcha-model-config.cc)；[offline-tts-matcha-impl.h](https://github.com/k2-fsa/sherpa-onnx/blob/9a2737b3/sherpa-onnx/csrc/offline-tts-matcha-impl.h)。示例页仍在传 `data_dir=espeak-ng-data`，与 v2 源码矛盾，应按 v2 源码而不是旧示例判断 2.x 行为。
- **Kokoro 中文，官方 Python。** `KPipeline` 在 `lang_code='z'` 时构造 `zh.ZHG2P(..., en_callable=en_callable)`。`en_callable` 默认是 `None`，英文 G2P 的 espeak 回退只在 `lang_code in 'ab'` 时自动创建。[pipeline.py](https://github.com/hexgrad/kokoro/blob/main/kokoro/pipeline.py)。Issue #238（2025-07-21 开，2026-10-04 仍有回复）作者写：Kokoro-zh-v1.1「根本不读这些英语」。用户 goingHan 给出的修法是自己传入 `en.G2P(..., fallback=espeak.EspeakFallback())`，测试句是「你好，银行行长，are you ok」，并说多音字仍有问题。这是用户报告，不是维护者的听测，也不是生僻专名。[issue #238](https://github.com/hexgrad/kokoro/issues/238)。Misaki 对英文 OOV 的官方例子是 `outofdictionary`，只证明英文 G2P 加 fallback 会吐音素，不证明中文声线把该音素读对。[misaki](https://github.com/hexgrad/misaki)
- **Kokoro via sherpa-onnx。** 1.x 多语示例句是「中英文语音合成测试。This is generated by next generation Kaldi using Kokoro without Misaki. 你觉得中英文说的如何呢？」当时命令行还传 `--kokoro-data-dir=.../espeak-ng-data`，整句英文而不是句中一个专名。[PR #1795](https://github.com/k2-fsa/sherpa-onnx/pull/1795)。2.x 去掉 espeak 之后，维护者在 #4139 写：“We ignore OOVs.” 报告者用 sherpa-onnx 2.0.1 实测：`The budget is 1969 dollars` 被读成 “The budget is dollars”；`Hedy and Paradee can read Xylophonix aloud` 被读成 “and can read aloud”。[issue #4139](https://github.com/k2-fsa/sherpa-onnx/issues/4139)。Issue #4247（2026-11-20）里，仓库机器人对照当天 master 说：Kokoro 未命中词表会记 `OOV word skipped` 并省略，该路径没有 phonemizer fallback。被点名的词包括 her、or、technician，以及英式拼写 offence、programme。[issue #4247](https://github.com/k2-fsa/sherpa-onnx/issues/4247)
- **MeloTTS 中文。** README：“The Chinese speaker supports `mixed Chinese and English`. Fast enough for `CPU real-time inference`.” 许可 MIT。[README](https://github.com/myshell-ai/MeloTTS/blob/main/README.md)。官方 Python 示例就是混读句，而且指定 `device='cpu'`：`text = "我最近在学习machine learning，希望能够在未来的artificial intelligence领域有所建树。"`，`TTS(language='ZH')`。CLI 另一句是 `melo "text-to-speech 领域近年来发展迅速" zh.wav -l ZH`。[install.md](https://github.com/myshell-ai/MeloTTS/blob/main/docs/install.md)。`api.py` 把 `ZH` 改成 `ZH_MIX_EN`。[api.py](https://github.com/myshell-ai/MeloTTS/blob/main/melo/api.py)。`chinese_mix.py` 的 `__main__` 还有「我们现在 also 能够 help 很多公司 use some machine learning 的 algorithms 啊!」。英文段交给 `g2p_en`：在 CMU dict 里就用词典，否则 `_g2p(w)` 预测；`post_replace_ph` 把不在音素表里的符号换成 `UNK`，而不是把词从序列里删掉。[english.py](https://github.com/myshell-ai/MeloTTS/blob/main/melo/text/english.py)。`text_normalize` 先用 cn2an 把数字转成中文，再删掉非中文、非拉丁字母、非少量标点的字符。因此 `2.5` 会变成中文读法，`Kubernetes` 这类纯字母词会留下来。没有公开的 Kubernetes 音频。
- **sherpa-onnx 里的 Melo。** 导出脚本把 CMU dict 和拼音写进 `lexicon.txt`，并注释说新词要手工加进词典，例子是 `kaldi`。[export-onnx.py](https://github.com/k2-fsa/sherpa-onnx/blob/b74c4dfe/scripts/melo-tts/export-onnx.py)。2024 年的 #1266 对缺失英文拆字母。2.x 通用词表路径改为整词跳过（#4075、#4139）。因此「官方 Melo Python」和「sherpa-onnx 2.x 的 Melo ONNX」不是同一个前端。
- **Piper 与 VITS 中文。** 2024-06-11 维护者在 #929 对英文 VITS 词表写：“If a lexicon.txt is used, only words in the lexicon.txt can be recognized”，并建议改用当时带 espeak-ng 的 Piper，或字符模型，或把 OOV 加进词表。同一讨论里 `frameworks`、`timeframes` 从音频里消失，日志是 `OOV {some word}. Ignore it!`。维护者随后说用 Piper「you won't have OOV issues any more」。这句话的前提是 1.x 内置 espeak，2.x 已不成立。[issue #929](https://github.com/k2-fsa/sherpa-onnx/issues/929)。中文 VITS 的 2023 年实现 `ConvertTextToTokenIdsChinese` 对不在词表的片段同样 `OOV %s. Ignore it!` 然后 `continue`。[lexicon.cc 历史提交](https://dev.modelhub.org.cn/EngineX-Iluvatar/enginex-mr_series-sherpa-onnx/commit/1ee79e3ff52d9ee48d55c535862ee3f865334de8?files=sherpa-onnx%2Fcsrc%2Flexicon.cc)。2026-04 的 Piper 中文模型改为 G2PW 拼音，PR #3546 没有给出中英混读例句。[PR #3546](https://github.com/k2-fsa/sherpa-onnx/pull/3546)。2.x 文档写明 VITS 的 `data_dir` 自 v2.0.0 起被忽略。[v2 espeak FAQ](https://k2-fsa.github.io/sherpa/onnx/faqs/update-v1.x-to-v2.x-espeak-ng.html)
- **CosyVoice / Fun-CosyVoice。** README 写 “Crosslingual & Mixlingual：Support zero-shot voice cloning for cross-lingual and code-switching scenarios.” 同页代码示例全是单语中文，或整句英文加 `<|en|>`，没有句内英文专名。[CosyVoice README](https://github.com/FunAudioLLM/CosyVoice)。CosyVoice 2 论文邀请读者去听 demo，正文评测的是 test-zh、test-en、test-hard，没有引用一句中英夹杂的转写。[arXiv:2412.10117](https://arxiv.org/abs/2412.10117)。2026 年 APSIPA 论文说预训练 CosyVoice「including fluent intra-sentence code-switching」，依据是中英训练数据规模，然后他们再在 SEAME 上微调用于 ASR 数据增强；文中没有给出 TTS 听测句，也没有 Kubernetes。[arXiv:2601.00935](https://arxiv.org/html/2601.00935)。Fun-CosyVoice 3.0 的 README 增加 “Pronunciation Inpainting: Supports pronunciation inpainting of Chinese Pinyin and English CMU phonemes” 以及 “without a traditional frontend module”。这是发音可控和无传统前端的声明，仍然没有混读专名例句。模型名是 `CosyVoice2-0.5B`、`Fun-CosyVoice3-0.5B`，部署说明指向 GPU 与 vLLM，不是超极本 CPU。[CosyVoice README 镜像，2026-05-25 提交](https://powerfulbot.ai/repos/qwenaudio/cosyvoice)
- **Fish Speech。** 当前 README 的模型是 S2-Pro（4B）和 Drama 3（35B-A3B，每 token 激活 3B）。S2-Pro 写明 “small enough to deploy on a consumer GPU”，并给出 H200 上的 RTF，不是 CPU。Seed-TTS 的中文 WER 与英文 WER 是分语言测试集，不是混读句。许可证是 FISH AUDIO COMMUNITY LICENSE，S2-Pro 权重另有 Fish Audio Research License。[fish-speech README](https://github.com/fishaudio/fish-speech/)。tokenizer 对任意字符串编码，因此不会因为词表没有 `Kubernetes` 而把该词从文本序列删掉；这不证明 4B/35B 模型在 CPU 上把这个词读对。
- **IndexTTS。** IndexTTS-2.5 的官方示例把语言选在整次 `infer(..., lang="EN")` 上。发音控制的例子是汉字夹拼音，不是英文单词：「之前你做DE5很好，所以这一次也DEI3做DE2很好才XING2……」。2.5 允许调用方写入拼音、CMU 音素或假名，词表见 `checkpoints/pinyin.vocab` 和 CMU dict。README 没有一句中文里嵌着未标注英文单词的例子。[index-tts README](https://github.com/index-tts/index-tts/)。一篇 2026 评述称 IndexTTS-2.5 为 0.8B、4090 上 RTF 0.2065；这不是模型卡，不把它当作尺寸证据。
- **F5-TTS。** 论文摘要写 “seamless code-switching capability”。正文给出的机制是英文用字母、中文用全拼，词表覆盖 Emilia 里的 code-switched 句子。Base 模型 335.8M 参数。RTF 0.15 的测量是 “10s speech on NVIDIA RTX 3090”，训练在 8 张 A100 上。评测是 LibriSpeech 和 Seed-TTS 的 en/zh 分集，论文摘录里没有一句中英夹杂的转写，也没有 CPU RTF。[arXiv:2410.06885](https://arxiv.org/abs/2410.06885)。权重因 Emilia 为 CC-BY-NC，这来自二次评述，没有在本次打开 LICENSE 文件，只当作许可风险提示。[评述](https://aiwebcool.com/zh/posts/opensource-tts-models-comparison-review)
- **ChatTTS。** DeepWiki 对 `2noise/ChatTTS` 的整理说：文本经中英 normalizer 后交给 `BertTokenizerFast`，没有整词词表跳过。这是二手架构说明，不是听测。没有找到混有 Kubernetes 或同类专名的官方例句。二次评述称代码 AGPL-3.0、权重 CC BY-NC，且仓库长期少提交；未核对 LICENSE 原文。
- **更新的小模型。** sherpa-onnx C API 写 ZipVoice「supports Chinese and English」，配置仍要 `lexicon.txt`。PR #4075 把同一套词表规范化接进 ZipVoice。v2 之前 issue #3798 显示 ZipVoice 复用 `MatchaTtsLexicon`，OOV 硬编码 espeak `en-us`；维护者回复 “we are removing espeak-ng. Please don't add new member fields.” [issue #3798](https://github.com/k2-fsa/sherpa-onnx/issues/3798)；[C API](https://k2-fsa.github.io/sherpa/onnx/c-api/html/tts.html)。PocketTTS 与 Supertonic 自带前端、不需要词表，但公开语言表没有中文。Supertonic 3 的 31 种语言列表以越南语结尾，没有 `zh`。[Supertonic README](https://github.com/supertone-inc/supertonic/blob/67175af7/README.md)；[Pocket 对比说明](https://superclonica.com/en/guides/pocket-tts-alternative)

### Inferences

- 官方 Melo `language='ZH'` 是本次检索里，唯一同时满足这三条的轻量候选：文档给出中文句子里的英文单词、源码对不在 CMU dict 的英文调用神经 G2P 而不是 `continue`、并写明 CPU 实时。它没有证明 `Kubernetes` 的发音正确，只证明这个词不会因为「不在词表」而被删掉。
- CosyVoice、Fish、F5 的「多语言 / code-switching」声明，加上字符或 BPE 前端，说明它们不像词表前端那样整词删除。已发表的数字都来自单语测试集。不能把这些数字写成「已听过 Kubernetes」。
- Matcha 示例页的 `machine learning` 只能说明常见英文词在词表里。它不能反驳 2.x 对词表外专名的 `OOV word skipped`。

### Gaps

- 没有任何来源发表「请记住，版本是 2.5，名字叫 Kubernetes」的音频、音素序列或 ASR 回抄。
- 没有打开 F5、ChatTTS、Fish 的 LICENSE 原文。CC-BY-NC / AGPL / Fish 社区许可只来自 README 或评述。
- 没有 MeloTTS 的参数量和超极本 RTF。CPU 实时是 README 和 install.md 的原话。
- IndexTTS-2.5 的官方 README 摘录没有参数量。

## sherpa-onnx 有没有版本或配置把 OOV 从跳过改成 espeak？

### Takeaway

没有。2.0.0（2026-10-23）删掉了内置 espeak，维护者在 2026-10-30 明确写会忽略 OOV。替代办法是词表里加词，或在库外转成 token 再经 `GenerationConfig` 送入。不存在名为 espeak fallback 的开关。

### Cited Findings

- v2.0.0 发布说明包含 PR #4055 “Remove espeak-ng and piper-phonemize from sherpa-onnx” 和 PR #4075。发布日 2026-10-23。[v2.0.0](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.0)
- FAQ：v1 用 `--vits-data-dir` 指向 `espeak-ng-data`，库内做音素化。v2 的前端只剩词表，或库外 phonemize 后传入。`data_dir` “is deprecated and ignored”。缺这两样时的报错是 `phoneme_codepoints is empty, no lexicon, and no frontend available.` [FAQ](https://k2-fsa.github.io/sherpa/onnx/faqs/update-v1.x-to-v2.x-espeak-ng.html)
- 同一 FAQ 点名 Matcha 中英：字符串 token（例如拼音 `zhong1`）要传 `GenerationConfig.tokens`，不要传 `phoneme_codepoints`，二者互斥。示例文件 `python-api-examples/test-offline-tts-matcha-zh-en-phonemize.py`。模型包里的 `espeak-ng-data` “sherpa-onnx itself does not read it anymore.”
- Issue #3731 说明删除原因是 espeak-ng 的 GPL 与 sherpa-onnx 的 Apache-2.0 冲突。维护者给的两条路是：提供 `lexicon.txt`，或外部 piper-phonemize 后把 token 字符串传入 `GenerationConfig`。[issue #3731](https://github.com/k2-fsa/sherpa-onnx/issues/3731)
- #3731 里有人提出为西班牙语 Kokoro 做 C++ OOV G2P。维护者 2026-10-21 说可以同时要 `lexicon-es.txt` 和 “a C++ G2P to handle OOV”。这次检索没有看到该 C++ G2P 已合并，也没有看到它覆盖中英。
- #4139 作者问能不能加一个默认关闭的 ONNX G2P，避免丢词，并举了 `Xylophonix` 被删掉的例子。维护者 csukuangfj，2026-10-30：“We ignore OOVs. You may either add OOV entries to `lexicon.txt`, or tokenize the text before feeding it into sherpa-onnx. We prefer not to include a built-in g2p model in sherpa-onnx.” Issue 状态在抓取时仍是 open。数字规则他倾向于用已有的 `rule_fsts`，这只处理数字，不把未知英文读出来。[issue #4139](https://github.com/k2-fsa/sherpa-onnx/issues/4139)
- #3798（2026-07-27）拒绝给 ZipVoice 增加 `espeakVoice` 字段，理由是 espeak 即将删除。
- 1.x 里 espeak 回退写在源码里，不是用户开关：`matcha-tts-lexicon.cc` 的 `config.voice = "en-us"`，以及 `kokoro-multi-lang-lexicon.cc` 在词表未命中时 `CallPhonemizeEspeak`。2.x 对应位置变成 `OOV word skipped`，配置字段 `matcha-data-dir` / `vits-data-dir` 被忽略。
- 多文件词表是唯一的库内补词口子。`OfflineTtsKokoroModelConfig` 注释：`lexicon` 可用逗号分隔多个文件，例如 `./lexicon-gb-en.txt,./lexicon-zh.txt`。[offline-tts-kokoro-model-config.h](https://github.com/k2-fsa/sherpa-onnx/blob/3193519a/sherpa-onnx/csrc/offline-tts-kokoro-model-config.h)。#4247 的机器人说后面的文件覆盖前面的。这仍然要求每个专名事先写进行，不是未知词自动回退。
- C API 把库外音素化写成 `SherpaOnnxGenerationConfig::phoneme_codepoints` 或 `::tokens`，词表留空。[C API TTS](https://k2-fsa.github.io/sherpa/onnx/c-api/html/tts.html)

### Inferences

- 若必须留在 sherpa-onnx 2.x，又不能接受静默丢词，调用方要在库外做 G2P，并把结果放进 `GenerationConfig.tokens`（Matcha/Kokoro 中文的拼音和音素字符串）或 `phoneme_codepoints`（音素是单个码位时）。库不会在查词失败后自动调用 espeak。
- 外部音素若映射不到 `tokens.txt`，仍会被丢掉。FAQ 把这一步留在库外，所以「传了 tokens 就不会丢词」只在符号全部属于模型词表时成立。
- 钉住 1.x 能找回内置 espeak，同时重新带上 GPL 的 espeak-ng。这是 #3731 写明的删除动机。1.x 仍会 `Skip token` / `Skip OOV token`，只是不再整词跳过。

### Gaps

- 没有逐行核对 2026-11-24 当天 master 的 `offline-tts-kokoro-impl.h`。11 月 20 日的 #4247 评论和 10 月 30 日的维护者回复一致，都是跳过。
- #4139 作者说会在 fork 里做可选 ONNX G2P。没有看到该 PR 已进入上游，不能把它写成 sherpa-onnx 的选项。
- 没有核对 `test-offline-tts-matcha-zh-en-phonemize.py` 的全文，只引用了 FAQ 对它的说明。

## 哪些小系统已知不擅长中英混读？

### Takeaway

小模型里，失败模式已经写进日志或维护者回复的，是 sherpa-onnx 2.x 的词表前端（英文整词消失）、默认不接英文 G2P 的 Kokoro-zh 1.1（英文不读），以及中文 VITS 词表（`OOV ... Ignore it!`）。「英文被当成拼音字母来读」没有在这些小模型的听测里被记录；那是另一类前端设计，不是这次日志能证明的现象。

### Cited Findings

- 整词消失，其余句子照常合成：`OOV word skipped`（2.x Matcha、Kokoro、VITS、ZipVoice 的词表路径，#4075 的文件列表包含 `offline-tts-{kitten,kokoro,matcha,zipvoice,vits}-impl.h`）；#4139 的 “and can read aloud”；#4247 的 her / or / technician 被省略。Kokoro 1.x 多语词表在命中时会读，所以 `hello` 这类在词表里的词能出声，不在词表里的专名不能。本次没有打开 `lexicon-zh.txt` 核对 `hello` 与 `Kubernetes` 两行是否存在；#4139 的 `Xylophonix` 和 #4247 的常见词缺失，已经说明「多语模型」不等于「任意英文都在词表里」。
- 默认 Kokoro 中文不读句中英文：issue #238 对 v1.1 的描述，以及 `en_callable` 默认为空。接上 espeak 之后，同一 issue 的用户仍说混读「的确没法用」、多音字不好。这是质量差，不是静默删除。
- 中文 VITS / 旧 lexicon.cc：非中文或未登录片段 `Ignore it!`（#929 与 2023 年中文分支）。
- Piper 中文 G2PW（#3546）把中文变成拼音。本次没有找到它读出或丢掉句中英文的 issue。不能把「拼音前端」写成「已经听过英文被丢」。
- piper-plus 故意把嵌入英文转成普通话拼音，最后才字母回退。这是「用中文读音读英文」，而且是设计，不是上游 Piper 的 bug 报告。
- 2.x 的 Piper 英文也不再享有 2024 年「用了 Piper 就没有 OOV」的保证。#4247 的缺失词来自 `lexicon-en-us.txt`。
- PocketTTS、Supertonic 3 不在「中文混读很差」之列：它们的语言表没有中文，不能用来读这句中文。

### Inferences

- 用户描述的 bug（英文从音频里消失、日志里是跳过、句子其余部分仍在）与 sherpa-onnx 2.x 词表前端一致，与「声学模型叫 zh-en」不矛盾。zh-en 标的是声学模型的训练语言，2.x 送进模型的是词表 id；id 在查表阶段就没了。
- 把英文读成一串拼音字母，本次没有小模型听测可以引用。不要把 Matcha 或 Melo 写成有这个毛病。Melo 对英文段走的是 ARPAbet，不是拼音。

### Gaps

- 没有对 Piper 中文 G2PW、sherpa 导出的 Melo ONNX、Matcha 2.x 用同一句专名做对照录音。
- 没有在本次打开 Kokoro 中文词表文件，所以不能引用 `hello` 命中、`Kubernetes` 未命中的具体行号。行为由 OOV 分支证明，不由那两行的有无证明。

## 实用建议：最小、且前端不会静默丢掉未知英文的开源模型是哪个？

### Takeaway

要留在超极本 CPU 上，用官方 MeloTTS 的中文说话人（`language='ZH'`，内部是 `ZH_MIX_EN`），不要用 sherpa-onnx 2.x 的词表运行时。更小的 Kokoro-82M 只有在调用方自己传入带 `EspeakFallback` 的 `en_callable` 时才不会丢词；sherpa-onnx 2.x 做不到这一步。F5-TTS 的字母前端是更干净的 code-switching 设计，但是 336M 的 flow-matching 模型，论文的 RTF 是在 RTX 3090 上测的，不能当成超极本方案。

### Cited Findings

- 建议本体：MyShell MeloTTS，MIT，中文说话人官方示例就是「我最近在学习machine learning……」，`device='cpu'`，README 写 CPU 实时。[install.md](https://github.com/myshell-ai/MeloTTS/blob/main/docs/install.md)。未知英文走 `g2p_en` 的神经预测，而不是跳过。[chinese_mix.py](https://github.com/myshell-ai/MeloTTS/blob/main/melo/text/chinese_mix.py)；[g2p](https://github.com/Kyubyong/g2p/)
- 更小、但必须改调用方式的替代：`hexgrad/Kokoro-82M` 仓库名即项目对参数量的标注；中文用 `misaki.zh.ZHG2P` 的 `en_callable`。英文侧 `EspeakFallback` 能给词典外的拼写吐音素（`outofdictionary` 例子）。不传 `en_callable` 时，#238 的 v1.1 不读英文。sherpa-onnx 2.x 的 Kokoro 运行时没有这条回调，维护者选择忽略 OOV。[pipeline.py](https://github.com/hexgrad/kokoro/blob/main/kokoro/pipeline.py)；[issue #4139](https://github.com/k2-fsa/sherpa-onnx/issues/4139)
- 若应用已经绑在 sherpa-onnx 2.x：在进程外做音素化，Matcha 中英用 `GenerationConfig.tokens`，其它音素模型用 `phoneme_codepoints`，并保证每个符号都在该模型的 `tokens.txt` 里。这不是一个配置开关。[FAQ](https://k2-fsa.github.io/sherpa/onnx/faqs/update-v1.x-to-v2.x-espeak-ng.html)
- 作为「方法是对的、机器跑不动」的对照：F5-TTS base 335.8M，英文保持字母，中文转全拼，RTF 0.15 测于 RTX 3090。CosyVoice2-0.5B 与 Fish S2-Pro 4B 同样不是这次的 CPU 约束。[F5-TTS](https://arxiv.org/abs/2410.06885)；[fish-speech](https://github.com/fishaudio/fish-speech/)

### Inferences

- Melo 的集成代价是口音和猜测发音，不是丢词。中文说话人用 ARPAbet 读英文，口音会偏中文；神经 G2P 对 `Kubernetes` 可能读错，但序列里有这个词的音素。数字会先被 cn2an 读成中文，`2.5` 不会按英语 “two point five” 读，除非换掉 normalizer。依赖里有 `bert-base-multilingual-uncased`，内存会大于 82M 的 Kokoro，文档仍把 CPU 当作目标设备。
- Kokoro 官方路径更小，但是 espeak-ng 是额外系统依赖，中文声线读英文音素的口音问题在 #238 里被用户直接抱怨。这条路径没有 sherpa-onnx 的离线 C API。
- 继续用 sherpa-onnx 2.x 的 Matcha zh-en 或 Kokoro zh，只加词表，解决不了「任意专名」：维护者已把「忽略 OOV、请自己加词或事先分词」写成策略。

### Gaps

- 没有在这台机器上跑 Melo 或 Kokoro，所以没有 `Kubernetes` 的新听测。建议只承诺「前端不会把词丢掉」，不承诺读音像母语者。
- Melo 相对 Kokoro 的内存和首包延迟没有公开数字。
- F5 权重的 CC-BY-NC 没有用仓库 LICENSE 原文复核。
