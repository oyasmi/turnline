package dev.turnline.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MatchaSpeechTest {
    @Test
    fun preservesKnownEnglishAndSpellsUnknownWordsInMixedText() {
        val words = setOf("matcha", "codex")
        assertEquals("matcha 和 codex 读  q z x 。", matchaText("Matcha 和 Codex 读 QZX。", words))
        assertEquals("去 3 楼。", matchaText("去 3 楼。", words))
    }

    @Test
    fun convertsEnglishNumbersBeforeLookingUpTheirPronunciation() {
        val words = setOf("minus", "one", "hundred", "twenty", "three", "point", "zero", "four")
        assertEquals("minus one hundred twenty three point zero four.", matchaText("-123.04.", words))
        assertEquals("zero zero four", matchaText("004", words))
    }

    @Test
    fun normalizesBilingualUnitsTimeAndIdentifiers() {
        assertEquals("剩余 16吉字节，进度 百分之85。", speakableText("剩余 16GB，进度 85%。"))
        assertEquals("Check C sharp in home directory dot config.", speakableText("Check C# in ~/.config."))
        val words = setOf("v", "two", "point", "one", "gpt", "four", "o")
        val expanded = matchaText("升级到 v2.1，时间 14:30。", words)
        assertTrue(expanded.contains("v two point one"))
        assertTrue(expanded.contains("14点30分"))
    }
}
