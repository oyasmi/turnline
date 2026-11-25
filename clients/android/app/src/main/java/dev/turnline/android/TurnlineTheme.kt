package dev.turnline.android

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp

val Panel = Color(0xFF173B31)
val Mint = Color(0xFFBDF1D4)
val PanelText = Color(0xFFF2FFF6)
val PanelMuted = Color(0xFFAFCDC0)

private val Light = lightColorScheme(
    primary = Color(0xFF236044), onPrimary = Color.White,
    primaryContainer = Color(0xFFDDF1E4), onPrimaryContainer = Color(0xFF173D2E),
    background = Color(0xFFF6F5EF), onBackground = Color(0xFF202923),
    surface = Color(0xFFFFFEF9), onSurface = Color(0xFF202923),
    surfaceVariant = Color(0xFFEBEEE5), onSurfaceVariant = Color(0xFF526057),
    surfaceContainer = Color(0xFFEEEEE5), surfaceContainerHigh = Color(0xFFE6E9DF),
    outline = Color(0xFF737E74), outlineVariant = Color(0xFFD8DED3),
    error = Color(0xFFA1372C), errorContainer = Color(0xFFFBE8E2), onErrorContainer = Color(0xFF711D16)
)

private val Dark = darkColorScheme(
    primary = Mint, onPrimary = Color(0xFF14382A),
    primaryContainer = Color(0xFF233F33), onPrimaryContainer = Color(0xFFE3F6E9),
    background = Color(0xFF141B17), onBackground = Color(0xFFEAF1E9),
    surface = Color(0xFF1B241E), onSurface = Color(0xFFEAF1E9),
    surfaceVariant = Color(0xFF27332B), onSurfaceVariant = Color(0xFFBAC9BF),
    surfaceContainer = Color(0xFF202B24), surfaceContainerHigh = Color(0xFF2B392F),
    outline = Color(0xFF9BAC9F), outlineVariant = Color(0xFF35463A),
    error = Color(0xFFFFB4A8), errorContainer = Color(0xFF512A24), onErrorContainer = Color(0xFFFFDAD3)
)

@Composable
fun TurnlineTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}

enum class Glyph {
    WAVE, MIC, SEND, STOP, PAUSE, END, HISTORY, SETTINGS, ADD, BACK, DOWN, SPEAKER, LINK, COPY,
    CHECK, CLOSE, EYE, EYE_OFF, TRASH
}

