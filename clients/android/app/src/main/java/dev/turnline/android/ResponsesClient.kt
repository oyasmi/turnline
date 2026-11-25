package dev.turnline.android

import java.io.BufferedReader
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.TreeMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

class ApiFailure(
    message: String,
    val status: Int? = null,
    val retryAfter: Int? = null
) : IOException(message)

data class ResponseDraft(
    val phase: String = "正在等待回复",
    val outputs: List<Output> = emptyList(),
    val failureNotice: String? = null
) {
    val text: String = outputs.joinToString("\n\n") { it.text }
}

data class ConversationPage(val messages: List<Output>, val cursor: String?, val hasMore: Boolean)

private val TOOL_LABELS = mapOf(
    "bash" to "正在执行命令",
    "read" to "正在读取文件",
    "write" to "正在写入文件",
    "edit" to "正在编辑文件",
    "grep" to "正在检索内容",
    "glob" to "正在查找文件",
    "find" to "正在查找文件",
    "web_search" to "正在搜索网页",
    "web_fetch" to "正在读取网页",
    "memory_manage" to "正在检索记忆",
    "session_search" to "正在搜索历史",
    "subagent" to "正在委派子任务",
    "event_manage" to "正在管理事件"
)

internal fun describeTool(name: String?): String =
    if (name.isNullOrBlank()) "正在查询" else TOOL_LABELS[name] ?: "正在调用工具"

