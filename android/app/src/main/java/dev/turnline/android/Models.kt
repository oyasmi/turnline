package dev.turnline.android

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.UUID

enum class Provider(val label: String) {
    PIPICLAW("PipiClaw"),
    RESPONSES("Responses API")
}

enum class SpeechLanguage(val label: String, val tag: String) {
    CHINESE("普通话", "zh-CN"),
    ENGLISH("English", "en-US"),
    SYSTEM("跟随系统", "")
}

data class ServiceSettings(
    val provider: Provider,
    val url: HttpUrl,
    val model: String,
    val key: String,
    val language: SpeechLanguage = SpeechLanguage.CHINESE,
    val localRecognition: Boolean = true
) {
    val usesConversation: Boolean get() = provider == Provider.PIPICLAW

    fun sameService(other: ServiceSettings): Boolean =
        provider == other.provider && url == other.url && model == other.model && key == other.key
}

fun responsesUrl(raw: String): HttpUrl {
    val value = raw.trim()
    require(value.startsWith("http://", ignoreCase = true) || value.startsWith("https://", ignoreCase = true)) {
        "请输入以 http:// 或 https:// 开头的服务地址。"
    }
    val url = value.toHttpUrlOrNull()
        ?: throw IllegalArgumentException("请输入以 http:// 或 https:// 开头的服务地址。")
    require(url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null) {
        "请把密钥填在密钥栏，服务地址只填写协议、主机、端口和路径。"
    }
    val path = url.encodedPath.trimEnd('/')
    val endpoint = when {
        path.isEmpty() -> "/v1/responses"
        path.endsWith("/responses") -> path
        else -> "$path/responses"
    }
    return url.newBuilder().encodedPath(endpoint).build()
}

data class Conversation(
    val id: String = UUID.randomUUID().toString(),
    val title: String = "",
    val remoteId: String? = null,
    val cursor: String? = null
)

enum class Delivery { PENDING, COMPLETE, STOPPED, FAILED }
enum class Role(val wire: String) { USER("user"), ASSISTANT("assistant") }

data class Message(
    val id: String = UUID.randomUUID().toString(),
    val role: Role,
    val text: String,
    val delivery: Delivery = Delivery.COMPLETE,
    val remoteId: String? = null
)

data class Output(val id: String?, val text: String)

const val MAX_INPUT = 12_000
const val TRANSCRIPT_LIMIT = 300

fun contextFor(messages: List<Message>): List<Message> {
    val eligible = messages.filter { it.delivery == Delivery.COMPLETE || it.delivery == Delivery.PENDING }
    val context = mutableListOf<Message>()
    var remaining = 36_000
    for (message in eligible.asReversed().take(24)) {
        val entry = if (message.role == Role.ASSISTANT && message.text.length > MAX_INPUT) {
            message.copy(text = contextExcerpt(message.text))
        } else message
        if (entry.text.length > remaining) break
        context += entry
        remaining -= entry.text.length
    }
    return context.asReversed().dropWhile { it.role == Role.ASSISTANT }
}

private fun contextExcerpt(text: String): String {
    val marker = "\n[…]\n"
    val side = (MAX_INPUT - marker.length) / 2
    val headEnd = if (text[side - 1].isHighSurrogate()) side - 1 else side
    val tailStart = text.length - side
    val tail = if (text[tailStart].isLowSurrogate()) tailStart + 1 else tailStart
    return text.substring(0, headEnd) + marker + text.substring(tail)
}

const val VOICE_INSTRUCTIONS = """你正在和用户通话。用用户当前使用的语言自然地说话，第一句先说结论、下一步或已确认的状态。平常回答一到三句，使用可直接朗读的纯文本。保留关键数字、单位和专名；遇到长命令、路径或代码，可以问用户是否要切到文字查看。语音转写里的名字、数字或命令有歧义时，先核对关键词。耗时工作如实说明进度。"""
