package dev.turnline.android

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class ResponsesClientTest {
    @Test
    fun normalizesBaseAddressesAndRetainsExplicitResponsesPath() {
        assertEquals("http://192.168.1.2:8787/v1/responses", responsesUrl("  http://192.168.1.2:8787 ").toString())
        assertEquals("http://[::1]:8787/v1/responses", responsesUrl("http://[::1]:8787/v1/").toString())
        assertEquals("https://example.test/gateway/v2/responses", responsesUrl("https://example.test/gateway/v2").toString())
        assertEquals("https://example.test/responses", responsesUrl("https://example.test/responses/").toString())
        assertTrue(runCatching { responsesUrl("https://user:secret@example.test") }.isFailure)
        assertTrue(runCatching { responsesUrl("https://example.test/v1?key=secret") }.isFailure)
    }

    @Test
    fun readsNamedMultilineEventsAndRemovesPipiclawCommentary() {
        val wire = listOf(
            "\uFEFF: keep-alive",
            "event: response.output_text.delta", "data: {\"output_index\":0,", "data: \"delta\":\"正在查看\"}", "",
            event("response.output_item.done", """ "item":{"id":"m0","type":"message","role":"assistant","phase":"commentary"} """),
            event("response.output_text.delta", """ "output_index":1,"item_id":"m1","delta":"可以了" """),
            event("response.output_text.done", """ "output_index":1,"item_id":"m1","text":"可以了。" """),
            "data: [DONE]", ""
        ).joinToString("\r")
        val result = assembleReply(wire.reader().buffered()) {}
        assertEquals(listOf(Output("m1", "可以了。")), result)
    }

    @Test
    fun keepsPartialTextWhenTheStreamDiesOrTheResponseIsIncomplete() {
        val delta = event("response.output_text.delta", """ "item_id":"m1","delta":"只到这里" """)
        for (terminal in listOf("", event("response.incomplete",
            """ "response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}} """))) {
            var draft = ResponseDraft()
            val failure = runCatching {
                assembleReply((delta + terminal).reader().buffered()) { draft = it }
            }
            assertTrue(failure.exceptionOrNull() is ApiFailure)
            assertEquals(ResponseDraft("只到这里", "正在生成回复", "m1"), draft)
        }
    }

    @Test
    fun genericProviderSendsHistoryAndHandlesJsonFallback() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json(
                """{"status":"completed","output":[{"id":"msg_one","type":"message","role":"assistant","content":[{"type":"output_text","text":"The answer."}]}]}"""
            ))
            val settings = settings(server, Provider.RESPONSES)
            val transcript = listOf(
                Message(role = Role.USER, text = "First"),
                Message(role = Role.ASSISTANT, text = "Answer"),
                Message(role = Role.USER, text = "Failed", delivery = Delivery.FAILED),
                Message(role = Role.USER, text = "Follow-up", delivery = Delivery.PENDING)
            )
            assertEquals(listOf(Output("msg_one", "The answer.")),
                ResponsesClient().respond(settings, null, transcript, true) {})
            val request = server.takeRequest(3, TimeUnit.SECONDS)!!
            val sent = JSONObject(request.body.readUtf8())
            val input = sent.getJSONArray("input")
            assertEquals("/gateway/v1/responses", request.path)
            assertEquals("Bearer sample-key", request.getHeader("Authorization"))
            assertFalse(sent.getBoolean("store"))
            assertFalse(sent.has("conversation"))
            assertTrue(sent.getString("instructions").contains("通话"))
            assertEquals(listOf("First", "Answer", "Follow-up"),
                (0 until input.length()).map { input.getJSONObject(it).getString("content") })
        }
    }

    @Test
    fun pipiclawUsesOneConversationAndStopsAtAnUnfinishedItem() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"id":"pipiclaw"}"""))
            server.enqueue(json("""{"id":"conv_one"}"""))
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setChunkedBody(
                event("response.output_text.delta", """ "item_id":"m1","delta":"你好" """) +
                    event("response.completed",
                        """ "response":{"status":"completed","output":[{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":"你好。"}]}]} """), 5
            ))
            server.enqueue(json("""
                {"has_more":true,"data":[
                  {"id":"m1","type":"message","role":"assistant","phase":"final_answer","status":"completed",
                   "content":[{"type":"output_text","text":"你好。"}]},
                  {"id":"m2","type":"message","role":"assistant","status":"in_progress"},
                  {"id":"m3","type":"message","role":"assistant","phase":"final_answer","status":"completed",
                   "content":[{"type":"output_text","text":"后台结果"}]}
                ]}
            """.trimIndent()))
            val client = ResponsesClient()
            val settings = settings(server, Provider.PIPICLAW)
            client.check(settings)
            val id = client.createConversation(settings)
            val result = client.respond(settings, id, listOf(Message(role = Role.USER, text = "你好")), false) {}
            val page = client.items(settings, id, "previous")
            assertEquals(listOf(Output("m1", "你好。")), result)
            assertEquals(ConversationPage(result, "m1", false), page)
            assertEquals("/gateway/v1/models/pipiclaw", server.takeRequest().path)
            assertEquals("/gateway/v1/conversations", server.takeRequest().path)
            val response = JSONObject(server.takeRequest().body.readUtf8())
            assertEquals("conv_one", response.getString("conversation"))
            assertEquals("你好", response.getString("input"))
            assertFalse(response.has("store"))
            assertEquals("/gateway/v1/conversations/conv_one/items?order=asc&limit=50&after=previous",
                server.takeRequest().path)
        }
    }

    @Test
    fun refusesRedirectAndCancelsAnUnresponsiveRequest() = runBlocking {
        MockWebServer().use { server ->
            val settings = settings(server, Provider.RESPONSES)
            val client = ResponsesClient()
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", server.url("/other")))
            val error = runCatching { client.check(settings) }.exceptionOrNull() as ApiFailure
            assertEquals(302, error.status)
            assertEquals("/gateway/v1/responses", server.takeRequest(3, TimeUnit.SECONDS)?.path)
            assertNull(server.takeRequest(100, TimeUnit.MILLISECONDS))

            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val pending = async { client.check(settings) }
            kotlinx.coroutines.yield()
            assertEquals("/gateway/v1/responses", server.takeRequest(3, TimeUnit.SECONDS)?.path)
            pending.cancelAndJoin()
            assertTrue(pending.isCancelled)
        }
    }

    @Test
    fun isolatedPipiclawRunsTwoTurnsInOneConversation() = runBlocking {
        val address = System.getenv("TURNLINE_TEST_PIPICLAW_URL")
        val key = System.getenv("TURNLINE_TEST_PIPICLAW_KEY")
        assumeTrue(address != null && key != null)
        val settings = ServiceSettings(Provider.PIPICLAW, responsesUrl(requireNotNull(address)),
            "pipiclaw", requireNotNull(key))
        val client = ResponsesClient()
        client.check(settings)
        val id = client.createConversation(settings)
        val replies = listOf("/status", "/tasks").flatMap { command ->
            client.respond(settings, id, listOf(Message(role = Role.USER, text = command)), false) {}
        }
        val page = client.items(settings, id, null)
        assertEquals(2, replies.size)
        assertEquals(replies, page.messages)
    }

    private fun settings(server: MockWebServer, provider: Provider) =
        ServiceSettings(provider, responsesUrl(server.url("/gateway/v1").toString()),
            if (provider == Provider.PIPICLAW) "pipiclaw" else "sample-model", "sample-key")

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)

    private fun event(type: String, fields: String): String =
        "data: {\"type\":\"$type\",$fields}\n\n"
}