class ResponsesClient(
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .readTimeout(100, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.MINUTES)
        .retryOnConnectionFailure(false)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
) {
    private val ws = ResponsesWebSocket(http)

    fun steerActiveResponse(input: String, targetId: String? = null): Boolean =
        ws.steer(input, targetId ?: ws.activeResponseId)

    fun cancelActiveWebSocketResponse(responseId: String? = null): Boolean =
        ws.cancel(responseId ?: ws.activeResponseId)

    fun closeWebSocket() = ws.close()

    suspend fun check(settings: ServiceSettings) {
        if (settings.usesConversation) {
            val url = sibling(settings, "models", "pipiclaw")
            execute(request(settings, url), 12) { response ->
                if (readJson(response).string("id") != "pipiclaw") {
                    throw ApiFailure("地址没有返回 PipiClaw 模型信息。")
                }
            }
        } else {
            val body = JSONObject().put("model", settings.model).put("input", "Reply with only OK.")
                .put("stream", true).put("store", false)
            execute(request(settings, settings.url, body), 20) { readReply(it, StreamState()) {} }
        }
    }

    suspend fun createConversation(
        settings: ServiceSettings,
        metadata: Map<String, String>? = null
    ): String {
        val body = JSONObject()
        if (!metadata.isNullOrEmpty()) {
            body.put("metadata", JSONObject(metadata))
        }
        return execute(request(settings, sibling(settings, "conversations"), body), 15) { response ->
            readJson(response).string("id") ?: throw ApiFailure("服务没有返回会话 ID。")
        }
    }

    suspend fun updateConversationMetadata(
        settings: ServiceSettings,
        id: String,
        metadata: Map<String, String>
    ) {
        if (metadata.isEmpty()) return
        val body = JSONObject().put("metadata", JSONObject(metadata))
        execute(request(settings, sibling(settings, "conversations", id), body), 10) { Unit }
    }

    suspend fun deleteConversation(settings: ServiceSettings, id: String) {
        try {
            execute(request(settings, sibling(settings, "conversations", id), method = "DELETE"), 10) { Unit }
        } catch (error: ApiFailure) {
            if (error.status == 404) return
            throw error
        }
    }

    suspend fun cancelResponse(settings: ServiceSettings, responseId: String) {
        if (responseId.isBlank()) return
        try {
            execute(
                request(settings, sibling(settings, "responses", responseId, "cancel"), JSONObject()),
                8
            ) { Unit }
        } catch (error: ApiFailure) {
            if (error.status == 400 || error.status == 404) return
            throw error
        }
    }

    suspend fun items(settings: ServiceSettings, id: String, after: String?): ConversationPage {
        val url = sibling(settings, "conversations", id, "items").newBuilder()
            .addQueryParameter("order", "asc").addQueryParameter("limit", "50")
            .apply { after?.let { addQueryParameter("after", it) } }.build()
        return execute(request(settings, url), 8) { response ->
            val payload = readJson(response)
            val data = payload.optJSONArray("data") ?: throw ApiFailure("会话记录格式有误。")
            val messages = mutableListOf<Output>()
            var cursor = after
            var blocked = false
            for (index in 0 until data.length()) {
                val item = data.optJSONObject(index) ?: continue
                if (item.string("status") == "in_progress") {
                    blocked = true
                    break
                }
                cursor = item.string("id") ?: cursor
                if (item.string("phase") == "final_answer" && item.string("status") == "completed") {
                    assistantOutput(item)?.let(messages::add)
                }
            }
            ConversationPage(messages, cursor, !blocked && payload.optBoolean("has_more") && cursor != after)
        }
    }

    suspend fun respond(
        settings: ServiceSettings,
        conversationId: String?,
        messages: List<Message>,
        voice: Boolean,
        instructions: String? = null,
        background: Boolean = conversationId != null,
        preferWebSocket: Boolean = false,
        onResponseCreated: ((String, Boolean) -> Unit)? = null,
        onSteerFailed: (() -> Unit)? = null,
        onDraft: (ResponseDraft) -> Unit
    ): List<Output> {
        val resolvedInstructions = instructions?.takeIf { it.isNotBlank() }
            ?: if (voice) VOICE_INSTRUCTIONS else null

        if (preferWebSocket && conversationId != null && settings.usesConversation) {
            val wsPayload = JSONObject()
                .put("model", settings.model)
                .put("conversation", conversationId)
                .put("input", messages.last().text)
                .apply {
                    if (resolvedInstructions != null) put("instructions", resolvedInstructions)
                }
            val wsState = StreamState(onResponseCreated = { id -> onResponseCreated?.invoke(id, true) })
            try {
                val result = ws.sendTurn(settings, wsPayload, wsState, onDraft, onSteerFailed)
                return result.ifEmpty { throw ApiFailure("服务已完成请求，但没有返回可显示的文字。") }
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                if (wsState.responseId != null) {
                    throw displayFailure(error, settings.key)
                }
                ws.close()
                // Fall back seamlessly to HTTP SSE when WebSocket is unavailable before turn creation.
            }
        }

        val body = JSONObject().put("model", settings.model).put("stream", true)
        if (resolvedInstructions != null) body.put("instructions", resolvedInstructions)
        if (conversationId != null) {
            if (background) body.put("background", true)
            body.put("conversation", conversationId).put("input", messages.last().text)
        } else {
            val input = JSONArray()
            contextFor(messages).forEach { message ->
                input.put(JSONObject().put("role", message.role.wire).put("content", message.text))
            }
            body.put("store", false).put("input", input)
        }

        val state = StreamState(onResponseCreated = { id -> onResponseCreated?.invoke(id, false) })
        var initialError: ApiFailure? = null
        try {
            return execute(request(settings, settings.url, body)) { response ->
                readReply(response, state, onDraft)
            }
        } catch (error: ApiFailure) {
            if (!background || conversationId == null || error.status != null || !state.canResume()) {
                throw error
            }
            initialError = error
        }

        var lastError: ApiFailure = initialError!!
        for (delayMs in RESUME_BACKOFF_MS) {
            delay(delayMs)
            val responseId = state.responseId ?: break
            val url = sibling(settings, "responses", responseId).newBuilder()
                .addQueryParameter("stream", "true")
                .apply { state.lastSequence?.let { addQueryParameter("starting_after", it.toString()) } }
                .build()
            try {
                return execute(request(settings, url, acceptStream = true)) { response ->
                    readReply(response, state, onDraft)
                }
            } catch (error: ApiFailure) {
                lastError = error
                if (error.status == 400 || error.status == 404) break
            }
        }
        onDraft(state.draft())
        throw lastError
    }

    private fun sibling(settings: ServiceSettings, vararg segments: String): HttpUrl =
        settings.url.newBuilder().removePathSegment(settings.url.pathSize - 1)
            .apply { segments.forEach { addPathSegment(it) } }.build()

    private fun request(
        settings: ServiceSettings,
        url: HttpUrl,
        body: JSONObject? = null,
        method: String? = null,
        acceptStream: Boolean = body != null
    ): Request =
        Request.Builder().url(url)
            .header("Accept", if (acceptStream) "text/event-stream, application/json" else "application/json")
            .apply {
                if (settings.key.isNotEmpty()) header("Authorization", "Bearer ${settings.key}")
                when {
                    method != null -> method(method, body?.toString()?.toRequestBody("application/json".toMediaType()))
                    body != null -> post(body.toString().toRequestBody("application/json".toMediaType()))
                }
            }.build()

    private suspend fun <T> execute(
        request: Request,
        timeoutSeconds: Long? = null,
        read: (Response) -> T
    ): T = suspendCancellableCoroutine { continuation ->
        val call = http.newCall(request)
        timeoutSeconds?.let { call.timeout().timeout(it, TimeUnit.SECONDS) }
        continuation.invokeOnCancellation { call.cancel() }
        val key = request.header("Authorization")?.removePrefix("Bearer ").orEmpty()
        fun fail(error: Exception) {
            if (continuation.isActive) continuation.resumeWithException(displayFailure(error, key))
        }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = fail(e)

            override fun onResponse(call: Call, response: Response) {
                try {
                    val result = response.use {
                        if (!it.isSuccessful) {
                            val error = runCatching { JSONObject(it.peekBody(8192).string()) }.getOrNull()
                            val detail = error?.optJSONObject("error")?.string("message")
                            val retryAfter = it.header("Retry-After")?.trim()?.toIntOrNull()?.takeIf { s -> s > 0 }
                            throw ApiFailure(httpError(it.code, detail, retryAfter), it.code, retryAfter)
                        }
                        read(it)
                    }
                    if (continuation.isActive) continuation.resume(result)
                } catch (error: Exception) {
                    fail(error)
                }
            }
        })
    }

    private companion object {
        val RESUME_BACKOFF_MS = longArrayOf(600L, 1_500L, 3_000L)
    }
}