@Composable
fun LineIcon(glyph: Glyph, tint: Color, modifier: Modifier = Modifier.size(22.dp)) {
    Canvas(modifier) {
        val scale = size.minDimension / 24f
        fun p(x: Float, y: Float) = Offset(x * scale, y * scale)
        val stroke = Stroke(1.7f * scale, cap = StrokeCap.Round, join = StrokeJoin.Round)

        fun line(x1: Float, y1: Float, x2: Float, y2: Float) {
            drawLine(tint, p(x1, y1), p(x2, y2), stroke.width, StrokeCap.Round)
        }

        fun trace(vararg points: Pair<Int, Int>, close: Boolean = false, fill: Boolean = false) {
            val path = Path().apply {
                moveTo(points.first().first * scale, points.first().second * scale)
                for ((x, y) in points.drop(1)) lineTo(x * scale, y * scale)
                if (close) close()
            }
            if (fill) drawPath(path, tint) else drawPath(path, tint, style = stroke)
        }

        fun box(x: Float, y: Float, w: Float, h: Float, r: Float, fill: Boolean = false) {
            if (fill) drawRoundRect(tint, p(x, y), Size(w * scale, h * scale), CornerRadius(r * scale))
            else drawRoundRect(tint, p(x, y), Size(w * scale, h * scale), CornerRadius(r * scale), style = stroke)
        }

        fun arc(x: Float, y: Float, w: Float, h: Float, start: Float, sweep: Float) {
            drawArc(tint, start, sweep, false, p(x, y), Size(w * scale, h * scale), style = stroke)
        }

        when (glyph) {
            Glyph.WAVE -> trace(2 to 12, 5 to 12, 8 to 6, 11 to 18, 14 to 8, 17 to 14, 19 to 12, 22 to 12)
            Glyph.MIC -> {
                box(9f, 2.5f, 6f, 12f, 3f)
                arc(5.5f, 4.5f, 13f, 14f, 0f, 180f)
                line(12f, 19f, 12f, 22f)
                line(9f, 22f, 15f, 22f)
            }
            Glyph.SEND -> {
                trace(4 to 11, 12 to 4, 20 to 11)
                line(12f, 4f, 12f, 20f)
            }
            Glyph.STOP -> box(6f, 6f, 12f, 12f, 2.5f, true)
            Glyph.PAUSE -> {
                box(7f, 5f, 3f, 14f, 1f, true)
                box(14f, 5f, 3f, 14f, 1f, true)
            }
            Glyph.END -> {
                val path = Path().apply {
                    moveTo(3f * scale, 16f * scale)
                    cubicTo(1f * scale, 9f * scale, 23f * scale, 9f * scale, 21f * scale, 16f * scale)
                    lineTo(17f * scale, 16f * scale)
                    lineTo(17f * scale, 13f * scale)
                    quadraticTo(12f * scale, 11f * scale, 7f * scale, 13f * scale)
                    lineTo(7f * scale, 16f * scale)
                    close()
                }
                drawPath(path, tint, style = stroke)
            }
            Glyph.HISTORY -> {
                arc(3.5f, 3.5f, 17f, 17f, 196f, 318f)
                trace(2 to 5, 3 to 10, 8 to 9)
                trace(12 to 7, 12 to 12, 15 to 14)
            }
            Glyph.SETTINGS -> {
                line(4f, 7f, 10f, 7f)
                line(14f, 7f, 20f, 7f)
                drawCircle(tint, 2f * scale, p(12f, 7f), style = stroke)
                line(4f, 17f, 6f, 17f)
                line(10f, 17f, 20f, 17f)
                drawCircle(tint, 2f * scale, p(8f, 17f), style = stroke)
            }
            Glyph.ADD -> {
                line(5f, 12f, 19f, 12f)
                line(12f, 5f, 12f, 19f)
            }
            Glyph.BACK -> {
                trace(11 to 5, 4 to 12, 11 to 19)
                line(4f, 12f, 20f, 12f)
            }
            Glyph.DOWN -> {
                trace(5 to 13, 12 to 20, 19 to 13)
                line(12f, 4f, 12f, 20f)
            }
            Glyph.SPEAKER -> {
                trace(3 to 9, 7 to 9, 11 to 5, 11 to 19, 7 to 15, 3 to 15, close = true)
                arc(11f, 7.5f, 7f, 9f, -58f, 116f)
                arc(11f, 4f, 12f, 16f, -58f, 116f)
            }
            Glyph.LINK -> {
                trace(11 to 7, 14 to 4, 18 to 4, 20 to 6, 20 to 10, 17 to 13)
                trace(13 to 17, 10 to 20, 6 to 20, 4 to 18, 4 to 14, 7 to 11)
                line(8f, 16f, 16f, 8f)
            }
            Glyph.COPY -> {
                box(8f, 7f, 12f, 14f, 2f)
                trace(5 to 16, 4 to 16, 4 to 3, 15 to 3)
            }
            Glyph.CHECK -> trace(4 to 12, 10 to 18, 20 to 7)
            Glyph.CLOSE -> {
                line(6f, 6f, 18f, 18f)
                line(6f, 18f, 18f, 6f)
            }
            Glyph.EYE, Glyph.EYE_OFF -> {
                val path = Path().apply {
                    moveTo(2f * scale, 12f * scale)
                    quadraticTo(12f * scale, -2f * scale, 22f * scale, 12f * scale)
                    quadraticTo(12f * scale, 26f * scale, 2f * scale, 12f * scale)
                }
                drawPath(path, tint, style = stroke)
                drawCircle(tint, 2.7f * scale, p(12f, 12f), style = stroke)
                if (glyph == Glyph.EYE_OFF) line(4f, 4f, 20f, 20f)
            }
            Glyph.TRASH -> {
                trace(5 to 8, 6 to 20, 18 to 20, 19 to 8)
                trace(9 to 6, 9 to 4, 15 to 4, 15 to 6)
                line(3.5f, 7f, 20.5f, 7f)
                line(10f, 11f, 10f, 17f)
                line(14f, 11f, 14f, 17f)
            }
        }
    }
}
