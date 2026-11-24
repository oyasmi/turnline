package dev.turnline.android

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

sealed interface Heard {
    data class Text(val value: String) : Heard
    data object Silence : Heard
    data class Problem(val message: String) : Heard
}

class DeviceSpeech(private val context: Context) {
    private val main = Handler(Looper.getMainLooper())
    private val audio = context.getSystemService(AudioManager::class.java)
    private var recognition: SpeechRecognizer? = null
    private var deadline: Runnable? = null
    private var engine: TextToSpeech? = null
    private var engineReady = false
    private var engineEpoch = 0L
    private var playback: Playback? = null
    private var focus: AudioFocusRequest? = null
    private var nextPlayback = 0L

    fun listen(
        settings: ServiceSettings,
        onText: (String) -> Unit,
        onLevel: (Float) -> Unit,
        onTranscribing: () -> Unit,
        onResult: (Heard) -> Unit
    ) {
        cancelRecognition()
        val local = settings.localRecognition
        val recognizer = try {
            when {
                local && SpeechRecognizer.isOnDeviceRecognitionAvailable(context) ->
                    SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                !local && SpeechRecognizer.isRecognitionAvailable(context) ->
                    SpeechRecognizer.createSpeechRecognizer(context)
                else -> {
                    onResult(Heard.Problem(if (local) "设备没有可用的离线识别。可在设置中切换到系统识别。"
                        else "设备没有可用的语音识别服务。"))
                    return
                }
            }
        } catch (_: RuntimeException) {
            onResult(Heard.Problem("无法启动语音识别。请检查麦克风权限和系统语音服务。"))
            return
        }
        recognition = recognizer

        fun finish(result: Heard) {
            if (recognition !== recognizer) return
            cancelRecognition()
            onResult(result)
        }

        fun results(bundle: Bundle?): String =
            bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull()?.trim()?.take(MAX_INPUT).orEmpty()

        fun timeout(ms: Long, action: () -> Unit) {
            deadline?.let(main::removeCallbacks)
            deadline = Runnable(action).also { main.postDelayed(it, ms) }
        }

        var transcribing = false
        fun transcribe() {
            if (recognition !== recognizer || transcribing) return
            transcribing = true
            onLevel(0f)
            onTranscribing()
            timeout(12_000) { finish(Heard.Problem("语音转写超时。点按麦克风可以重试。")) }
        }

        val listener = object : RecognitionListener {
            private var lastLevel = 0L

            override fun onReadyForSpeech(params: Bundle?) {
                if (recognition === recognizer) timeout(16_000) { finish(Heard.Silence) }
            }

            override fun onBeginningOfSpeech() {
                if (recognition !== recognizer) return
                timeout(45_000) {
                    transcribe()
                    try {
                        recognizer.stopListening()
                    } catch (_: RuntimeException) {
                        finish(Heard.Problem("无法完成语音转写。点按麦克风可以重试。"))
                    }
                }
            }

            override fun onRmsChanged(rmsdB: Float) {
                if (recognition !== recognizer || transcribing) return
                val now = SystemClock.elapsedRealtime()
                if (now - lastLevel >= 75) {
                    lastLevel = now
                    if (rmsdB.isFinite()) onLevel(((rmsdB + 1) / 12).coerceIn(0f, 1f))
                }
            }

            override fun onEndOfSpeech() = transcribe()

            override fun onPartialResults(partialResults: Bundle?) {
                if (recognition === recognizer) onText(results(partialResults))
            }

            override fun onResults(results: Bundle?) {
                val text = results(results)
                finish(if (text.isBlank()) Heard.Silence else Heard.Text(text))
            }

            override fun onError(error: Int) {
                val result = when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> Heard.Silence
                    SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED,
                    SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> Heard.Problem(
                        "所选语言的识别模型不可用。请安装系统语音包，或在设置中更换语言或识别方式。"
                    )
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> Heard.Problem("请在系统设置中允许 Turnline 使用麦克风。")
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY, SpeechRecognizer.ERROR_AUDIO ->
                        Heard.Problem("麦克风暂时不可用。请关闭占用麦克风的应用后重试。")
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
                        Heard.Problem("系统识别服务无法联网。可以切换到设备支持的离线识别。")
                    else -> Heard.Problem("语音识别已中断，请点按麦克风重试。")
                }
                finish(result)
            }

            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        }

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, local)
            .apply { if (settings.language.tag.isNotEmpty()) putExtra(RecognizerIntent.EXTRA_LANGUAGE, settings.language.tag) }
        try {
            recognizer.setRecognitionListener(listener)
            timeout(12_000) { finish(Heard.Problem("语音识别服务启动超时。点按麦克风可以重试。")) }
            recognizer.startListening(intent)
        } catch (_: RuntimeException) {
            finish(Heard.Problem("无法启动麦克风。请检查权限后重试。"))
        }
    }

    fun cancelRecognition() {
        deadline?.let(main::removeCallbacks)
        deadline = null
        val current = recognition
        recognition = null
        if (current != null) {
            runCatching { current.cancel() }
            runCatching { current.destroy() }
        }
    }

    fun speak(text: String, language: SpeechLanguage, finished: (String?) -> Unit) {
        stopSpeaking()
        val id = ++nextPlayback
        val watchdog = Runnable {
            if (playback?.id == id && !engineReady) finishPlayback(id, "系统播报服务启动超时。")
        }
        playback = Playback(id, text, language, finished, watchdog)
        main.postDelayed(watchdog, 8_000)
        when {
            engineReady -> startPlayback()
            engine == null -> {
                val epoch = ++engineEpoch
                try {
                    engine = TextToSpeech(context) { status ->
                        main.post {
                            if (engine == null || epoch != engineEpoch) return@post
                            engineReady = status == TextToSpeech.SUCCESS
                            if (engineReady) startPlayback()
                            else {
                                val pending = playback
                                if (pending == null) shutdownEngine()
                                else finishPlayback(pending.id, "设备没有可用的系统播报服务。")
                            }
                        }
                    }
                } catch (_: RuntimeException) {
                    finishPlayback(id, "无法启动系统播报服务。")
                }
            }
        }
    }

    private fun startPlayback() {
        val current = playback ?: return
        val tts = engine ?: return
        main.removeCallbacks(current.watchdog)
        try {
            enqueueSpeech(tts, current)
        } catch (_: RuntimeException) {
            finishPlayback(current.id, "系统播报失败。")
        }
    }

    private fun enqueueSpeech(tts: TextToSpeech, current: Playback) {
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(attributes).setWillPauseWhenDucked(true)
            .setOnAudioFocusChangeListener({ change ->
                if (change < 0) finishPlayback(current.id, "播报被其他音频打断。")
            }, main).build()
        if (audio.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            finishPlayback(current.id, "暂时无法播放语音。")
            return
        }
        focus = request

        val locale = voiceLocale(current.text, current.language)
        val localVoice = tts.voices.orEmpty().filter {
            it.locale.language == locale.language && !it.isNetworkConnectionRequired &&
                TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in it.features
        }.maxByOrNull { it.quality + if (it.locale.country == locale.country) 1000 else 0 }
        val languageAvailable = if (localVoice != null && tts.setVoice(localVoice) == TextToSpeech.SUCCESS) {
            true
        } else {
            tts.setLanguage(locale) >= TextToSpeech.LANG_AVAILABLE
        }
        if (!languageAvailable) {
            finishPlayback(current.id, "设备缺少该语言的播报语音。请在系统文字转语音设置中安装。")
            return
        }

        val chunks = speechChunks(current.text)
        val last = "${current.id}:${chunks.lastIndex}"
        val limit = Runnable { finishPlayback(current.id, "播报用时过长，已停止。") }
        current.limit = limit
        main.postDelayed(limit, (15_000L + current.text.length * 180L).coerceAtMost(600_000L))
        tts.setAudioAttributes(attributes)
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = Unit
            override fun onDone(utteranceId: String?) {
                if (utteranceId == last) main.post { finishPlayback(current.id, null) }
            }

            @Deprecated("Required by the Android listener")
            override fun onError(utteranceId: String?) {
                if (utteranceId?.startsWith("${current.id}:") == true) {
                    main.post { finishPlayback(current.id, "系统播报失败。") }
                }
            }
        })
        for ((i, chunk) in chunks.withIndex()) {
            if (tts.speak(chunk, TextToSpeech.QUEUE_ADD, null, "${current.id}:$i") == TextToSpeech.ERROR) {
                finishPlayback(current.id, "系统播报失败。")
                break
            }
        }
    }

    private fun finishPlayback(id: Long, error: String?) {
        val current = playback?.takeIf { it.id == id } ?: return
        stopSpeaking()
        if (!engineReady) shutdownEngine()
        current.finished(error)
    }

    fun stopSpeaking() {
        val current = playback
        playback = null
        current?.let {
            main.removeCallbacks(it.watchdog)
            it.limit?.let(main::removeCallbacks)
            runCatching { engine?.stop() }
        }
        focus?.let { runCatching { audio.abandonAudioFocusRequest(it) } }
        focus = null
    }

    fun close() {
        cancelRecognition()
        stopSpeaking()
        shutdownEngine()
    }

    private fun shutdownEngine() {
        val current = engine
        engine = null
        engineReady = false
        runCatching { current?.shutdown() }
    }

    private data class Playback(
        val id: Long,
        val text: String,
        val language: SpeechLanguage,
        val finished: (String?) -> Unit,
        val watchdog: Runnable,
        var limit: Runnable? = null
    )
}

