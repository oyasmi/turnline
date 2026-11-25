package dev.turnline.android

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

internal data class ReplyBlock(
    val text: String,
    val code: Boolean,
    val language: String = "",
    val quote: Boolean = false
)

private val fence = Regex("^ {0,3}(```+|~~~+)([^\\s`~]*)(.*)$")
private val quoteLine = Regex("^ {0,3}>\\s?(.*)$")
private val inline = Regex(
    "`([^`\\n]+)`|\\*\\*([^*\\n]+)\\*\\*|\\*([^*\\n]+)\\*|\\[([^]\\n]+)]\\((https?://[^)\\s]+)\\)"
)
private val heading = Regex("^(#{1,6})\\s+(.+)")

internal fun replyBlocks(text: String): List<ReplyBlock> = buildList {
    val buffer = StringBuilder()
    var delimiter: String? = null
    var language = ""
    var inQuote = false

    fun flush(code: Boolean, quote: Boolean = false) {
        if (buffer.isNotBlank()) {
            add(ReplyBlock(buffer.toString().trimEnd(), code = code, language = if (code) language else "", quote = quote))
        }
        buffer.clear()
        if (code) language = ""
    }

    for (line in text.lineSequence()) {
        val match = fence.matchEntire(line)
        val marker = match?.groupValues?.get(1)
        if (marker != null && delimiter == null) {
            flush(code = false, quote = inQuote)
            inQuote = false
            delimiter = marker
            language = match.groupValues[2].trim()
        } else if (marker != null && delimiter?.let { marker.startsWith(it) } == true &&
            match.groupValues[2].isBlank() && match.groupValues[3].isBlank()
        ) {
            flush(code = true)
            delimiter = null
        } else if (delimiter != null) {
            buffer.appendLine(line)
        } else {
            val quoted = quoteLine.matchEntire(line)
            if (quoted != null) {
                if (!inQuote) {
                    flush(code = false, quote = false)
                    inQuote = true
                }
                buffer.appendLine(quoted.groupValues[1])
            } else {
                if (inQuote) {
                    flush(code = false, quote = true)
                    inQuote = false
                }
                buffer.appendLine(line)
            }
        }
    }
    flush(code = delimiter != null, quote = inQuote)
}

@Composable
fun ReplyText(text: String) {
    val colors = MaterialTheme.colorScheme
    val blocks = remember(text) { replyBlocks(text) }
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        for (block in blocks) {
            when {
                block.code -> CodeBlock(block.text, block.language)
                block.quote -> QuoteBlock(block.text)
                else -> {
                    val formatted = remember(block, colors.primary, colors.surfaceVariant) {
                        formatRichText(block.text, colors.primary, colors.surfaceVariant)
                    }
                    Text(formatted, fontSize = 16.sp, lineHeight = 26.sp)
                }
            }
        }
    }
}

@Composable
private fun CodeBlock(code: String, language: String) {
    val colors = MaterialTheme.colorScheme
    val context = LocalContext.current
    var copied by remember(code) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_500)
            copied = false
        }
    }
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surfaceVariant)
    ) {
        Row(
            Modifier.fillMaxWidth().background(colors.surfaceContainerHigh)
                .padding(start = 12.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                language.ifBlank { "代码" },
                Modifier.weight(1f),
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = colors.onSurfaceVariant
            )
            Row(
                Modifier.clip(RoundedCornerShape(8.dp))
                    .clickable {
                        context.getSystemService(ClipboardManager::class.java)
                            .setPrimaryClip(ClipData.newPlainText("Turnline Code", code))
                        copied = true
                    }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                LineIcon(
                    if (copied) Glyph.CHECK else Glyph.COPY,
                    if (copied) colors.primary else colors.onSurfaceVariant,
                    Modifier.size(14.dp)
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    if (copied) "已复制" else "复制代码",
                    fontSize = 12.sp,
                    color = if (copied) colors.primary else colors.onSurfaceVariant
                )
            }
        }
        Text(
            code,
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 10.dp),
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            lineHeight = 21.sp,
            softWrap = false
        )
    }
}

@Composable
private fun QuoteBlock(text: String) {
    val colors = MaterialTheme.colorScheme
    val formatted = remember(text, colors.primary, colors.surfaceVariant) {
        formatRichText(text, colors.primary, colors.surfaceVariant)
    }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
            .background(colors.surfaceContainer.copy(alpha = 0.65f))
            .padding(start = 10.dp, end = 12.dp, top = 8.dp, bottom = 8.dp)
    ) {
        Box(
            Modifier.width(3.dp).height(20.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(colors.primary.copy(alpha = 0.6f))
        )
        Spacer(Modifier.width(10.dp))
        Text(formatted, fontSize = 15.sp, lineHeight = 24.sp, color = colors.onSurfaceVariant)
    }
}

private fun formatRichText(
    source: String,
    linkColor: androidx.compose.ui.graphics.Color,
    codeBg: androidx.compose.ui.graphics.Color
): AnnotatedString = buildAnnotatedString {
    source.lineSequence().forEachIndexed { index, original ->
        if (index > 0) append('\n')
        val headline = heading.matchEntire(original)
        val line = headline?.groupValues?.get(2)
            ?: original.replaceFirst(Regex("^\\s*[-*+] +"), "• ")
        if (headline != null) pushStyle(SpanStyle(fontWeight = FontWeight.Bold, fontSize = 18.sp))
        var start = 0
        for (found in inline.findAll(line)) {
            append(line.substring(start, found.range.first))
            val code = found.groupValues[1]
            val strong = found.groupValues[2]
            val emphasis = found.groupValues[3]
            val label = found.groupValues[4]
            val url = found.groupValues[5]
            when {
                code.isNotEmpty() -> withStyle(
                    SpanStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp, background = codeBg)
                ) { append(code) }
                strong.isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(strong) }
                emphasis.isNotEmpty() -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(emphasis) }
                else -> withStyle(SpanStyle(color = linkColor)) { append(label); append(" ($url)") }
            }
            start = found.range.last + 1
        }
        append(line.substring(start))
        if (headline != null) pop()
    }
}