private const val MAX_PAYLOAD = 2_000_000
private const val MAX_OUTPUT = 140_000
private const val MAX_OUTPUT_ITEMS = 128

private fun readJson(response: Response): JSONObject {
    val source = response.body?.source() ?: throw ApiFailure("服务没有返回内容。")
    if (source.request(MAX_PAYLOAD + 1L)) throw ApiFailure("服务返回的单条消息过长。")
    return JSONObject(source.readUtf8())
}

private fun readReply(response: Response, state: StreamState, onDraft: (ResponseDraft) -> Unit): List<Output> {
    val body = response.body ?: throw ApiFailure("服务没有返回内容。")
    val result = when (body.contentType()?.subtype) {
        "event-stream" -> body.charStream().buffered().use { reader ->
            assembleReply(reader, state, onDraft)
        }
        "json" -> completedOutput(readJson(response)) { partial ->
            onDraft(ResponseDraft("正在生成回复", partial))
        }
        else -> throw ApiFailure("服务返回了意外的格式。请检查地址是否指向 Responses API。")
    }
    return result.ifEmpty { throw ApiFailure("服务已完成请求，但没有返回可显示的文字。") }
}

private fun httpError(code: Int, detail: String?, retryAfter: Int? = null): String {
    if (code == 429 && retryAfter != null) {
        return "PipiClaw 正忙，请 $retryAfter 秒后重试。"
    }
    val hint = when (code) {
        in 300..399 -> "服务要求重定向。请直接填写最终地址。"
        401, 403 -> "服务拒绝了连接。请检查 API 密钥和权限。"
        404 -> "服务找不到请求的地址、模型或会话。"
        409 -> "会话正在处理上一轮，请稍后再试。"
        429 -> "服务当前请求过多，请稍后再试。"
        in 500..599 -> "模型服务暂时不可用。"
        else -> "服务返回 HTTP $code。"
    }
    return if (detail.isNullOrBlank()) hint else "$hint\n${detail.take(260)}"
}

