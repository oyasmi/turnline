package dev.turnline.android

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.SystemClock
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role as SemanticRole
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.withResumed
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.sin

@Composable
fun TurnlineApp(model: TurnlineViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val haptic = LocalHapticFeedback.current
    var showSettings by rememberSaveable { mutableStateOf(false) }
    var showHistory by rememberSaveable { mutableStateOf(false) }
    var draftThread by rememberSaveable { mutableStateOf("") }
    var draftText by rememberSaveable { mutableStateOf("") }
    val input = if (draftThread == state.conversation.id) draftText else ""
    var permissionHelp by remember { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val microphone = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (allowed) scope.launch {
            lifecycle.withResumed {
                if (!showSettings && !showHistory) model.startCall()
            }
        } else permissionHelp = true
    }

    LaunchedEffect(state.settingsSaved) {
        if (state.settingsSaved) {
            showSettings = false
            model.clearSettingsResult()
        }
    }

    fun changeInput(value: String) {
        draftThread = state.conversation.id
        draftText = value
    }

    fun startCall() {
        focus.clearFocus()
        keyboard?.hide()
        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            model.startCall()
        } else microphone.launch(Manifest.permission.RECORD_AUDIO)
    }

    fun settings() {
        focus.clearFocus()
        keyboard?.hide()
        model.stopAudio()
        model.clearSettingsResult()
        showSettings = true
    }

    BackHandler(enabled = !showSettings && state.inCall) { model.endCall() }
    Surface(color = MaterialTheme.colorScheme.background) {
        Box(Modifier.fillMaxSize().windowInsetsPadding(
            WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Top)
        )) {
            if (showSettings && (!state.loading || state.settingsSaving)) {
                SettingsScreen(
                    state.settings, model::testConnection, model::saveSettings, state.settingsSaving || state.settingsSaved,
                    state.settingsSaveError, model::clearSettingsResult
                ) { showSettings = false }
            } else {
                Column(Modifier.widthIn(max = 780.dp).fillMaxSize().align(Alignment.TopCenter)
                    .navigationBarsPadding().imePadding()) {
                    Header(state, ::settings) {
                        focus.clearFocus()
                        keyboard?.hide()
                        model.stopAudio()
                        showHistory = true
                    }

                    if (state.loading) {
                        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(Modifier.size(26.dp), strokeWidth = 2.dp)
                        }
                    } else {
                        if (state.inCall) CallPanel(
                            stage = state.call,
                            callStartedAt = state.callStartedAt,
                            phase = state.draft?.phase,
                            busy = state.busy,
                            partial = state.partialSpeech,
                            level = state.level,
                            action = {
                                haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                model.callAction()
                            },
                            end = {
                                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                model.endCall()
                            }
                        )
                        state.notice?.let { notice ->
                            Notice(notice, state.recoverText?.let { failed ->
                                {
                                    model.endCall()
                                    changeInput(failed)
                                    model.clearNotice()
                                }
                            }, model::clearNotice)
                        }

                        key(state.conversation.id) {
                            if (state.messages.isEmpty()) {
                                Welcome(
                                    connected = state.settings != null,
                                    inCall = state.inCall,
                                    primary = if (state.settings == null) ::settings else ::startCall,
                                    onQuickPrompt = { prompt ->
                                        if (!state.busy) model.send(prompt)
                                    },
                                    modifier = Modifier.weight(1f)
                                )
                            } else {
                                Transcript(
                                    messages = state.messages,
                                    draft = state.draft,
                                    inCall = state.inCall,
                                    busy = state.busy,
                                    reading = state.reading,
                                    onRead = model::readMessage,
                                    onRetry = { model.retryLastTurn() },
                                    modifier = Modifier.weight(1f)
                                )
                            }
                        }
                        if (state.settings != null && !state.inCall) {
                            Composer(
                                input, { if (it.length <= MAX_INPUT) changeInput(it) }, state.busy,
                                onVoice = ::startCall, onStop = model::stopResponse,
                                onSend = {
                                    if (model.send(input)) {
                                        changeInput("")
                                        focus.clearFocus()
                                        keyboard?.hide()
                                    }
                                }
                            )
                        }
                    }
                }
            }
        }
    }

    if (showHistory && !showSettings) {
        HistorySheet(
            state = state,
            choose = {
                showHistory = false
                model.selectConversation(it ?: Conversation())
            },
            delete = model::deleteConversation
        ) { showHistory = false }
    }

    if (permissionHelp) {
        AlertDialog(
            onDismissRequest = { permissionHelp = false },
            title = { Text("通话需要麦克风") },
            text = { Text("允许 Turnline 使用麦克风后即可开始通话。也可以直接发送文字。") },
            confirmButton = {
                TextButton(onClick = {
                    permissionHelp = false
                    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", context.packageName, null)))
                }) { Text("应用权限") }
            },
            dismissButton = { TextButton(onClick = { permissionHelp = false }) { Text("返回对话") } }
        )
    }
}

