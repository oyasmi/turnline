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

enum class RecognitionSource(val label: String) {
    OFFLINE("仅离线"),
    SYSTEM("系统识别")
}

enum class SpeechOutput(val label: String) {
    SYSTEM("系统播报"),
    MATCHA("Matcha · 中英双语")
}

enum class ReadingMode(val label: String) {
    LIVE("边生成边播报"),
    CONFIRMED("完整后播报")
}

enum class SpeechRate(val label: String, val value: Float) {
    SLOW("0.9x", 0.9f),
    NORMAL("1.0x", 1.0f),
    FAST("1.07x", 1.07f),
    FASTER("1.15x", 1.15f)
}

enum class ThemeMode(val label: String) {
    SYSTEM("跟随系统"),
    LIGHT("浅色"),
    DARK("深色")
}

data class ServiceSettings(
    val provider: Provider,
    val url: HttpUrl,
    val model: String,
    val key: String,
    val language: SpeechLanguage = SpeechLanguage.CHINESE,
    val recognitionSource: RecognitionSource = RecognitionSource.OFFLINE,
    val speechOutput: SpeechOutput = SpeechOutput.SYSTEM,
    val readingMode: ReadingMode = ReadingMode.LIVE,
    val speechRate: SpeechRate = SpeechRate.NORMAL,
    val customInstructions: String = "",
    val themeMode: ThemeMode = ThemeMode.SYSTEM
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
    val remoteId: String? = null,
    val timestamp: Long = 0L
)

data class Output(val id: String?, val text: String)

const val MAX_INPUT = 12_000
const val MAX_CUSTOM_INSTRUCTIONS = 3_000
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

private val BACKCHANNEL_PUNCTUATION = Regex("[\\s，。,.、…]+")
private val BACKCHANNEL_PATTERN = Regex("^(?:[嗯唔哦噢喔啊ん]{1,3}|(?:うー?ん){1,3})$")

fun isBackchannel(text: String): Boolean {
    val stem = text.replace(BACKCHANNEL_PUNCTUATION, "")
    return stem.isEmpty() || BACKCHANNEL_PATTERN.matches(stem)
}

fun buildVoiceInstructions(custom: String = "", interruption: String = ""): String =
    listOf(VOICE_INSTRUCTIONS, custom.trim(), interruption.trim())
        .filter { it.isNotEmpty() }
        .joinToString("\n")

const val VOICE_INSTRUCTIONS = """你正在和用户实时通话。用用户当前使用的语言，像电话里说话一样回答。

第一句给最有用的信息：结论、下一步，或者已确认的状态。把第一句写成能独立听懂的短句，用句号或问号收尾。平常一到三句，说完把话权交给用户。对方追问时再展开。

使用可直接朗读的纯文本和自然标点。把条目说成短句，把复杂细节压缩成口头摘要。保留影响理解的数字、单位、版本和专名。遇到长命令、路径、链接或代码，先解释用途，再问用户是否要切到文字查看。

能直接回答就直接回答。必须核实或执行时，只说有用的进展。区分准备做、正在做和已完成。耗时工作适合交给后台时，可以安排可追踪的任务，确认实际创建后再告诉用户。需要澄清时，一次只问一个能决定下一步的问题。

用户可能在任意一句中间插话。优先回应他刚说的话。收到播报停点时，以已播到的那段文字为准。用户说“接着说”，就从那里往下讲；用户改了方向，就跟随新方向。如实说明已经执行的操作。

语音转写里的名字、数字或命令有歧义时，先用最短的一句话核对关键词。确认前不要搜索猜测的人名或执行猜测的命令。简单问候和确认只说一句。磁盘容量用口语读出，路径可以放在文字记录。"""
