package dev.turnline.android

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponsesWebSocketTest {
    @Test
    fun supportsWebSocketCreateAndMidTurnSteering() = runBlocking {
        MockWebServer().use { server ->
            val receivedFrames = CopyOnWriteArrayList<JSONObject>()
            val firstCreated = CompletableDeferred<Unit>()
            server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = JSONObject(text)
                    receivedFrames += frame
                    when (frame.optString("type")) {
                        "response.create" -> {
                            webSocket.send("""{"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}""")
                            webSocket.send("""{"type":"response.output_item.added","output_index":0,"item":{"id":"t1","type":"mcp_call","name":"bash"}}""")
                            firstCreated.complete(Unit)
                        }
                        "response.steer" -> {
                            webSocket.send("""{"type":"response.steer.accepted"}""")
                            webSocket.send("""{"type":"response.incomplete","response":{"id":"resp_1","status":"incomplete","incomplete_details":{"reason":"steered"}}}""")
                            webSocket.send("""{"type":"response.created","response":{"id":"resp_2","status":"in_progress"}}""")
                            webSocket.send("""{"type":"response.output_text.delta","output_index":0,"item_id":"m2","delta":"已按新要求调整。"}""")
                            webSocket.send("""{"type":"response.completed","response":{"id":"resp_2","status":"completed","output":[{"id":"m2","type":"message","role":"assistant","content":[{"type":"output_text","text":"已按新要求调整。"}]}]}}""")
                        }
                    }
                }
            }))

            val client = ResponsesClient()
            val settings = ServiceSettings(
                Provider.PIPICLAW,
                responsesUrl(server.url("/gateway/v1").toString()),
                "pipiclaw",
                "sample-key"
            )
            val createdIds = CopyOnWriteArrayList<String>()
            val turn = async {
                client.respond(
                    settings = settings,
                    conversationId = "conv_ws",
                    messages = listOf(Message(role = Role.USER, text = "先检查日志")),
                    voice = false,
                    preferWebSocket = true,
                    onResponseCreated = { id, viaWs ->
                        assertTrue(viaWs)
                        createdIds += id
                    }
                ) {}
            }
            firstCreated.await()
            assertTrue(client.steerActiveResponse("只看最近十行", "resp_1"))
            val outputs = turn.await()
            client.closeWebSocket()

            assertEquals(listOf(Output("m2", "已按新要求调整。")), outputs)
            assertEquals(listOf("resp_1", "resp_2"), createdIds)
            assertEquals("response.create", receivedFrames[0].getString("type"))
            assertEquals("response.steer", receivedFrames[1].getString("type"))
            assertEquals("resp_1", receivedFrames[1].getString("previous_response_id"))
            assertEquals("只看最近十行", receivedFrames[1].getString("input"))
        }
    }

    @Test
    fun fallsBackToHttpSseWhenWebSocketHandshakeIsRejected() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(426))
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
                """data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_http","status":"in_progress"}}""" + "\n\n" +
                    """data: {"type":"response.completed","sequence_number":1,"response":{"status":"completed","output":[{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":"HTTP 回退成功。"}]}]}}""" + "\n\n"
            ))

            val client = ResponsesClient()
            val settings = ServiceSettings(
                Provider.PIPICLAW,
                responsesUrl(server.url("/gateway/v1").toString()),
                "pipiclaw",
                "sample-key"
            )
            var usedWs: Boolean? = null
            val outputs = client.respond(
                settings = settings,
                conversationId = "conv_fallback",
                messages = listOf(Message(role = Role.USER, text = "你好")),
                voice = false,
                preferWebSocket = true,
                onResponseCreated = { _, viaWs -> usedWs = viaWs }
            ) {}
            assertEquals(false, usedWs)
            assertEquals(listOf(Output("m1", "HTTP 回退成功。")), outputs)
        }
    }
}