@Composable
private fun Header(state: TurnlineState, settings: () -> Unit, history: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        BrandMark(40)
        Column(Modifier.padding(start = 12.dp).weight(1f)) {
            Text("Turnline", fontSize = 23.sp, fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.Serif, letterSpacing = (-0.7).sp, lineHeight = 26.sp)
            val settings = state.settings
            if (settings != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(6.dp).background(
                        if (state.reachable) colors.primary else colors.outline, CircleShape))
                    val label = state.conversation.title.ifEmpty {
                        if (settings.provider == Provider.PIPICLAW) "PipiClaw" else settings.model
                    }
                    Text(label, Modifier.padding(start = 6.dp), fontSize = 12.sp,
                        color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        if (state.settings != null) SmallButton(Glyph.HISTORY, "对话历史", history, enabled = !state.loading)
        SmallButton(Glyph.SETTINGS, "连接与语音设置", settings, enabled = !state.loading)
    }
}

@Composable
fun BrandMark(size: Int, modifier: Modifier = Modifier) {
    Box(modifier.size(size.dp).clip(RoundedCornerShape((size * 0.29f).dp))
        .background(Brush.linearGradient(listOf(Color(0xFF254B3D), Color(0xFF14342B)))),
        contentAlignment = Alignment.Center) {
        LineIcon(Glyph.WAVE, Mint, Modifier.size((size * 0.66f).dp))
    }
}

@Composable
fun SmallButton(
    glyph: Glyph,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant
) {
    IconButton(onClick, modifier.size(48.dp).semantics { contentDescription = label }, enabled = enabled) {
        LineIcon(glyph, if (enabled) tint else tint.copy(alpha = 0.45f), Modifier.size(20.dp))
    }
}

private val QUICK_PROMPTS = listOf(
    "看看最近有什么待办或进展",
    "帮我总结一下刚才的思路",
    "用三句话解释一个概念"
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Welcome(
    connected: Boolean,
    inCall: Boolean,
    primary: () -> Unit,
    onQuickPrompt: (String) -> Unit,
    modifier: Modifier
) {
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val availableHeight = maxHeight
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                .heightIn(min = availableHeight).padding(horizontal = 24.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            if (!inCall) {
                VoiceArtwork(Modifier.size(if (availableHeight > 440.dp) 212.dp else 154.dp))
                Spacer(Modifier.height(22.dp))
                Text(
                    if (connected) "想聊点什么？" else "开口就聊",
                    Modifier.semantics { heading() },
                    fontSize = 35.sp, lineHeight = 41.sp, fontWeight = FontWeight.SemiBold,
                    letterSpacing = (-1.5).sp, textAlign = TextAlign.Center
                )
                Text(
                    if (connected) "说一句，或直接发条消息。" else "直连 PipiClaw 或兼容 Responses API 的服务，随时在通话和文字之间切换。",
                    Modifier.widthIn(max = 300.dp).padding(top = 11.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 15.sp, lineHeight = 24.sp, textAlign = TextAlign.Center
                )
                Spacer(Modifier.height(24.dp))
                Button(onClick = primary, contentPadding = PaddingValues(horizontal = 24.dp, vertical = 14.dp)) {
                    LineIcon(if (connected) Glyph.MIC else Glyph.LINK, MaterialTheme.colorScheme.onPrimary,
                        Modifier.size(19.dp))
                    Spacer(Modifier.width(9.dp))
                    Text(if (connected) "开始通话" else "连接服务", fontWeight = FontWeight.SemiBold)
                }
                if (connected) {
                    Spacer(Modifier.height(20.dp))
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        QUICK_PROMPTS.forEach { prompt ->
                            AssistChip(
                                onClick = { onQuickPrompt(prompt) },
                                label = { Text(prompt, fontSize = 13.sp) }
                            )
                        }
                    }
                }
            } else {
                VoiceArtwork(Modifier.size(if (availableHeight > 360.dp) 196.dp else 138.dp))
            }
        }
    }
}

@Composable
private fun VoiceArtwork(modifier: Modifier) {
    val scheme = MaterialTheme.colorScheme
    Box(modifier, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val r = size.minDimension / 2
            drawCircle(Brush.radialGradient(listOf(scheme.primaryContainer, scheme.background), center, r), r)
            for (fraction in listOf(0.91f, 0.76f, 0.59f)) {
                drawCircle(scheme.primary.copy(alpha = 0.17f), r * fraction, style = Stroke(1.dp.toPx()))
            }
            drawCircle(scheme.primary, 3.3.dp.toPx(), Offset(center.x + r * 0.69f, center.y - r * 0.31f))
            drawCircle(scheme.primary.copy(alpha = 0.57f), 2.5.dp.toPx(),
                Offset(center.x - r * 0.62f, center.y + r * 0.66f))
        }
        Box(Modifier.fillMaxSize(0.48f).clip(CircleShape).background(
            Brush.linearGradient(listOf(Color(0xFF315B49), Color(0xFF15392E)))
        ).border(1.dp, Mint.copy(alpha = 0.20f), CircleShape), contentAlignment = Alignment.Center) {
            LineIcon(Glyph.WAVE, Mint, Modifier.fillMaxSize(0.60f))
        }
    }
}