internal fun displayFailure(error: Exception, key: String): ApiFailure = when (error) {
    is ApiFailure -> ApiFailure(
        (error.message ?: "请求失败。").let { if (key.isBlank()) it else it.replace(key, "••••") }.take(480),
        error.status,
        error.retryAfter
    )
    is SSLException -> ApiFailure("无法验证 HTTPS 连接。请检查证书、地址和设备时间。")
    is UnknownHostException -> ApiFailure("找不到服务主机。请检查地址或网络。")
    is ConnectException -> ApiFailure("连接不到服务。请检查端口、监听地址和手机所在的网络。")
    is SocketTimeoutException, is java.io.InterruptedIOException -> ApiFailure("等待服务超时。请检查网络后重试。")
    is JSONException -> ApiFailure("服务返回的 Responses 数据格式有误。")
    is IOException -> ApiFailure("与服务的连接已中断。请检查网络后重试。")
    else -> ApiFailure("无法处理服务返回的内容。")
}

internal fun JSONObject.string(name: String): String? = (opt(name) as? String)?.takeIf { it.isNotBlank() }

internal fun assistantOutput(item: JSONObject): Output? {
    if (item.string("type") != "message" || item.string("role") != "assistant" ||
        item.string("phase") == "commentary"
    ) return null
    val content = item.optJSONArray("content") ?: return null
    val parts = (0 until content.length()).mapNotNull { index ->
        val part = content.optJSONObject(index) ?: return@mapNotNull null
        when (part.string("type")) {
            "output_text" -> part.string("text")
            "refusal" -> part.string("refusal")
            else -> null
        }
    }
    val text = parts.joinToString("\n").trim().take(MAX_OUTPUT)
    return if (text.isBlank()) null else Output(item.string("id"), text)
}

private fun completedOutput(response: JSONObject, onPartial: (List<Output>) -> Unit): List<Output> {
    val output = responseOutput(response)
    val status = response.string("status")
    if (status != null && status != "completed" || response.optJSONObject("error") != null) {
        if (output.isNotEmpty()) onPartial(output)
        throw responseFailure(response)
    }
    return output
}

private fun responseOutput(response: JSONObject): List<Output> {
    val output = response.optJSONArray("output")
    val fallback = response.string("output_text")?.let { listOf(Output(null, it.take(MAX_OUTPUT))) }.orEmpty()
    if (output != null) {
        return boundedOutput((0 until minOf(output.length(), MAX_OUTPUT_ITEMS))
            .mapNotNull { output.optJSONObject(it)?.let(::assistantOutput) }).ifEmpty { fallback }
    }
    return fallback
}

private fun boundedOutput(outputs: List<Output>): List<Output> = buildList {
    var remaining = MAX_OUTPUT
    for (output in outputs) {
        if (remaining <= 0) break
        val text = output.text.take(remaining).trimEnd()
        if (text.isNotEmpty()) add(output.copy(text = text))
        remaining -= text.length + 2
    }
}

private fun responseFailure(payload: JSONObject): ApiFailure {
    val detail = payload.optJSONObject("error")?.string("message")
        ?: payload.string("message") ?: payload.optJSONObject("incomplete_details")?.string("reason")
    return ApiFailure(if (detail == null) "服务未完成这次回复。" else "服务未完成这次回复。\n${detail.take(260)}")
}

internal class DraftItem(
    var id: String? = null,
    var excluded: Boolean = false,
    var finished: Output? = null,
    val parts: MutableMap<Int, StringBuilder> = sortedMapOf()
) {
    fun output(): Output? = if (excluded) null else finished ?: parts.values.joinToString("\n")
        .trim().takeIf(String::isNotEmpty)?.let { Output(id, it) }
}

private val OUTPUT_KEY_COMPARATOR = compareBy<Pair<Int, Int>>({ it.first }, { it.second })

