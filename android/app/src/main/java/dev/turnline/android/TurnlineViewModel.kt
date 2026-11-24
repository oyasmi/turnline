package dev.turnline.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class CallStage { OFF, LISTENING, TRANSCRIBING, WAITING, SPEAKING, PAUSED }

data class TurnlineState(
    val loading: Boolean = true,
    val settings: ServiceSettings? = null,
    val serviceScope: String? = null,
    val conversation: Conversation = Conversation(),
    val history: List<Conversation> = emptyList(),
    val messages: List<Message> = emptyList(),
    val draft: ResponseDraft? = null,
    val activeTurn: String? = null,
    val reachable: Boolean = false,
    val call: CallStage = CallStage.OFF,
    val partialSpeech: String = "",
    val level: Float = 0f,
    val reading: String? = null,
    val notice: String? = null,
    val recoverText: String? = null
) {
    val busy: Boolean get() = activeTurn != null
    val inCall: Boolean get() = call != CallStage.OFF
}

class TurnlineViewModel(application: Application) : AndroidViewModel(application) {
    private val store = TurnlineStore(application)
    private val api = ResponsesClient()
    private val speech = DeviceSpeech(application)
    private val mutable = MutableStateFlow(TurnlineState())
    val state = mutable.asStateFlow()
    private val current: TurnlineState get() = mutable.value
    private var turnJob: Job? = null
    private var pollJob: Job? = null
    private var listenJob: Job? = null
    private var foreground = false
    private var callId = 0L
    private var silenceCount = 0

    init {
        viewModelScope.launch {
            try {
                val initial = withContext(Dispatchers.IO) {
                    store.recoverPending()
                    val settings = store.settings()
                    if (settings == null) TurnlineState(loading = false) else restored(settings)
                }
                mutable.value = initial
                refreshPolling()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                update { it.copy(loading = false, notice = "无法读取本机设置或历史。请重新配置服务。") }
            }
        }
    }

    private fun restored(settings: ServiceSettings): TurnlineState {
        val scope = store.scope(settings)
        val history = store.conversations(scope)
        val previous = store.lastThread(scope)
        val conversation = history.find { it.id == previous }
            ?: if (previous == null) history.firstOrNull() ?: Conversation() else Conversation()
        return TurnlineState(
            loading = false, settings = settings, serviceScope = scope, history = history,
            conversation = conversation, messages = if (conversation.title.isEmpty()) emptyList() else store.messages(conversation.id)
        )
    }

    suspend fun testConnection(settings: ServiceSettings) = api.check(settings)

    suspend fun saveSettings(settings: ServiceSettings, tested: Boolean) {
        val sameService = current.settings?.sameService(settings) == true
        if (sameService) {
            persistSettings(settings)
            update { it.copy(settings = settings, reachable = tested || it.reachable, notice = null) }
            refreshPolling()
            return
        }
        endCall()
        stopReading()
        update { it.copy(loading = true) }
        pollJob?.cancelAndJoin()
        try {
            turnJob?.cancelAndJoin()
            val next = withContext(Dispatchers.IO) {
                val restored = restored(settings)
                store.saveSettings(settings)
                restored
            }
            mutable.value = next.copy(reachable = tested)
        } catch (error: Exception) {
            update { it.copy(loading = false) }
            if (error is CancellationException) throw error
            throw IllegalStateException("无法保存设置。请检查设备存储后重试。", error)
        } finally {
            refreshPolling()
        }
    }

    private suspend fun persistSettings(settings: ServiceSettings) {
        try {
            withContext(Dispatchers.IO) { store.saveSettings(settings) }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            throw IllegalStateException("无法保存设置。请检查设备存储后重试。", error)
        }
    }

    fun setForeground(active: Boolean) {
        foreground = active
        if (!active) {
            endCall()
            stopReading()
        }
        refreshPolling()
    }

