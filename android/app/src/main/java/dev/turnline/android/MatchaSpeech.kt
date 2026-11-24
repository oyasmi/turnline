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
import java.util.Locale
import java.util.concurrent.Executors
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

    fun play(chunks: List<String>, attributes: AudioAttributes, finished: (String?) -> Unit) {
        stop()
        val playback = Playback()
        current = playback
        worker.execute {
            if (playback.cancelled) return@execute
            val error = try {
                synthesize(playback, chunks, attributes)
                null
            } catch (error: Exception) {
                reportFailure(error)
            } catch (error: LinkageError) {
                reportFailure(error)
            }
            if (!playback.cancelled) finished(error)
        }
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

    private fun synthesize(playback: Playback, chunks: List<String>, attributes: AudioAttributes) {
        val voice = model ?: createModel().also { model = it }
        if (playback.cancelled) return
        val track = playback.open(voice.sampleRate(), attributes) ?: return
        try {
            var framesWritten = 0L
            for (chunk in chunks) {
                if (playback.cancelled) return
                val text = if (WORD.containsMatchIn(chunk) || NUMBER.containsMatchIn(chunk)) {
                    matchaText(chunk, englishWords)
                } else chunk
                // Keep any playback exception on the Kotlin side of the JNI call.
                var error: Exception? = null
                voice.generateWithCallback(text, speed = 1.07f, callback = AudioCallback { samples ->
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
            }
            if (playback.cancelled) return
            check(framesWritten > 0) { "Matcha produced no audio" }
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

    private class AudioCallback(val write: (FloatArray) -> Int) : (FloatArray) -> Int {
        override fun invoke(samples: FloatArray): Int = write(samples)
    }

    private class Playback {
        @Volatile var cancelled = false
            private set
        private var track: AudioTrack? = null

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
    val hasHan = text.codePoints().anyMatch { Character.UnicodeScript.of(it) == Character.UnicodeScript.HAN }
    val normalized = if (hasHan) text else NUMBER.replace(text) { match ->
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

private val NUMBER = Regex("(?<![\\p{L}\\p{N}_.])([+-]?)([0-9]+)(?:\\.([0-9]+))?(?![\\p{L}\\p{N}_]|\\.[0-9])")
private val WORD = Regex("[A-Za-z]+(?:['’\\-][A-Za-z]+)*")
private val UNITS = ("zero one two three four five six seven eight nine ten eleven twelve thirteen " +
    "fourteen fifteen sixteen seventeen eighteen nineteen").split(' ')
private val TENS = "zero ten twenty thirty forty fifty sixty seventy eighty ninety".split(' ')
private val SCALES = listOf(1_000_000 to "million", 1_000 to "thousand", 100 to "hundred")
