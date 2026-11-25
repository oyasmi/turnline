package dev.turnline.android

import java.io.BufferedReader
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
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

class ApiFailure(message: String, val status: Int? = null) : IOException(message)

data class ResponseDraft(val phase: String = "正在等待回复", val outputs: List<Output> = emptyList()) {
    val text: String = outputs.joinToString("\n\n") { it.text }
}

data class ConversationPage(val messages: List<Output>, val cursor: String?, val hasMore: Boolean)

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
            execute(request(settings, settings.url, body), 20) { readReply(it) {} }
        }
    }

    suspend fun createConversation(settings: ServiceSettings): String =
        execute(request(settings, sibling(settings, "conversations"), JSONObject()), 15) { response ->
            readJson(response).string("id") ?: throw ApiFailure("服务没有返回会话 ID。")
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
        onDraft: (ResponseDraft) -> Unit
    ): List<Output> {
        val body = JSONObject().put("model", settings.model).put("stream", true)
        if (voice) body.put("instructions", VOICE_INSTRUCTIONS)
        if (conversationId != null) {
            body.put("conversation", conversationId).put("input", messages.last().text)
        } else {
            val input = JSONArray()
            contextFor(messages).forEach { message ->
                input.put(JSONObject().put("role", message.role.wire).put("content", message.text))
            }
            body.put("store", false).put("input", input)
        }
        return execute(request(settings, settings.url, body)) { response -> readReply(response, onDraft) }
    }

    private fun sibling(settings: ServiceSettings, vararg segments: String): HttpUrl =
        settings.url.newBuilder().removePathSegment(settings.url.pathSize - 1)
            .apply { segments.forEach { addPathSegment(it) } }.build()

    private fun request(settings: ServiceSettings, url: HttpUrl, body: JSONObject? = null): Request =
        Request.Builder().url(url)
            .header("Accept", if (body == null) "application/json" else "text/event-stream, application/json")
            .apply {
                if (settings.key.isNotEmpty()) header("Authorization", "Bearer ${settings.key}")
                if (body != null) post(body.toString().toRequestBody("application/json".toMediaType()))
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
                            throw ApiFailure(httpError(it.code, detail), it.code)
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
}

private const val MAX_PAYLOAD = 2_000_000
private const val MAX_OUTPUT = 140_000
private const val MAX_OUTPUT_ITEMS = 128

private fun readJson(response: Response): JSONObject {
    val source = response.body?.source() ?: throw ApiFailure("服务没有返回内容。")
    if (source.request(MAX_PAYLOAD + 1L)) throw ApiFailure("服务返回的单条消息过长。")
    return JSONObject(source.readUtf8())
}

private fun readReply(response: Response, onDraft: (ResponseDraft) -> Unit): List<Output> {
    val body = response.body ?: throw ApiFailure("服务没有返回内容。")
    val result = when (body.contentType()?.subtype) {
        "event-stream" -> body.charStream().buffered().use { reader ->
            assembleReply(reader, onDraft)
        }
        "json" -> completedOutput(readJson(response)) { partial ->
            onDraft(ResponseDraft("正在生成回复", partial))
        }
        else -> throw ApiFailure("服务返回了意外的格式。请检查地址是否指向 Responses API。")
    }
    return result.ifEmpty { throw ApiFailure("服务已完成请求，但没有返回可显示的文字。") }
}

private fun httpError(code: Int, detail: String?): String {
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

private fun displayFailure(error: Exception, key: String): ApiFailure = when (error) {
    is ApiFailure -> ApiFailure(
        (error.message ?: "请求失败。").let { if (key.isBlank()) it else it.replace(key, "••••") }.take(480),
        error.status
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

private data class DraftItem(
    var id: String? = null,
    var excluded: Boolean = false,
    var finished: Output? = null,
    val parts: MutableMap<Int, StringBuilder> = sortedMapOf()
) {
    fun output(): Output? = if (excluded) null else finished ?: parts.values.joinToString("\n")
        .trim().takeIf(String::isNotEmpty)?.let { Output(id, it) }
}

/** One bounded SSE record at a time, including named events and CR/LF framing. */
internal fun assembleReply(reader: BufferedReader, onDraft: (ResponseDraft) -> Unit): List<Output> {
    val output = sortedMapOf<Int, DraftItem>()
    var lastUpdate = 0L
    var phase = "正在等待回复"
    var received = 0

    fun collected() = boundedOutput(output.values.mapNotNull { it.output() })
    fun publish(force: Boolean = false) {
        val now = System.nanoTime()
        if (!force && now - lastUpdate < 45_000_000L) return
        lastUpdate = now
        onDraft(ResponseDraft(phase, collected()))
    }

    fun item(event: JSONObject): DraftItem {
        val index = event.optInt("output_index", 0)
        if (index !in 0 until MAX_OUTPUT_ITEMS) throw ApiFailure("服务返回的回复条目过多。")
        return output.getOrPut(index, ::DraftItem).apply { id = event.string("item_id") ?: id }
    }

    var terminalPartial = emptyList<Output>()
    try {
        for ((named, data) in readEvents(reader)) {
            if (data == "[DONE]") return collected()
            val event = JSONObject(data)
            when (val type = event.string("type") ?: named) {
                "response.queued" -> {
                    phase = "正在排队"
                    publish(true)
                }
                "response.in_progress" -> {
                    phase = "正在生成回复"
                    publish(true)
                }
                "response.output_item.added", "response.output_item.done" -> {
                    val detail = event.optJSONObject("item") ?: continue
                    val current = item(event)
                    current.id = detail.string("id") ?: current.id
                    current.excluded = detail.string("type") != "message" ||
                        detail.string("role") != "assistant" || detail.string("phase") == "commentary"
                    if (type == "response.output_item.done") {
                        current.finished = assistantOutput(detail)
                    }
                    phase = if (current.excluded) "正在处理" else "正在生成回复"
                    publish(true)
                }
                "response.output_text.delta", "response.refusal.delta",
                "response.output_text.done", "response.refusal.done" -> {
                    val current = item(event)
                    if (current.excluded) continue
                    val piece = event.optString("delta", "")
                    val done = event.string("text") ?: event.string("refusal")
                    val partIndex = event.optInt("content_index", 0)
                    if (partIndex !in 0 until MAX_OUTPUT_ITEMS) throw ApiFailure("服务返回的内容条目过多。")
                    val part = current.parts.getOrPut(partIndex, ::StringBuilder)
                    if (done != null) {
                        received -= part.length
                        part.clear()
                    }
                    val text = done ?: piece
                    val count = minOf(text.length, MAX_OUTPUT - received)
                    part.append(text, 0, count)
                    received += count
                    phase = "正在生成回复"
                    if (count < text.length) throw ApiFailure("回复过长，已保留收到的文字。")
                    publish()
                }
                "response.completed" -> {
                    val complete = event.optJSONObject("response")?.let { response ->
                        completedOutput(response) { terminalPartial = it }
                    }.orEmpty()
                    return complete.ifEmpty(::collected)
                }
                "response.failed", "response.incomplete", "response.cancelled", "response.canceled", "error" -> {
                    val response = event.optJSONObject("response") ?: event
                    terminalPartial = responseOutput(response)
                    throw responseFailure(response)
                }
            }
        }
        throw ApiFailure("回复流提前断开，已保留收到的文字。")
    } catch (failure: Exception) {
        if (failure is IOException || failure is JSONException) {
            onDraft(ResponseDraft(phase, terminalPartial.ifEmpty(::collected)))
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
