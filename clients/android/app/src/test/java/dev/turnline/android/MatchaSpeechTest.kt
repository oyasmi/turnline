package dev.turnline.android

import org.junit.Assert.assertEquals
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
}
