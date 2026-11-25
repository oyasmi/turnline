package dev.turnline.android

/**
 * Splits streaming assistant text into speakable phrases for low-latency live TTS.
 * Mirrors Turnline Web's chunker rules (fast opening phrase + soft punctuation/word boundaries).
 */
data class SpeechSplit(val phrases: List<String>, val rest: String)

private val HIDDEN_SPEECH = Regex(
    "`{3}[\\s\\S]*?(?:`{3}|$)|!\\[[^\\]\\n]*]\\([^)]*(?:\\)|$)|(?<=])\\([^)]*(?:\\)|$)|https?://[^\\s，。！？]+"
)
private val ORDERED_LIST_PREFIX = Regex("(?m)^[ \\t]*\\d+\\.\\s")
private const val WORD_CHAR = "[A-Za-z\\u00C0-\\u024F0-9]"
private const val WORD_JOINER = "[.'’_．＿‐‑–－-]"
private const val WORD = "$WORD_CHAR+(?:$WORD_JOINER$WORD_CHAR+)*"
private const val NUMBER = "[0-9]+(?:[.,．:：][0-9]+)*(?:[ \\t]*(?:[%％]|[KMGTＫＭＧＴ][BＢ]))?"
private const val SPEECH_WORD = "$NUMBER(?!$WORD_CHAR|$WORD_JOINER$WORD_CHAR)|$WORD"
private val OPENING_WORDS = Regex("[\\u3400-\\u9FFF]|$SPEECH_WORD|[\\p{L}\\p{N}]")
private val SPEECH_WORDS = Regex(SPEECH_WORD)
private val UNFINISHED_WORD = Regex("^$WORD_JOINER?$")
private val WORD_ENDING = Regex("$WORD_CHAR$")
private val NUMBER_ENDING = Regex("[0-9]$")
private val HAN_CHAR = Regex("[\\u3400-\\u9FFF]")
private val LATIN_START = Regex("^[A-Za-z\\u00C0-\\u024F]")
private val ALNUM_CHAR = Regex("[\\p{L}\\p{N}]")
private val OPENING_COMPLETE = Regex("[。！？!?；;]|\\.(?=\\s)")
private val OPENING_PAUSE = Regex("[。！？!?；;\\n，、：:]+|,(?!\\d)|\\.(?=\\s|$)")
private val SENTENCE_END = Regex("[。！？!?；;\\n]+|\\.\\s+")
private val LEADING_SPACE = Regex("^\\s*")
private val BOLD_HEADING = Regex("^\\*\\*.+\\*\\*$")
private val BULLET_LINE = Regex("^\\s*[-*+]\\s")
private val INLINE_CODE = Regex("`[^`]*`\\s*")
private val LEADING_NON_ALNUM = Regex("^[^\\p{L}\\p{N}]+")

private fun pendingWord(word: String, gap: String): Boolean =
    (WORD_ENDING.containsMatchIn(word) && UNFINISHED_WORD.matches(gap)) ||
        (NUMBER_ENDING.containsMatchIn(word) && (gap == ":" || gap == "："))

private fun visibleSpeech(text: String): String =
    HIDDEN_SPEECH.replace(text) { " ".repeat(it.value.length) }
        .let { ORDERED_LIST_PREFIX.replace(it) { match -> " ".repeat(match.value.length) } }

private fun openingEnd(text: String): Int {
    val visible = visibleSpeech(text)
    val words = OPENING_WORDS.findAll(visible).toList()
    var characters = 0
    var han = 0
    var latin = 0
    var previousEnd = 0
    for ((index, match) in words.withIndex()) {
        val end = match.range.last + 1
        characters += ALNUM_CHAR.findAll(match.value).count()
        if (HAN_CHAR.containsMatchIn(match.value)) han++
        else if (LATIN_START.containsMatchIn(match.value)) latin++
        val nextStart = words.getOrNull(index + 1)?.range?.first ?: visible.length
        val gap = visible.substring(end, nextStart)
        val complete = OPENING_COMPLETE.find(gap)
        if (complete != null && index + 1 < words.size) {
            return end + complete.range.last + 1
        }
        if (han >= 6 || latin >= 3) {
            val pause = OPENING_PAUSE.find(gap)
            if (pause != null && !(NUMBER_ENDING.containsMatchIn(match.value) && pendingWord(match.value, gap))) {
                return end + pause.range.last + 1
            }
        }
        if (characters >= 14) {
            if (pendingWord(match.value, gap)) return previousEnd
            return end
        }
        if (han >= 6 || latin >= 3) previousEnd = end
    }
    return 0
}