private fun voiceLocale(text: String, language: SpeechLanguage): Locale {
    val han = text.count { it in '\u3400'..'\u9fff' }
    val latin = text.count { it in 'A'..'Z' || it in 'a'..'z' }
    return when {
        han > 0 && han * 3 >= latin -> Locale.SIMPLIFIED_CHINESE
        latin >= 3 && han == 0 -> Locale.US
        language.tag.isNotEmpty() -> Locale.forLanguageTag(language.tag)
        else -> Locale.getDefault()
    }
}

internal fun speakableText(text: String): String = replyBlocks(text)
    .filterNot { it.code }.joinToString("\n") { it.text }
    .replace(Regex("!\\[[^]]*]\\([^)]+\\)"), "")
    .replace(Regex("\\[([^]]+)]\\([^)]+\\)"), "$1")
    .replace(Regex("https?://[^\\s，。！？]+"), "")
    .replace(Regex("(?m)^\\s*(?:#{1,6} |[-*+] |>|\\d+\\. )"), "")
    .replace(Regex("[`*_~]"), "").trim().take(12_000)

internal fun speechChunks(text: String): List<String> = buildList {
    var remaining = text.trim()
    while (remaining.isNotEmpty()) {
        val limit = minOf(180, remaining.length)
        val split = if (limit == remaining.length) limit else {
            val punctuation = remaining.take(limit).indexOfLast { it in "。！？!?；;\n" }
            val space = remaining.lastIndexOf(' ', limit - 1)
            maxOf(punctuation, space).takeIf { it >= 30 }?.plus(1) ?: limit
        }
        val end = if (Character.isHighSurrogate(remaining[split - 1]) && split < remaining.length) split - 1 else split
        val part = remaining.substring(0, end).trim()
        if (part.isNotEmpty()) add(part)
        remaining = remaining.substring(end).trimStart()
    }
}
