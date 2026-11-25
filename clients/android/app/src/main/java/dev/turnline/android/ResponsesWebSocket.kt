package dev.turnline.android

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

internal class ResponsesWebSocket(private val http: OkHttpClient) {
    private val lock = Any()
    private var socket: WebSocket? = null
    private var connectedKey: String? = null
    private var activeChannel: Channel<JSONObject>? = null
    @Volatile var activeResponseId: String? = null
        private set
    @Volatile private var reconnectAfterTurn = false

    val isOpen: Boolean
        get() = synchronized(lock) { socket != null }

    private fun connectionKey(settings: ServiceSettings): String =
        "${settings.url}|${settings.key}"

    private fun wsUrl(httpUrl: HttpUrl): String {
        val raw = httpUrl.toString()
        return when {
            raw.startsWith("https://", ignoreCase = true) -> "wss://" + raw.substring(8)
            raw.startsWith("http://", ignoreCase = true) -> "ws://" + raw.substring(7)
            else -> raw
        }
    }

    private suspend fun ensureConnected(settings: ServiceSettings): WebSocket {
        val key = connectionKey(settings)
        synchronized(lock) {
            val existing = socket
            if (existing != null && connectedKey == key) return existing
            socket?.close(1000, "reconnect")
            socket = null
            connectedKey = null
        }

        val ready = CompletableDeferred<WebSocket>()
        val request = Request.Builder()
            .url(wsUrl(settings.url))
            .apply {
                if (settings.key.isNotEmpty()) header("Authorization", "Bearer ${settings.key}")
            }
            .build()

        val ws = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                synchronized(lock) {
                    socket = webSocket
                    connectedKey = key
                    reconnectAfterTurn = false
                }
                ready.complete(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val event = runCatching { JSONObject(text) }.getOrNull() ?: return
                val type = event.string("type")
                if (type == "error" && event.optJSONObject("error")?.string("code") == "websocket_connection_limit_reached") {
                    reconnectAfterTurn = true
                    if (synchronized(lock) { activeChannel == null }) close()
                    return
                }
                if (type == "response.created") {
                    event.optJSONObject("response")?.string("id")?.let { activeResponseId = it }
                } else if (
                    type in setOf("response.completed", "response.failed", "response.cancelled", "response.canceled") ||
                    (type == "response.incomplete" &&
                        event.optJSONObject("response")?.optJSONObject("incomplete_details")?.string("reason") != "steered")
                ) {
                    val eventRespId = event.optJSONObject("response")?.string("id")
                    if (eventRespId == null || eventRespId == activeResponseId) {
                        activeResponseId = null
                    }
                }
                synchronized(lock) { activeChannel }?.trySend(event)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handleDisconnect(webSocket, null)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!ready.isCompleted) {
                    val status = response?.code
                    val failure = if (status != null) {
                        ApiFailure("WebSocket 握手失败 (HTTP $status)。", status)
                    } else {
                        IOException(t.message ?: "WebSocket 连接失败。", t)
                    }
                    ready.completeExceptionally(failure)
                }
                handleDisconnect(webSocket, t)
            }
        })

        return try {
            withTimeout(TimeUnit.SECONDS.toMillis(5)) { ready.await() }
        } catch (error: Exception) {
            ws.cancel()
            throw error
        }
    }

    private fun handleDisconnect(webSocket: WebSocket, error: Throwable?) {
        val channel = synchronized(lock) {
            if (socket === webSocket) {
                socket = null
                connectedKey = null
            }
            activeResponseId = null
            val current = activeChannel
            activeChannel = null
            current
        }
        if (error != null) channel?.close(error) else channel?.close()
    }

    suspend fun sendTurn(
        settings: ServiceSettings,
        payload: JSONObject,
        state: StreamState,
        onDraft: (ResponseDraft) -> Unit,
        onSteerFailed: (() -> Unit)? = null
    ): List<Output> {
        val ws = ensureConnected(settings)
        val channel = Channel<JSONObject>(Channel.UNLIMITED)
        synchronized(lock) {
            activeChannel?.close()
            activeChannel = channel
        }
        val frame = JSONObject(payload.toString()).put("type", "response.create")
        if (!ws.send(frame.toString())) {
            synchronized(lock) { if (activeChannel === channel) activeChannel = null }
            close()
            throw IOException("无法通过 WebSocket 发送消息。")
        }

        var lastUpdate = 0L
        var terminalPartial = emptyList<Output>()
        try {
            for (event in channel) {
                val type = event.string("type")
                if (type == "response.steer.accepted") continue
                if (type == "response.steer.failed") {
                    onSteerFailed?.invoke()
                    continue
                }
                val completed = applyStreamEvent(
                    type = type,
                    event = event,
                    state = state,
                    publish = { force ->
                        val now = System.nanoTime()
                        if (force || now - lastUpdate >= 45_000_000L) {
                            lastUpdate = now
                            onDraft(state.draft())
                        }
                    },
                    onTerminalPartial = { terminalPartial = it }
                )
                if (completed != null) return completed
            }
            state.streamDisrupted = true
            throw ApiFailure("WebSocket 回复流提前断开，已保留收到的文字。")
        } catch (failure: Exception) {
            if (failure is IOException || failure is org.json.JSONException) {
                onDraft(state.draft(terminalPartial.ifEmpty(state::collected)))
            }
            throw failure
        } finally {
            synchronized(lock) {
                if (activeChannel === channel) activeChannel = null
            }
            channel.close()
            if (reconnectAfterTurn) close()
        }
    }

    fun steer(input: String, targetId: String? = activeResponseId): Boolean {
        val ws = synchronized(lock) { socket } ?: return false
        val id = targetId?.takeIf { it.isNotBlank() } ?: return false
        val payload = JSONObject()
            .put("type", "response.steer")
            .put("previous_response_id", id)
            .put("input", input)
        return ws.send(payload.toString())
    }

    fun cancel(responseId: String? = activeResponseId): Boolean {
        val ws = synchronized(lock) { socket } ?: return false
        val payload = JSONObject().put("type", "response.cancel")
        if (!responseId.isNullOrBlank()) payload.put("response_id", responseId)
        activeResponseId = null
        return ws.send(payload.toString())
    }

    fun close() {
        reconnectAfterTurn = false
        activeResponseId = null
        val ws = synchronized(lock) {
            val existing = socket
            socket = null
            connectedKey = null
            existing
        }
        ws?.close(1000, "closed")
    }
}