internal class StreamState(
    val onResponseCreated: ((String) -> Unit)? = null
) {
    val output = TreeMap<Pair<Int, Int>, DraftItem>(OUTPUT_KEY_COMPARATOR)
    val activeTools = linkedMapOf<Pair<Int, Int>, String>()
    var generation: Int = 0
    var phase: String = "正在等待回复"
    var received: Int = 0
    var responseId: String? = null
    var lastSequence: Int? = null
    var failureNotice: String? = null
    var streamDisrupted: Boolean = false

    fun collected(): List<Output> = boundedOutput(output.values.mapNotNull { it.output() })

    fun draft(outputs: List<Output> = collected()): ResponseDraft =
        ResponseDraft(phase, outputs, failureNotice)

    fun canResume(): Boolean = streamDisrupted && responseId != null && lastSequence != null
}

internal fun applyStreamEvent(
    type: String?,
    event: JSONObject,
    state: StreamState,
    publish: (Boolean) -> Unit,
    onTerminalPartial: (List<Output>) -> Unit
): List<Output>? {
    if (event.has("sequence_number") && !event.isNull("sequence_number")) {
        val seq = event.optInt("sequence_number", -1)
        if (seq >= 0) state.lastSequence = seq
    }

    fun item(ev: JSONObject): DraftItem {
        val index = ev.optInt("output_index", 0)
        if (index !in 0 until MAX_OUTPUT_ITEMS) throw ApiFailure("服务返回的回复条目过多。")
        return state.output.getOrPut(state.generation to index, ::DraftItem).apply {
            id = ev.string("item_id") ?: id
        }
    }

    when (type) {
        "response.created" -> {
            val createdId = event.optJSONObject("response")?.string("id")
            if (createdId != null) {
                state.responseId = createdId
                state.onResponseCreated?.invoke(createdId)
            }
            when (event.optJSONObject("response")?.string("status")) {
                "queued" -> {
                    state.phase = "正在排队"
                    publish(true)
                }
                "in_progress" -> {
                    state.phase = "正在生成回复"
                    publish(true)
                }
            }
        }
        "response.queued" -> {
            state.phase = "正在排队"
            publish(true)
        }
        "response.in_progress" -> {
            state.phase = state.activeTools.values.lastOrNull() ?: "正在生成回复"
            publish(true)
        }
        "response.output_item.added", "response.output_item.done" -> {
            val detail = event.optJSONObject("item") ?: return null
            val index = event.optInt("output_index", 0)
            val key = state.generation to index
            val itemType = detail.string("type")
            val current = item(event)
            current.id = detail.string("id") ?: current.id
            current.excluded = itemType != "message" ||
                detail.string("role") != "assistant" || detail.string("phase") == "commentary"
            if (itemType == "mcp_call" || itemType == "function_call") {
                if (type == "response.output_item.added") {
                    state.activeTools[key] = describeTool(detail.string("name"))
                } else {
                    state.activeTools.remove(key)
                    if (itemType == "mcp_call" && detail.string("status") == "failed") {
                        detail.string("pipiclaw_failure")?.let { state.failureNotice = it }
                    }
                }
            }
            if (type == "response.output_item.done") {
                current.finished = assistantOutput(detail)
            }
            state.phase = when {
                state.activeTools.isNotEmpty() -> state.activeTools.values.last()
                current.excluded -> "正在处理"
                else -> "正在生成回复"
            }
            publish(true)
        }
        "response.output_text.delta", "response.refusal.delta",
        "response.output_text.done", "response.refusal.done" -> {
            val current = item(event)
            if (current.excluded) return null
            val piece = event.optString("delta", "")
            val done = event.string("text") ?: event.string("refusal")
            val partIndex = event.optInt("content_index", 0)
            if (partIndex !in 0 until MAX_OUTPUT_ITEMS) throw ApiFailure("服务返回的内容条目过多。")
            val part = current.parts.getOrPut(partIndex, ::StringBuilder)
            if (done != null) {
                state.received -= part.length
                part.clear()
            }
            val text = done ?: piece
            val count = minOf(text.length, MAX_OUTPUT - state.received)
            part.append(text, 0, count)
            state.received += count
            state.phase = "正在生成回复"
            if (count < text.length) throw ApiFailure("回复过长，已保留收到的文字。")
            publish(false)
        }
        "response.completed" -> {
            val complete = event.optJSONObject("response")?.let { response ->
                completedOutput(response, onTerminalPartial)
            }.orEmpty()
            return complete.ifEmpty(state::collected)
        }
        "response.incomplete" -> {
            val response = event.optJSONObject("response") ?: event
            if (response.optJSONObject("incomplete_details")?.string("reason") == "steered") {
                state.generation++
                state.activeTools.clear()
                state.phase = "正在根据新要求调整"
                publish(true)
                return null
            }
            onTerminalPartial(responseOutput(response))
            throw responseFailure(response)
        }
        "response.failed", "response.cancelled", "response.canceled", "error" -> {
            val response = event.optJSONObject("response") ?: event
            onTerminalPartial(responseOutput(response))
            throw responseFailure(response)
        }
    }
    return null
}

