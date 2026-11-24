package dev.turnline.android

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private data class ReplyBlock(val text: String, val code: Boolean)
private val fence = Regex("^ {0,3}(```+|~~~+)(.*)$")
private val inline = Regex("`([^`\\n]+)`|\\*\\*([^*\\n]+)\\*\\*|\\[([^]\\n]+)]\\((https?://[^)\\s]+)\\)")
private val heading = Regex("^(#{1,6})\\s+(.+)")

private fun blocks(text: String): List<ReplyBlock> = buildList {
    val buffer = StringBuilder()
    var delimiter: String? = null
    fun flush(code: Boolean) {
        if (buffer.isNotBlank()) add(ReplyBlock(buffer.toString().trimEnd(), code))
        buffer.clear()
    }
    for (line in text.lineSequence()) {
        val match = fence.matchEntire(line)
        val marker = match?.groupValues?.get(1)
        if (marker != null && delimiter == null) {
            flush(false)
            delimiter = marker
        } else if (marker != null && delimiter?.let { marker.startsWith(it) } == true &&
            match.groupValues[2].isBlank()
        ) {
            flush(true)
            delimiter = null
        } else {
            buffer.appendLine(line)
        }
    }
    flush(delimiter != null)
}

@Composable
fun ReplyText(text: String) {
    val colors = MaterialTheme.colorScheme
    val blocks = remember(text) { blocks(text) }
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        for (block in blocks) {
            if (block.code) {
                Text(block.text,
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surfaceVariant)
                        .horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 10.dp),
                    fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 21.sp, softWrap = false)
            } else {
                val formatted = remember(block, colors.primary, colors.surfaceVariant) {
                    buildAnnotatedString {
                        block.text.lineSequence().forEachIndexed { index, original ->
                            if (index > 0) append('\n')
                            val headline = heading.matchEntire(original)
                            val line = headline?.groupValues?.get(2)
                                ?: original.replaceFirst(Regex("^\\s*[-*+] +"), "• ")
                            if (headline != null) pushStyle(SpanStyle(fontWeight = FontWeight.Bold, fontSize = 18.sp))
                            var start = 0
                            for (found in inline.findAll(line)) {
                                append(line.substring(start, found.range.first))
                                val (_, code, strong, label, url) = found.groupValues
                                when {
                                    code.isNotEmpty() -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace,
                                        fontSize = 14.sp, background = colors.surfaceVariant)) { append(code) }
                                    strong.isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(strong) }
                                    else -> withStyle(SpanStyle(color = colors.primary)) { append(label); append(" ($url)") }
                                }
                                start = found.range.last + 1
                            }
                            append(line.substring(start))
                            if (headline != null) pop()
                        }
                    }
                }
                Text(formatted, fontSize = 16.sp, lineHeight = 26.sp)
            }
        }
    }
}
