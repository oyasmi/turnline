package dev.turnline.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechChunkerTest {
    @Test
    fun splitsOpeningPhraseEarlyAndKeepsRemainder() {
        val first = splitSpeech("好的，已经检查完了，接下来我帮你重启服务", flush = false, opening = true)
        assertEquals(listOf("好的，已经检查完了，"), first.phrases)
        assertEquals("接下来我帮你重启服务", first.rest)

        val flushed = splitSpeech(first.rest, flush = true)
        assertEquals(listOf("接下来我帮你重启服务"), flushed.phrases)
        assertEquals("", flushed.rest)
    }

    @Test
    fun hidesCodeBlocksAndUrlsWhileSplitting() {
        val split = splitSpeech("结果如下。\n```bash\necho hi\n```\n详情见 https://example.com/a 。", flush = true)
        assertTrue(split.phrases.none { it.contains("echo hi") || it.contains("https://") })
        assertEquals(2, split.phrases.size)
        assertEquals("结果如下。", split.phrases[0])
        assertTrue(split.phrases[1].startsWith("详情见"))
    }

    @Test
    fun extractsConciseBackgroundUpdateSummary() {
        val summary = updateSpeech("**任务完成**\n已构建新版本，没有发现错误。\n- 耗时 12 秒")
        assertEquals("已构建新版本，没有发现错误。", summary)
    }

    @Test
    fun detectsBackchannelsAndBuildsVoiceInstructions() {
        assertTrue(isBackchannel("嗯嗯"))
        assertTrue(isBackchannel("  哦， "))
        assertFalse(isBackchannel("嗯，帮我查一下"))
        val instructions = buildVoiceInstructions("保持简洁", "上一轮语音回复在播到「测试」附近时被打断。")
        assertTrue(instructions.contains("实时通话"))
        assertTrue(instructions.contains("保持简洁"))
        assertTrue(instructions.contains("播到「测试」附近时被打断"))
    }
}
