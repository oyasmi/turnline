package dev.turnline.android

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    configured: ServiceSettings?,
    testConnection: suspend (ServiceSettings) -> Unit,
    save: (ServiceSettings, Boolean) -> Unit,
    saving: Boolean,
    saveError: String?,
    clearSaveError: () -> Unit,
    close: () -> Unit
) {
    val colors = MaterialTheme.colorScheme
    var provider by rememberSaveable { mutableStateOf(configured?.provider ?: Provider.PIPICLAW) }
    var address by rememberSaveable {
        mutableStateOf(configured?.url?.toString().orEmpty())
    }
    var model by rememberSaveable {
        mutableStateOf(configured?.model?.takeIf { configured.provider == Provider.RESPONSES }.orEmpty())
    }
    var enteredToken by remember { mutableStateOf<String?>(null) }
    var showToken by remember { mutableStateOf(false) }
    var language by rememberSaveable { mutableStateOf(configured?.language ?: SpeechLanguage.CHINESE) }
    var local by rememberSaveable { mutableStateOf(configured?.localRecognition ?: true) }
    var testing by remember { mutableStateOf(false) }
    var tested by remember { mutableStateOf<ServiceSettings?>(null) }
    var issue by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val editable = !testing && !saving
    val http = address.trim().startsWith("http://", ignoreCase = true)
    val endpoint = remember(address) { runCatching { responsesUrl(address) }.getOrNull() }
    val token = enteredToken ?: configured?.takeIf { it.provider == provider && it.url == endpoint }?.key.orEmpty()

    fun form(): ServiceSettings {
        val url = responsesUrl(address)
        val key = token.trim()
        require(key.all { it.code in 33..126 }) { "API 密钥不能包含空格或换行。" }
        require(provider != Provider.PIPICLAW || key.isNotEmpty()) { "PipiClaw 的 HTTP 接口需要 API 密钥。" }
        val name = if (provider == Provider.PIPICLAW) "pipiclaw" else model.trim()
        require(name.isNotBlank()) { "请填写服务使用的模型 ID。" }
        return ServiceSettings(provider, url, name, key, language, local)
    }
    fun checkForm(): ServiceSettings? = try {
        issue = null
        clearSaveError()
        focus.clearFocus()
        keyboard?.hide()
        form()
    } catch (error: IllegalArgumentException) {
        issue = error.message
        null
    }
    fun reset() {
        tested = null
        issue = null
        clearSaveError()
    }
    fun clearToken() {
        enteredToken = null
        showToken = false
    }

    BackHandler { if (!saving) close() }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 640.dp).fillMaxSize().navigationBarsPadding().imePadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 10.dp, end = 20.dp, top = 7.dp, bottom = 7.dp),
                verticalAlignment = Alignment.CenterVertically) {
                SmallButton(Glyph.BACK, "返回对话", close, enabled = !saving)
                Text(if (configured == null) "连接服务" else "连接与语音",
                    Modifier.padding(start = 5.dp).semantics { heading() },
                    fontSize = 25.sp, fontWeight = FontWeight.SemiBold, lineHeight = 30.sp)
            }
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, top = 9.dp, bottom = 22.dp),
                verticalArrangement = Arrangement.spacedBy(13.dp)) {
                SettingsGroup("模型服务") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        Provider.entries.forEach { option ->
                            val active = option == provider
                            Box(Modifier.weight(1f).heightIn(min = 48.dp).clip(RoundedCornerShape(15.dp))
                                .background(if (active) colors.primaryContainer else colors.background)
                                .border(1.dp, if (active) colors.primary.copy(alpha = 0.45f) else colors.outlineVariant,
                                    RoundedCornerShape(15.dp))
                                .clickable(enabled = editable, role = Role.RadioButton) {
                                    if (provider != option) {
                                        provider = option
                                        clearToken()
                                        reset()
                                    }
                                }
                                .padding(horizontal = 6.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
                                Text(option.label, fontSize = 14.sp,
                                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
                                    color = if (active) colors.onPrimaryContainer else colors.onSurfaceVariant)
                            }
                        }
                    }
                    Text(
                        if (provider == Provider.PIPICLAW) "使用 PipiClaw 会话，保留工位上下文和后台任务更新。"
                        else "通过 /responses 发送消息，由手机保留近期对话上下文。",
                        fontSize = 13.sp, lineHeight = 20.sp, color = colors.onSurfaceVariant
                    )
                    OutlinedTextField(address, { next ->
                        if (endpoint != null && endpoint != runCatching { responsesUrl(next) }.getOrNull()) clearToken()
                        address = next
                        reset()
                    }, Modifier.fillMaxWidth(),
                        label = { Text("服务地址") },
                        placeholder = { Text(if (provider == Provider.PIPICLAW) "http://192.168.1.5:8787/v1" else "https://api.example.com/v1") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        shape = RoundedCornerShape(13.dp), singleLine = true, enabled = editable)
                    if (provider == Provider.RESPONSES) {
                        OutlinedTextField(model, { model = it; reset() }, Modifier.fillMaxWidth(),
                            label = { Text("模型 ID") }, placeholder = { Text("服务提供的模型名称") },
                            shape = RoundedCornerShape(13.dp), singleLine = true, enabled = editable)
                    }
                    OutlinedTextField(token, { enteredToken = it; reset() }, Modifier.fillMaxWidth(),
                        label = { Text(if (provider == Provider.PIPICLAW) "API 密钥" else "API 密钥（如需）") },
                        singleLine = true, enabled = editable, shape = RoundedCornerShape(13.dp),
                        visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        trailingIcon = {
                            SmallButton(if (showToken) Glyph.EYE_OFF else Glyph.EYE,
                                if (showToken) "隐藏密钥" else "显示密钥", { showToken = !showToken })
                        })
                    if (http) {
                        Text("HTTP 会以明文发送消息和密钥。请仅用于可信网络。",
                            color = colors.error, fontSize = 12.sp, lineHeight = 18.sp)
                    }
                }

                SettingsGroup("语音") {
                    Text("识别语言", fontWeight = FontWeight.Medium, fontSize = 14.sp)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        SpeechLanguage.entries.forEach { option ->
                            FilterChip(language == option, { language = option }, label = { Text(option.label) },
                                enabled = editable)
                        }
                    }
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f).padding(end = 10.dp)) {
                            Text("仅在设备上识别", fontWeight = FontWeight.Medium, fontSize = 14.sp)
                            Text("需要系统离线语音包。关闭后使用系统识别，语音可能由其在线处理。",
                                color = colors.onSurfaceVariant, fontSize = 12.sp, lineHeight = 18.sp)
                        }
                        Switch(local, { local = it }, enabled = editable)
                    }
                }
                if (provider == Provider.RESPONSES) {
                    Text("测试连接会向所选模型发送一次简短请求。",
                        Modifier.padding(horizontal = 3.dp), color = colors.onSurfaceVariant, fontSize = 12.sp)
                }
            }
            Surface(Modifier.fillMaxWidth(), color = colors.background) {
                Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    (issue ?: saveError)?.let { message ->
                        Text(message, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = colors.error,
                            fontSize = 13.sp, lineHeight = 19.sp)
                    }
                    if (tested != null && issue == null && saveError == null) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            LineIcon(Glyph.CHECK, colors.primary, Modifier.size(17.dp))
                            Text("连接测试通过", Modifier.padding(start = 6.dp).semantics { liveRegion = LiveRegionMode.Polite },
                                color = colors.primary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(onClick = {
                            val candidate = checkForm() ?: return@OutlinedButton
                            tested = null
                            testing = true
                            scope.launch {
                                try {
                                    testConnection(candidate)
                                    tested = candidate
                                } catch (error: Exception) {
                                    if (error is CancellationException) throw error
                                    issue = error.message ?: "连接失败，请检查设置。"
                                } finally {
                                    testing = false
                                }
                            }
                        }, Modifier.weight(1f).heightIn(min = 49.dp), enabled = editable) {
                            if (testing) CircularProgressIndicator(Modifier.size(17.dp), strokeWidth = 2.dp)
                            else Text("测试连接")
                        }
                        Button(onClick = {
                            val candidate = checkForm() ?: return@Button
                            save(candidate, tested?.sameService(candidate) == true)
                        }, Modifier.weight(1f).heightIn(min = 49.dp), enabled = editable,
                            contentPadding = PaddingValues(horizontal = 8.dp)) {
                            Text(if (saving) "正在保存" else "保存并返回", fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        Modifier.fillMaxWidth(), shape = RoundedCornerShape(23.dp),
        color = MaterialTheme.colorScheme.surface
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, Modifier.semantics { heading() }, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            Spacer(Modifier.height(1.dp))
            content()
        }
    }
}