private data class CallLabel(val title: String, val glyph: Glyph, val action: String)

@Composable
private fun CallPanel(
    stage: CallStage,
    callStartedAt: Long?,
    phase: String?,
    busy: Boolean,
    partial: String,
    level: Float,
    action: () -> Unit,
    end: () -> Unit
) {
    val label = when (stage) {
        CallStage.LISTENING -> CallLabel("正在听", Glyph.PAUSE, "暂停")
        CallStage.TRANSCRIBING -> CallLabel("正在转写", Glyph.PAUSE, "暂停")
        CallStage.WAITING -> CallLabel(phase ?: "准备接听", Glyph.STOP, if (busy) "打断" else "暂停")
        CallStage.SPEAKING -> CallLabel("正在播报", Glyph.MIC, "打断")
        CallStage.PAUSED -> CallLabel("听筒已暂停", Glyph.MIC, "继续听")
        CallStage.OFF -> return
    }
    var elapsedSeconds by remember(callStartedAt) { mutableLongStateOf(0L) }
    LaunchedEffect(callStartedAt) {
        if (callStartedAt == null) return@LaunchedEffect
        while (true) {
            elapsedSeconds = ((SystemClock.elapsedRealtime() - callStartedAt) / 1_000L).coerceAtLeast(0L)
            delay(1_000L)
        }
    }
    val durationText = remember(elapsedSeconds) {
        String.format(Locale.US, "%02d:%02d", elapsedSeconds / 60, elapsedSeconds % 60)
    }
    val subtitle = partial.ifEmpty {
        when (stage) {
            CallStage.LISTENING -> "说完稍停一下，即可发送"
            CallStage.PAUSED -> "点按麦克风继续说"
            CallStage.SPEAKING -> "可随时打断，接着说"
            else -> ""
        }
    }
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
            .clip(RoundedCornerShape(28.dp))
            .background(Brush.linearGradient(listOf(Color(0xFF275144), Panel, Color(0xFF112F28))))
            .padding(horizontal = 19.dp, vertical = 15.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            VoiceMeter(stage, level)
            Column(Modifier.weight(1f).padding(start = 14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(label.title, Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite },
                        color = PanelText, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, lineHeight = 26.sp)
                    if (callStartedAt != null) {
                        Text(
                            durationText,
                            color = PanelMuted,
                            fontSize = 13.sp,
                            fontFamily = FontFamily.Monospace
                        )
                    }
                }
                if (subtitle.isNotEmpty()) {
                    Text(subtitle, Modifier.padding(top = 3.dp), color = PanelMuted, fontSize = 13.sp,
                        maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = 18.sp)
                }
            }
        }
        Row(Modifier.padding(top = 13.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CallButton(label.glyph, label.action, action, Mint, Panel, Modifier.weight(1f))
            CallButton(Glyph.END, "挂断", end, Color(0xFF533B37), Color(0xFFFFDDD5), Modifier.weight(1f))
        }
    }
}