private fun softSpeechEnd(text: String, start: Int, end: Int, flush: Boolean): Int {
    for (match in SPEECH_WORDS.findAll(text)) {
        val matchStart = match.range.first
        if (matchStart >= end) break
        val wordEnd = match.range.last + 1
        val pending = !flush && pendingWord(match.value, text.substring(wordEnd))
        if (end >= wordEnd && !pending) continue
        if (matchStart > start) return matchStart
        if (!pending && wordEnd - start <= 128) return wordEnd
        return if (pending && text.length - start < 128) 0 else minOf(text.length, start + 128)
    }
    return minOf(text.length, end)
}

private fun appendSpeech(phrases: MutableList<String>, source: String) {
    val rawBuilder = StringBuilder()
    var cursor = 0
    for (match in HIDDEN_SPEECH.findAll(source)) {
        val start = match.range.first
        rawBuilder.append(source, cursor, start)
        val isLinkTarget = start > 0 && source[start - 1] == ']' && match.value.startsWith("(")
        if (!isLinkTarget) rawBuilder.append(' ')
        cursor = match.range.last + 1
    }
    rawBuilder.append(source, cursor, source.length)
    val raw = rawBuilder.toString()
    val paragraph = raw.endsWith("\n\n")
    var from = raw.length - raw.trimStart().length
    val last = raw.trimEnd().length

    fun push(end: Int, suffix: String = "") {
        val phrase = raw.substring(from, end)
        if (!ALNUM_CHAR.containsMatchIn(phrase)) return
        phrases += phrase + suffix
    }

    val limit = if (paragraph) 126 else 128
    while (last - from > limit) {
        val searchEnd = minOf(raw.length - 1, from + 128)
        val space = raw.lastIndexOf(' ', searchEnd)
        var end = if (space >= from + 64) space else minOf(last, from + 128)
        if (end > from && raw[end - 1].isHighSurrogate()) end--
        if (end <= from) end = minOf(last, from + 128)
        push(end)
        val ws = LEADING_SPACE.find(raw.substring(end))?.value?.length ?: 0
        from = end + ws
    }
    if (from < last) push(last, if (paragraph) "\n\n" else "")
}

fun splitSpeech(text: String, flush: Boolean = false, opening: Boolean = false): SpeechSplit {
    val phrases = mutableListOf<String>()
    var rest = text
    if (opening && !flush) {
        val end = openingEnd(rest)
        if (end <= 0) return SpeechSplit(phrases, rest)
        appendSpeech(phrases, rest.substring(0, end))
        rest = rest.substring(end)
    }
    while (rest.isNotEmpty()) {
        val visible = visibleSpeech(rest)
        val sentence = SENTENCE_END.find(visible)
        var end = sentence?.let { it.range.last + 1 } ?: 0
        val trimmedStart = visible.trimStart()
        if ((end == 0 || end > 80) && trimmedStart.length >= 64) {
            val start = visible.length - trimmedStart.length
            val searchLimit = minOf(visible.length - 1, start + 63)
            val soft = maxOf(
                visible.lastIndexOf('，', searchLimit),
                visible.lastIndexOf('、', searchLimit),
                visible.lastIndexOf(' ', searchLimit)
            )
            val candidate = if (soft >= start + 24) soft + 1 else minOf(visible.length, start + 64)
            end = softSpeechEnd(visible, start, candidate, flush)
        }
        val fence = rest.indexOf("```")
        if (fence >= 0 && (end == 0 || fence < end)) {
            val close = rest.indexOf("```", fence + 3)
            if (close < 0 && !flush) break
            if (end > 0 && close >= end) end = close + 3
        }
        if (end == 0 && flush) end = rest.length
        if (end == 0) break
        appendSpeech(phrases, rest.substring(0, end))
        rest = rest.substring(end)
    }
    return SpeechSplit(phrases, rest)
}

/** Extracts a concise opening phrase from a background PipiClaw update for voice readout. */
fun updateSpeech(text: String): String? {
    val lines = text.split('\n')
    val heading = lines.firstOrNull()?.trim().orEmpty()
    val candidate = if (BOLD_HEADING.matches(heading)) {
        val paragraph = lines.drop(1).firstOrNull { it.isNotBlank() && !BULLET_LINE.containsMatchIn(it) }
        paragraph ?: heading.substring(2, heading.length - 2)
            .replace(INLINE_CODE, "")
            .replace(LEADING_NON_ALNUM, "")
    } else text
    return splitSpeech(candidate, flush = true).phrases.firstOrNull()
}