    fun selectConversation(conversation: Conversation = Conversation()) {
        val scope = current.serviceScope ?: return
        if (current.loading || current.conversation.id == conversation.id) return
        endCall()
        stopReading()
        update { it.copy(loading = true, notice = null, recoverText = null) }
        viewModelScope.launch {
            try {
                pollJob?.cancelAndJoin()
                turnJob?.cancelAndJoin()
                val (selected, messages, history) = withContext(Dispatchers.IO) {
                    val recent = store.conversations(scope)
                    val refreshed = recent.find { it.id == conversation.id } ?: conversation
                    store.rememberThread(scope, refreshed.id.takeIf { refreshed.title.isNotEmpty() })
                    Triple(refreshed, store.messages(refreshed.id), recent)
                }
                update { it.copy(loading = false, conversation = selected, messages = messages, history = history) }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                update { it.copy(loading = false, notice = "无法打开本机对话。") }
            } finally {
                refreshPolling()
            }
        }
    }

    fun deleteConversation(conversation: Conversation) {
        val scope = current.serviceScope ?: return
        if (current.busy || current.loading) return
        val selected = current.conversation.id == conversation.id
        if (selected) {
            endCall()
            stopReading()
        }
        update { it.copy(loading = true) }
        viewModelScope.launch {
            try {
                pollJob?.cancelAndJoin()
                val recent = withContext(Dispatchers.IO) {
                    store.delete(conversation.id)
                    if (selected) store.rememberThread(scope, null)
                    store.conversations(scope)
                }
                update {
                    if (selected) it.copy(loading = false, history = recent, conversation = Conversation(),
                        messages = emptyList(), notice = null, recoverText = null)
                    else it.copy(loading = false, history = recent)
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                update { it.copy(loading = false, notice = "无法删除本机对话。") }
            } finally {
                refreshPolling()
            }
        }
    }

    fun send(value: String, voice: Boolean = false): Boolean {
        val settings = current.settings ?: return false
        val scope = current.serviceScope ?: return false
        val text = value.trim()
        if (current.busy || current.loading || text.isBlank() || text.length > MAX_INPUT) return false
        listenJob?.cancel()
        speech.cancelRecognition()
        stopReading()
        val user = Message(role = Role.USER, text = text, delivery = Delivery.PENDING)
        val existing = current.conversation
        val thread = if (existing.title.isNotEmpty()) existing else existing.copy(title = titleFrom(text))
        val messages = (current.messages + user).takeLast(TRANSCRIPT_LIMIT)
        val voiceSession = callId.takeIf { voice && current.inCall }
        val latest = AtomicReference(ResponseDraft())
        update {
            it.copy(conversation = thread, messages = messages, activeTurn = user.id, draft = ResponseDraft(),
                call = if (it.inCall) CallStage.WAITING else CallStage.OFF,
                partialSpeech = "", level = 0f, notice = null, recoverText = null)
        }

        turnJob = viewModelScope.launch {
            var stored = false
            var finished = false
            var answers = emptyList<Message>()
            var result = Delivery.FAILED
            var issue: String? = null
            try {
                pollJob?.cancelAndJoin()
                withContext(Dispatchers.IO + NonCancellable) {
                    store.startTurn(scope, thread, user, System.currentTimeMillis())
                    store.rememberThread(scope, thread.id)
                    stored = true
                }
                val remoteId = if (!settings.usesConversation) null else thread.remoteId ?: run {
                    val created = api.createConversation(settings)
                    withContext(Dispatchers.IO + NonCancellable) { store.setRemoteId(thread.id, created) }
                    update { it.copy(conversation = it.conversation.copy(remoteId = created)) }
                    created
                }
                answers = api.respond(settings, remoteId, messages, voice) { draft ->
                    latest.set(draft)
                    viewModelScope.launch {
                        if (current.activeTurn == user.id) update { it.copy(draft = draft, reachable = true) }
                    }
                }.map { output ->
                    Message(role = Role.ASSISTANT, text = output.text,
                        remoteId = output.id.takeIf { settings.usesConversation })
                }
                result = Delivery.COMPLETE
                finished = true
            } catch (error: CancellationException) {
                result = Delivery.STOPPED
                throw error
            } catch (error: Exception) {
                issue = when {
                    !stored -> "无法将消息保存到手机。"
                    error is ApiFailure && error.status == 404 && thread.remoteId != null ->
                        "服务找不到这段会话。可以新建对话后继续。"
                    error is ApiFailure -> error.message
                    else -> "本轮处理失败，请重试。"
                }
            } finally {
                if (!finished) {
                    val partial = latest.get()
                    answers = if (partial.text.isBlank()) emptyList() else listOf(
                        Message(role = Role.ASSISTANT, text = partial.text, delivery = result,
                            remoteId = partial.itemId.takeIf { settings.usesConversation })
                    )
                }
                var history = current.history
                var saveIssue: String? = null
                if (stored) {
                    withContext(NonCancellable + Dispatchers.IO) {
                        try {
                            store.finishTurn(thread.id, user.id, result, answers)
                            history = store.conversations(scope)
                        } catch (_: Exception) {
                            saveIssue = "本轮未能写入本机历史。"
                        }
                    }
                }
                if (current.activeTurn == user.id) {
                    val transcript = (messages.dropLast(1) + user.copy(delivery = result) + answers)
                        .takeLast(TRANSCRIPT_LIMIT)
                    update {
                        it.copy(messages = transcript, history = history, activeTurn = null, draft = null,
                            reachable = finished || (issue == null && it.reachable),
                            notice = saveIssue ?: issue, recoverText = text.takeIf { result == Delivery.FAILED })
                    }
                    val automatic = finished && current.inCall && voiceSession == callId && foreground
                    if (automatic) {
                        play(answers.joinToString("\n\n") { it.text }, CALL_PLAYBACK)
                    } else if (current.inCall) {
                        if (issue != null || saveIssue != null) update { it.copy(call = CallStage.PAUSED) }
                        else scheduleListening(300)
                    }
                    refreshPolling()
                }
            }
        }
        return true
    }

    fun stopResponse() {
        turnJob?.cancel()
    }

    fun startCall() {
        if (!foreground || current.settings == null || current.inCall || current.loading) return
        stopReading()
        callId++
        silenceCount = 0
        update { it.copy(call = CallStage.WAITING, notice = null) }
        if (!current.busy) scheduleListening(0)
    }

    fun endCall() {
        if (!current.inCall) return
        callId++
        listenJob?.cancel()
        speech.cancelRecognition()
        stopReading()
        update { it.copy(call = CallStage.OFF, partialSpeech = "", level = 0f) }
    }

    fun callAction() {
        when (current.call) {
            CallStage.LISTENING, CallStage.TRANSCRIBING -> {
                listenJob?.cancel()
                speech.cancelRecognition()
                update { it.copy(call = CallStage.PAUSED, partialSpeech = "", level = 0f) }
            }
            CallStage.WAITING -> {
                if (current.busy) stopResponse()
                else {
                    listenJob?.cancel()
                    update { it.copy(call = CallStage.PAUSED) }
                }
            }
            CallStage.SPEAKING -> {
                stopReading()
                update { it.copy(call = CallStage.WAITING) }
                scheduleListening(320)
            }
            CallStage.PAUSED -> {
                silenceCount = 0
                update { it.copy(notice = null) }
                scheduleListening(0)
            }
            CallStage.OFF -> Unit
        }
    }

    private fun scheduleListening(ms: Long) {
        val settings = current.settings ?: return
        if (!foreground || !current.inCall || current.busy || current.loading) return
        listenJob?.cancel()
        val session = callId
        listenJob = viewModelScope.launch {
            delay(ms)
            if (callId != session || !current.inCall || current.busy || !foreground) return@launch
            update { it.copy(call = CallStage.LISTENING, level = 0f, partialSpeech = "") }
            speech.listen(settings,
                onText = { text -> update { it.copy(partialSpeech = text) } },
                onLevel = { level -> update { it.copy(level = level) } },
                onTranscribing = { update { it.copy(call = CallStage.TRANSCRIBING) } }
            ) { heard ->
                if (callId != session || !current.inCall) return@listen
                when (heard) {
                    is Heard.Text -> {
                        val stem = heard.value.replace(Regex("[\\s，。,.、…]+"), "")
                        if (stem.matches(Regex("[嗯唔哦噢喔啊]{1,3}"))) {
                            repeatAfterSilence()
                            return@listen
                        }
                        silenceCount = 0
                        send(heard.value, voice = true)
                    }
                    Heard.Silence -> repeatAfterSilence()
                    is Heard.Problem -> update {
                        it.copy(call = CallStage.PAUSED, partialSpeech = "", level = 0f, notice = heard.message)
                    }
                }
            }
        }
    }

    private fun repeatAfterSilence() {
        silenceCount++
        if (silenceCount >= 3) {
            update { it.copy(call = CallStage.PAUSED, partialSpeech = "", level = 0f) }
        } else {
            scheduleListening(400L * silenceCount)
        }
    }

    fun readMessage(message: Message) {
        if (current.inCall || current.loading) return
        if (current.reading == message.id) stopReading() else play(message.text, message.id)
    }

    private fun play(text: String, id: String) {
        val settings = current.settings ?: return
        val call = current.inCall
        val session = callId
        if (call) {
            listenJob?.cancel()
            speech.cancelRecognition()
        }
        update { it.copy(reading = id, call = if (call) CallStage.SPEAKING else CallStage.OFF, level = 0f) }
        speech.speak(text, settings.language) { error ->
            val shouldListen = call && callId == session && current.inCall
            update {
                it.copy(reading = null, notice = error ?: it.notice,
                    call = if (!shouldListen) it.call else if (error == null) CallStage.WAITING else CallStage.PAUSED)
            }
            if (shouldListen && error == null) scheduleListening(300)
        }
    }

    private fun stopReading() {
        speech.stopSpeaking()
        if (current.reading != null) update { it.copy(reading = null) }
    }

    private fun refreshPolling() {
        pollJob?.cancel()
        val settings = current.settings ?: return
        val scope = current.serviceScope ?: return
        val thread = current.conversation
        val remoteId = thread.remoteId ?: return
        if (!foreground || !settings.usesConversation || current.loading || current.busy) return

        pollJob = viewModelScope.launch {
            var cursor = thread.cursor
            var gap = 2_000L
            while (isActive) {
                delay(gap)
                try {
                    val page = api.items(settings, remoteId, cursor)
                    val changed = page.messages.isNotEmpty() || page.cursor != cursor
                    if (current.conversation.id != thread.id || current.busy) return@launch
                    if (changed) {
                        val (messages, history) = withContext(Dispatchers.IO) {
                            store.applyPage(thread.id, page)
                            store.messages(thread.id) to store.conversations(scope)
                        }
                        cursor = page.cursor
                        update {
                            it.copy(conversation = it.conversation.copy(cursor = cursor), messages = messages,
                                history = history, reachable = true)
                        }
                    } else if (!current.reachable) {
                        update { it.copy(reachable = true) }
                    }
                    gap = if (page.hasMore) 0 else if (changed) 2_000L else (gap + 1_000L).coerceAtMost(6_000L)
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    if (error is ApiFailure && error.status in setOf(401, 403, 404)) {
                        update { it.copy(reachable = false) }
                        break
                    }
                    gap = 8_000L
                }
            }
        }
    }

    fun clearNotice() = update { it.copy(notice = null, recoverText = null) }

    override fun onCleared() {
        speech.close()
        super.onCleared()
    }

    private fun update(change: (TurnlineState) -> TurnlineState) = mutable.update(change)

    private companion object {
        const val CALL_PLAYBACK = "call"

        fun titleFrom(text: String): String {
            val line = text.lineSequence().first().trim()
            val end = line.offsetByCodePoints(0, minOf(32, line.codePointCount(0, line.length)))
            return if (end == line.length) line else line.substring(0, end) + "…"
        }
    }
}