@Composable
private fun CallButton(glyph: Glyph, label: String, action: () -> Unit, bg: Color, fg: Color, modifier: Modifier) {
    Button(
        action, modifier.heightIn(min = 48.dp),
        colors = ButtonDefaults.buttonColors(containerColor = bg, contentColor = fg),
        contentPadding = PaddingValues(horizontal = 8.dp)
    ) {
        LineIcon(glyph, fg, Modifier.size(18.dp))
        Spacer(Modifier.width(7.dp))
        Text(label, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun VoiceMeter(stage: CallStage, level: Float) {
    val animatedLevel = animateFloatAsState(level, tween(110), label = "microphone level")
    val active = stage == CallStage.SPEAKING || stage == CallStage.WAITING
    val animation = if (active) {
        val transition = rememberInfiniteTransition(label = "call waveform")
        transition.animateFloat(0f, 6.28f, infiniteRepeatable(tween(1200), RepeatMode.Restart), label = "wave")
    } else null
    Canvas(Modifier.size(53.dp).background(Mint.copy(alpha = 0.12f), CircleShape).padding(10.dp)) {
        val phase = animation?.value ?: 0f
        val strength = when {
            active -> 0.50f
            stage == CallStage.LISTENING -> 0.14f + animatedLevel.value * 0.78f
            else -> 0.12f
        }
        for ((i, scale) in meterHeights.withIndex()) {
            val x = size.width * (i + 1) / (meterHeights.size + 1)
            val oscillation = if (active) 0.53f + abs(sin(phase + i * 0.8f)) * 0.47f else 1f
            val half = size.height * (0.055f + scale * strength * oscillation * 0.39f)
            drawLine(Mint, Offset(x, center.y - half), Offset(x, center.y + half), 2.6.dp.toPx(), StrokeCap.Round)
        }
    }
}

private val meterHeights = floatArrayOf(0.30f, 0.54f, 0.92f, 0.61f, 0.36f)

@Composable
private fun Transcript(
    messages: List<Message>,
    draft: ResponseDraft?,
    inCall: Boolean,
    busy: Boolean,
    reading: String?,
    onRead: (Message) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier
) {
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val following by remember { derivedStateOf { list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset < 64 } }
    var hasUnread by remember { mutableStateOf(false) }
    val latest = messages.lastOrNull()
    val reversed = remember(messages) { messages.asReversed() }
    val lastAssistantId = remember(messages) { messages.lastOrNull { it.role == Role.ASSISTANT }?.id }
    val timeFormatter = remember { SimpleDateFormat("HH:mm", Locale.getDefault()) }

    LaunchedEffect(following) {
        if (following) hasUnread = false
    }
    LaunchedEffect(latest?.id, draft?.text?.length) {
        if (latest?.role == Role.USER || following) {
            list.scrollToItem(0)
            hasUnread = false
        } else if (latest != null || !draft?.text.isNullOrBlank()) {
            hasUnread = true
        }
    }

    Box(modifier.fillMaxWidth()) {
        LazyColumn(
            Modifier.fillMaxSize(), state = list, reverseLayout = true,
            contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 12.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(17.dp, Alignment.Bottom)
        ) {
            if (draft != null) {
                item("draft") { DraftRow(draft) }
            }
            itemsIndexed(reversed, key = { _, msg -> msg.id }, contentType = { _, msg -> msg.role }) { index, message ->
                val older = reversed.getOrNull(index + 1)
                val showTime = message.timestamp > 0L && (older == null || older.timestamp <= 0L ||
                    message.timestamp / 60_000L != older.timestamp / 60_000L)
                val timeLabel = if (showTime) timeFormatter.format(Date(message.timestamp)) else null
                MessageRow(
                    message = message,
                    timeLabel = timeLabel,
                    inCall = inCall,
                    speaking = reading == message.id,
                    showRetry = !busy && message.id == lastAssistantId,
                    read = { onRead(message) },
                    retry = onRetry
                )
            }
        }
        if (!following) {
            Surface(
                Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp),
                shape = CircleShape, color = MaterialTheme.colorScheme.surface,
                shadowElevation = 4.dp
            ) {
                if (hasUnread) {
                    Row(
                        Modifier.clickable {
                            hasUnread = false
                            scope.launch { list.animateScrollToItem(0) }
                        }.padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        LineIcon(Glyph.DOWN, MaterialTheme.colorScheme.primary, Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("有新回复", fontSize = 13.sp, fontWeight = FontWeight.Medium,
                            color = MaterialTheme.colorScheme.primary)
                    }
                } else {
                    SmallButton(Glyph.DOWN, "回到最新消息", { scope.launch { list.animateScrollToItem(0) } })
                }
            }
        }
    }
}

@Composable
private fun DraftRow(draft: ResponseDraft) {
    val colors = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        BrandMark(27, Modifier.padding(top = 1.dp))
        Column(Modifier.weight(1f).padding(top = 2.dp)) {
            if (draft.text.isBlank()) {
                Row(Modifier.heightIn(min = 27.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(13.dp), color = colors.primary, strokeWidth = 1.6.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(draft.phase, color = colors.onSurfaceVariant, fontSize = 13.sp,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                }
            } else {
                Text(draft.text, fontSize = 16.sp, lineHeight = 26.sp)
            }
        }
    }
}

@Composable
private fun MessageRow(
    message: Message,
    timeLabel: String?,
    inCall: Boolean,
    speaking: Boolean,
    showRetry: Boolean,
    read: () -> Unit,
    retry: () -> Unit
) {
    val colors = MaterialTheme.colorScheme
    val context = LocalContext.current
    var copied by remember(message.id) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_500)
            copied = false
        }
    }
    Column(Modifier.fillMaxWidth()) {
        if (timeLabel != null) {
            Text(
                timeLabel,
                Modifier.fillMaxWidth().padding(bottom = 8.dp),
                textAlign = TextAlign.Center,
                fontSize = 11.sp,
                color = colors.onSurfaceVariant.copy(alpha = 0.8f)
            )
        }
        if (message.role == Role.USER) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
                Surface(
                    Modifier.widthIn(max = 520.dp).fillMaxWidth(fraction = if (message.text.length < 25) 0.98f else 0.92f),
                    shape = RoundedCornerShape(21.dp, 21.dp, 8.dp, 21.dp),
                    color = Color.Transparent
                ) {
                    Box(contentAlignment = Alignment.CenterEnd) {
                        Box(Modifier.clip(RoundedCornerShape(21.dp, 21.dp, 8.dp, 21.dp))
                            .background(colors.primaryContainer).padding(horizontal = 15.dp, vertical = 11.dp)) {
                            SelectionContainer { Text(message.text, color = colors.onPrimaryContainer, fontSize = 16.sp, lineHeight = 25.sp) }
                        }
                    }
                }
                DeliveryNote(message.delivery)
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                BrandMark(27, Modifier.padding(top = 1.dp))
                Column(Modifier.weight(1f).padding(top = 2.dp)) {
                    SelectionContainer { ReplyText(message.text) }
                    DeliveryNote(message.delivery)
                    Row(Modifier.height(48.dp), verticalAlignment = Alignment.CenterVertically) {
                        SmallButton(
                            if (copied) Glyph.CHECK else Glyph.COPY,
                            if (copied) "已复制" else "复制回复",
                            {
                                context.getSystemService(ClipboardManager::class.java)
                                    .setPrimaryClip(ClipData.newPlainText("Turnline", message.text))
                                copied = true
                            },
                            tint = if (copied) colors.primary else colors.onSurfaceVariant
                        )
                        if (!inCall) {
                            SmallButton(if (speaking) Glyph.STOP else Glyph.SPEAKER,
                                if (speaking) "停止播报" else "朗读回复", read)
                        }
                        if (showRetry) {
                            SmallButton(Glyph.RETRY, "重新回答", retry)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ColumnScope.DeliveryNote(delivery: Delivery) {
    val label = when (delivery) {
        Delivery.FAILED -> "本轮未完成"
        Delivery.STOPPED -> "已打断"
        else -> return
    }
    Text(label, Modifier.padding(top = 5.dp, start = 2.dp, end = 2.dp),
        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun Notice(message: String, restore: (() -> Unit)?, dismiss: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), RoundedCornerShape(18.dp),
        color = colors.errorContainer, contentColor = colors.onErrorContainer) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).padding(start = 15.dp, top = 9.dp, bottom = 9.dp)) {
                Text(message, Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    fontSize = 13.sp, lineHeight = 19.sp)
                if (restore != null) {
                    TextButton(onClick = restore, colors = ButtonDefaults.textButtonColors(contentColor = colors.onErrorContainer)) {
                        Text("放回输入框", fontWeight = FontWeight.SemiBold)
                    }
                }
            }
            SmallButton(Glyph.CLOSE, "关闭提示", dismiss, tint = colors.onErrorContainer)
        }
    }
}

@Composable
private fun Composer(
    input: String, change: (String) -> Unit, busy: Boolean, onVoice: () -> Unit, onStop: () -> Unit, onSend: () -> Unit
) {
    val colors = MaterialTheme.colorScheme
    val showAction = busy || input.isNotBlank()
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 11.dp),
        horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.Bottom
    ) {
        Box(Modifier.size(52.dp).clip(RoundedCornerShape(19.dp)).background(colors.primary)
            .clickable(role = SemanticRole.Button, onClick = onVoice).semantics { contentDescription = "开始通话" },
            contentAlignment = Alignment.Center) {
            LineIcon(Glyph.MIC, colors.onPrimary)
        }

        Row(
            Modifier.weight(1f).heightIn(min = 52.dp).clip(RoundedCornerShape(20.dp))
                .background(colors.surface).border(1.dp, colors.outlineVariant, RoundedCornerShape(20.dp)),
            verticalAlignment = Alignment.CenterVertically
        ) {
            BasicTextField(
                input, change, Modifier.weight(1f).padding(start = 15.dp, end = if (showAction) 4.dp else 15.dp,
                    top = 13.dp, bottom = 13.dp).semantics { contentDescription = "消息输入框" },
                textStyle = TextStyle(color = colors.onSurface, fontSize = 16.sp, lineHeight = 23.sp),
                minLines = 1, maxLines = 4, cursorBrush = SolidColor(colors.primary),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                decorationBox = { inner ->
                    Box {
                        if (input.isEmpty()) Text("发送消息", color = colors.onSurfaceVariant, fontSize = 16.sp, lineHeight = 23.sp)
                        inner()
                    }
                }
            )
            if (showAction) {
                SmallButton(
                    if (busy) Glyph.STOP else Glyph.SEND, if (busy) "停止回复" else "发送",
                    if (busy) onStop else onSend, tint = colors.primary
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HistorySheet(
    state: TurnlineState,
    choose: (Conversation?) -> Unit,
    delete: (Conversation, Boolean) -> Unit,
    dismiss: () -> Unit
) {
    val colors = MaterialTheme.colorScheme
    var deleteTarget by remember { mutableStateOf<Conversation?>(null) }
    var alsoDeleteRemote by remember(deleteTarget?.id) {
        mutableStateOf(state.settings?.usesConversation == true && deleteTarget?.remoteId != null)
    }
    ModalBottomSheet(onDismissRequest = dismiss, containerColor = colors.surface) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text("对话历史", Modifier.weight(1f).semantics { heading() }, fontSize = 23.sp, fontWeight = FontWeight.SemiBold)
            TextButton(onClick = { choose(null) }) {
                LineIcon(Glyph.ADD, colors.primary, Modifier.size(18.dp))
                Spacer(Modifier.width(5.dp))
                Text("新对话")
            }
        }
        if (state.history.isEmpty()) {
            Text("发送第一条消息后，对话会出现在这里。",
                Modifier.padding(horizontal = 23.dp, vertical = 24.dp), color = colors.onSurfaceVariant)
        }
        LazyColumn(contentPadding = PaddingValues(start = 15.dp, end = 15.dp, bottom = 20.dp)) {
            itemsIndexed(state.history, key = { _, thread -> thread.id }) { _, thread ->
                val selected = thread.id == state.conversation.id
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))
                    .background(if (selected) colors.surfaceVariant else Color.Transparent),
                    verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f).heightIn(min = 52.dp).clickable { choose(thread) }.padding(horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        LineIcon(if (selected) Glyph.CHECK else Glyph.WAVE, colors.primary, Modifier.size(18.dp))
                        Text(thread.title, Modifier.padding(start = 10.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    SmallButton(Glyph.TRASH, "删除对话 ${thread.title}", { deleteTarget = thread },
                        enabled = !state.busy && !state.loading)
                }
            }
        }
    }
    deleteTarget?.let { thread ->
        val hasRemote = state.settings?.usesConversation == true && thread.remoteId != null
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("删除对话？") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("「${thread.title}」将从这台设备的历史中移除。")
                    if (hasRemote) {
                        Row(
                            Modifier.fillMaxWidth().clickable { alsoDeleteRemote = !alsoDeleteRemote },
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Checkbox(checked = alsoDeleteRemote, onCheckedChange = { alsoDeleteRemote = it })
                            Text("同时删除 PipiClaw 远端会话", fontSize = 14.sp)
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val removeRemote = hasRemote && alsoDeleteRemote
                    deleteTarget = null
                    delete(thread, removeRemote)
                }) {
                    Text("删除", color = colors.error)
                }
            },
            dismissButton = { TextButton(onClick = { deleteTarget = null }) { Text("取消") } }
        )
    }
}
