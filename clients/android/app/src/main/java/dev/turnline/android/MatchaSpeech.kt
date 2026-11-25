package dev.turnline.android

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsMatchaModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import java.text.Normalizer
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import kotlin.math.abs

internal class MatchaSpeech(context: Context) {
    private val assets = context.assets
    private val worker = Executors.newSingleThreadExecutor()
    private var current: Playback? = null

    // The model and lexicon are accessed only from the synthesis worker.
    private var model: OfflineTts? = null
    private val englishWords by lazy {
        assets.open("$MODEL/english-words.txt").bufferedReader().useLines { it.toHashSet() }
    }

    fun play(
        chunks: List<String>,
        attributes: AudioAttributes,
        speed: Float = 1.07f,
        onChunkStart: (String) -> Unit = {},
        onChunkDone: (String) -> Unit = {},
        finished: (String?) -> Unit
    ) {
        val stream = startStream(attributes, speed, onChunkStart, onChunkDone, finished)
        chunks.forEach(stream::enqueue)
        stream.seal()
    }

    fun startStream(
        attributes: AudioAttributes,
        speed: Float = 1.07f,
        onChunkStart: (String) -> Unit = {},
        onChunkDone: (String) -> Unit = {},
        finished: (String?) -> Unit
    ): StreamSession {
        stop()
        val playback = Playback()
        current = playback
        worker.execute {
            if (playback.cancelled) return@execute
            val error = try {
                synthesizeStream(playback, attributes, speed, onChunkStart, onChunkDone)
                null
            } catch (error: Exception) {
                reportFailure(error)
            } catch (error: LinkageError) {
                reportFailure(error)
            }
            if (!playback.cancelled) finished(error)
        }
        return StreamSession(playback)
    }

    fun stop() {
        current?.cancel()
        current = null
    }

    fun close() {
        stop()
        worker.execute { model?.release() }
        worker.shutdown()
    }

    private fun synthesizeStream(
        playback: Playback,
        attributes: AudioAttributes,
        speed: Float,
        onChunkStart: (String) -> Unit,
        onChunkDone: (String) -> Unit
    ) {
        val voice = model ?: createModel().also { model = it }
        if (playback.cancelled) return
        val track = playback.open(voice.sampleRate(), attributes) ?: return
        try {
            var framesWritten = 0L
            while (!playback.cancelled) {
                val entry = playback.nextItem()
                if (entry is StreamItem.End) break
                val chunk = (entry as StreamItem.Chunk).text
                if (playback.cancelled) return
                onChunkStart(chunk)
                val text = matchaText(chunk, englishWords)
                // Keep any playback exception on the Kotlin side of the JNI call.
                var error: Exception? = null
                voice.generateWithCallback(text, speed = speed, callback = AudioCallback { samples ->
                    try {
                        if (!playback.cancelled && samples.isNotEmpty()) {
                            check(samples.all(Float::isFinite)) { "Invalid Matcha audio samples" }
                            if (framesWritten > 0 || samples.any { abs(it) > 1e-6f }) {
                                framesWritten += playback.write(track, samples)
                            }
                        }
                        if (playback.cancelled) 0 else 1
                    } catch (failure: Exception) {
                        error = failure
                        0
                    }
                })
                error?.let { throw it }
                if (!playback.cancelled) onChunkDone(chunk)
            }
            if (playback.cancelled) return
            if (framesWritten == 0L) return
            while (!playback.cancelled && track.playbackHeadPosition.toUInt().toLong() < framesWritten) {
                Thread.sleep(10)
            }
        } finally {
            playback.release(track)
        }
    }

    private fun createModel() = OfflineTts(assets, OfflineTtsConfig(
        model = OfflineTtsModelConfig(
            matcha = OfflineTtsMatchaModelConfig(
                acousticModel = "$MODEL/model-steps-3.onnx",
                vocoder = "$MODEL/vocos-16khz-univ.onnx",
                lexicon = "$MODEL/lexicon.txt",
                tokens = "$MODEL/tokens.txt"
            ),
            numThreads = 2
        ),
        ruleFsts = listOf("phone-zh.fst", "date-zh.fst", "number-zh.fst").joinToString(",") { "$MODEL/$it" },
        maxNumSentences = 1
    ))

    private fun reportFailure(error: Throwable): String {
        Log.w("TurnlineMatcha", "Matcha playback failed", error)
        return "Matcha 播报失败。请重试或切换到系统播报。"
    }

    internal class StreamSession(private val playback: Playback) {
        fun enqueue(chunk: String) = playback.enqueue(chunk)
        fun seal() = playback.seal()
    }

    internal sealed interface StreamItem {
        data class Chunk(val text: String) : StreamItem
        data object End : StreamItem
    }

    private class AudioCallback(val write: (FloatArray) -> Int) : (FloatArray) -> Int {
        override fun invoke(samples: FloatArray): Int = write(samples)
    }

    internal class Playback {
        @Volatile var cancelled = false
            private set
        private val queue = LinkedBlockingQueue<StreamItem>()
        private var track: AudioTrack? = null

        fun enqueue(chunk: String) {
            if (!cancelled && chunk.isNotBlank()) queue.offer(StreamItem.Chunk(chunk))
        }

        fun seal() {
            queue.offer(StreamItem.End)
        }

        fun nextItem(): StreamItem = queue.take()