/** One bounded SSE record at a time, including named events and CR/LF framing. */
internal fun assembleReply(reader: BufferedReader, onDraft: (ResponseDraft) -> Unit): List<Output> =
    assembleReply(reader, StreamState(), onDraft)

internal fun assembleReply(
    reader: BufferedReader,
    state: StreamState,
    onDraft: (ResponseDraft) -> Unit
): List<Output> {
    var lastUpdate = 0L

    fun publish(force: Boolean = false) {
        val now = System.nanoTime()
        if (!force && now - lastUpdate < 45_000_000L) return
        lastUpdate = now
        onDraft(state.draft())
    }

    var terminalPartial = emptyList<Output>()
    state.streamDisrupted = false
    try {
        for ((named, data) in readEvents(reader)) {
            if (data == "[DONE]") return state.collected()
            val event = JSONObject(data)
            val completed = applyStreamEvent(
                type = event.string("type") ?: named,
                event = event,
                state = state,
                publish = ::publish,
                onTerminalPartial = { terminalPartial = it }
            )
            if (completed != null) return completed
        }
        state.streamDisrupted = true
        throw ApiFailure("回复流提前断开，已保留收到的文字。")
    } catch (failure: Exception) {
        if (failure is IOException && failure !is ApiFailure) {
            state.streamDisrupted = true
        }
        if (failure is IOException || failure is JSONException) {
            onDraft(state.draft(terminalPartial.ifEmpty(state::collected)))
        }
        throw failure
    }
}

private fun readEvents(reader: BufferedReader): Sequence<Pair<String?, String>> = sequence {
    var name: String? = null
    val data = StringBuilder()
    val buffer = StringBuilder()
    var first = true
    var skipLineFeed = false

    fun nextLine(): String? {
        buffer.clear()
        while (true) {
            val character = reader.read()
            if (skipLineFeed) {
                skipLineFeed = false
                if (character == 10) continue
            }
            when (character) {
                -1 -> return buffer.toString().takeIf(String::isNotEmpty)
                10, 13 -> {
                    skipLineFeed = character == 13
                    return buffer.toString()
                }
                else -> {
                    if (buffer.length == MAX_PAYLOAD) throw ApiFailure("服务返回的单条事件过长。")
                    buffer.append(character.toChar())
                }
            }
        }
    }

    while (true) {
        val raw = nextLine() ?: break
        val line = if (first) raw.removePrefix("\uFEFF") else raw
        first = false
        if (line.isEmpty()) {
            if (data.isNotEmpty()) yield(name to data.toString())
            name = null
            data.clear()
        } else if (line.startsWith("data:")) {
            if (data.length + line.length > MAX_PAYLOAD) throw ApiFailure("服务返回的单条事件过长。")
            if (data.isNotEmpty()) data.append('\n')
            data.append(line.substring(5).removePrefix(" "))
        } else if (line.startsWith("event:")) {
            name = line.substring(6).trim()
        }
    }
    // Some gateways omit the trailing empty line after a terminal event.
    if (data.isNotEmpty()) yield(name to data.toString())
}