        @Synchronized
        fun open(sampleRate: Int, attributes: AudioAttributes): AudioTrack? {
            if (cancelled) return null
            val bufferSize = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_FLOAT)
            check(bufferSize > 0) { "Unsupported Matcha audio format" }
            val output = AudioTrack.Builder().setAudioAttributes(attributes)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_FLOAT).build())
                .setBufferSizeInBytes(bufferSize).setTransferMode(AudioTrack.MODE_STREAM).build()
            try {
                check(output.state == AudioTrack.STATE_INITIALIZED) { "Matcha audio output failed to initialize" }
                output.setStartThresholdInFrames(1)
                output.play()
                track = output
                return output
            } catch (error: Exception) {
                output.release()
                throw error
            }
        }

        fun write(output: AudioTrack, samples: FloatArray): Int {
            var offset = 0
            while (offset < samples.size && !cancelled) {
                val count = synchronized(this) {
                    if (cancelled) return offset
                    output.write(samples, offset, samples.size - offset, AudioTrack.WRITE_NON_BLOCKING)
                }
                check(count >= 0) { "Matcha audio write failed ($count)" }
                if (count == 0) Thread.sleep(10)
                offset += count
            }
            return offset
        }

        @Synchronized
        fun cancel() {
            cancelled = true
            queue.clear()
            queue.offer(StreamItem.End)
            track?.let { output ->
                runCatching { output.pause() }
                runCatching { output.flush() }
            }
        }

        @Synchronized
        fun release(output: AudioTrack) {
            track = null
            output.release()
        }
    }

    private companion object {
        const val MODEL = "matcha-icefall-zh-en"
    }
}

// Matcha uses a lexicon and skips English words it cannot look up.
internal fun matchaText(text: String, englishWords: Set<String>): String {
    var prepared = FULLWIDTH_CODE.replace(Normalizer.normalize(text, Normalizer.Form.NFC)) { match ->
        Normalizer.normalize(match.value, Normalizer.Form.NFKC)
    }
    prepared = COLON_PAUSE.replace(prepared.replace('：', ':'), "，")
    prepared = CODE_TOKEN.replace(prepared, ::expandModelCode)

    val hasHan = prepared.codePoints().anyMatch { Character.UnicodeScript.of(it) == Character.UnicodeScript.HAN }
    if (hasHan) {
        prepared = CLOCK_TIME.replace(prepared) { "${it.groupValues[1]}点${it.groupValues[2]}分" }
    }

    val normalized = if (hasHan) prepared else NUMBER.replace(prepared) { match ->
        val (sign, whole, fraction) = match.destructured
        val signed = when (sign) {
            "-" -> "minus "
            "+" -> "plus "
            else -> ""
        }
        val units = if (whole.length >= 9 || (whole.length > 1 && whole.startsWith('0'))) {
            spellDigits(whole)
        } else {
            spellInteger(whole.toInt())
        }
        signed + units + if (fraction.isEmpty()) "" else " point ${spellDigits(fraction)}"
    }
    return WORD.replace(normalized) { match ->
        val word = match.value.lowercase(Locale.ROOT).replace('’', '\'')
        if (word in englishWords) word else word.split('-').joinToString(" ", " ", " ") { part ->
            if (part in englishWords) part else part.replace("'", "").toList().joinToString(" ")
        }
    }
}

private fun expandModelCode(match: MatchResult): String {
    val token = match.value
    val parts = CODE_PART.findAll(token).map { it.value }.toList()
    val hasLetters = parts.any { it.first().isLetter() }
    val hasDigits = parts.any { it.first().isDigit() }
    if (!hasLetters || !hasDigits) return token
    return parts.flatMap { part ->
        if (part.first().isDigit()) {
            part.map { ch -> if (ch == '.') "point" else UNITS[ch.digitToInt()] }
        } else listOf(part)
    }.joinToString(" ")
}

private fun spellDigits(digits: String) = digits.map { UNITS[it.digitToInt()] }.joinToString(" ")

private fun spellInteger(number: Int): String = when {
    number < 20 -> UNITS[number]
    number < 100 -> TENS[number / 10] + if (number % 10 == 0) "" else " ${UNITS[number % 10]}"
    else -> {
        val (scale, label) = SCALES.first { number >= it.first }
        val remainder = number % scale
        "${spellInteger(number / scale)} $label" + if (remainder == 0) "" else " ${spellInteger(remainder)}"
    }
}

private val FULLWIDTH_CODE = Regex("[Ａ-Ｚａ-ｚ０-９]+")
private val COLON_PAUSE = Regex("(?<![0-9]):|:(?![0-9])")
private val CLOCK_TIME = Regex("(?<![0-9:])([01]?[0-9]|2[0-3]):([0-5][0-9])(?![0-9:])")
private val CODE_TOKEN = Regex("[A-Za-z0-9]+(?:[._\\-‐‑–][A-Za-z0-9]+)*")
private val CODE_PART = Regex("[A-Za-z]+|[0-9]+(?:\\.[0-9]+)*")
private val NUMBER = Regex("(?<![\\p{L}\\p{N}_.])([+-]?)([0-9]+)(?:\\.([0-9]+))?(?![\\p{L}\\p{N}_]|\\.[0-9])")
private val WORD = Regex("[A-Za-z]+(?:['’\\-][A-Za-z]+)*")
private val UNITS = ("zero one two three four five six seven eight nine ten eleven twelve thirteen " +
    "fourteen fifteen sixteen seventeen eighteen nineteen").split(' ')
private val TENS = "zero ten twenty thirty forty fifty sixty seventy eighty ninety".split(' ')
private val SCALES = listOf(1_000_000 to "million", 1_000 to "thousand", 100 to "hundred")
