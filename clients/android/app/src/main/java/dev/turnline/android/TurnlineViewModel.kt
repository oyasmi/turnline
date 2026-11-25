package dev.turnline.android

import android.app.Application
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
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
    val callStartedAt: Long? = null,
    val partialSpeech: String = "",
    val level: Float = 0f,
    val reading: String? = null,
    val notice: String? = null,
    val recoverText: String? = null,
    val settingsSaving: Boolean = false,
    val settingsSaved: Boolean = false,
    val settingsSaveError: String? = null
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
    private var activeResponseId: String? = null
    private var pendingInterruption: String = ""
    private var activeSpokenPhrase: String? = null
    private var lastCompletedPhrase: String? = null

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

    fun saveSettings(settings: ServiceSettings, tested: Boolean) {
        if (current.loading || current.settingsSaving) return
        val sameService = current.settings?.sameService(settings) == true
        update { it.copy(loading = !sameService, settingsSaving = true, settingsSaveError = null) }
        viewModelScope.launch {
            try {
                if (!sameService) {
                    stopAudio()
                    pollJob?.cancelAndJoin()
                    turnJob?.cancelAndJoin()
                    pendingInterruption = ""
                }
                val next = withContext(Dispatchers.IO) {
                    val restored = if (sameService) null else restored(settings)
                    store.saveSettings(settings)
                    restored
                }
                update {
                    if (next == null) it.copy(settings = settings, reachable = tested || it.reachable,
                        settingsSaving = false, settingsSaved = true, notice = null)
                    else next.copy(reachable = tested, settingsSaved = true)
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                update { it.copy(loading = false, settingsSaving = false,
                    settingsSaveError = "无法保存设置。请检查设备存储后重试。") }
            } finally {
                refreshPolling()
            }
        }
    }

    fun clearSettingsResult() = update { it.copy(settingsSaved = false, settingsSaveError = null) }

    fun setForeground(active: Boolean) {
        foreground = active
        if (!active) stopAudio()
        refreshPolling()
    }

    fun stopAudio() {
        if (current.inCall) endCall() else stopReading()
    }

    fun selectConversation(conversation: Conversation = Conversation()) {
        val scope = current.serviceScope ?: return
        if (current.loading || current.conversation.id == conversation.id) return
        stopAudio()
        pendingInterruption = ""
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

    fun deleteConversation(conversation: Conversation, deleteRemote: Boolean = false) {
        val scope = current.serviceScope ?: return
        val settings = current.settings
        if (current.busy || current.loading) return
        val selected = current.conversation.id == conversation.id
        if (selected) {
            stopAudio()
            pendingInterruption = ""
        }
        update { it.copy(loading = true) }
        viewModelScope.launch {
            try {
                pollJob?.cancelAndJoin()
                if (deleteRemote && settings?.usesConversation == true && conversation.remoteId != null) {
                    runCatching { api.deleteConversation(settings, conversation.remoteId) }
                }
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

    fun retryLastTurn(): Boolean = send("请重新回答上一条问题。", voice = current.inCall)

    fun send(value: String, voice: Boolean = false): Boolean {
        val settings = current.settings ?: return false
        val scope = current.serviceScope ?: return false
        val text = value.trim()
        if (current.busy || current.loading || text.isBlank() || text.length > MAX_INPUT) return false
        listenJob?.cancel()
        speech.cancelRecognition()
        stopReading()
        val now = System.currentTimeMillis()
        val user = Message(role = Role.USER, text = text, delivery = Delivery.PENDING, timestamp = now)
        val existing = current.conversation
        val isFirstMessage = existing.title.isEmpty()
        val thread = if (!isFirstMessage) existing else existing.copy(title = titleFrom(text))
        val messages = (current.messages + user).takeLast(TRANSCRIPT_LIMIT)
        val voiceSession = callId.takeIf { voice && current.inCall }
        val useLiveReading = voiceSession != null && settings.readingMode == ReadingMode.LIVE
        val interruptionContext = if (voice) pendingInterruption else ""
        pendingInterruption = ""
        activeSpokenPhrase = null
        lastCompletedPhrase = null
        activeResponseId = null
        val latest = AtomicReference(ResponseDraft())
        update {
            it.copy(conversation = thread, messages = messages, activeTurn = user.id, draft = ResponseDraft(),
                call = if (it.inCall) CallStage.WAITING else CallStage.OFF,
                partialSpeech = "", level = 0f, notice = null, recoverText = null)
        }

        turnJob = viewModelScope.launch {
            var stored = false
            var answers = emptyList<Message>()
            var result = Delivery.FAILED
            var issue: String? = null
            var liveStreamId: Long? = null
            var livePending = ""
            var liveConsumed = 0
            var liveSpokenAny = false
            var livePlaybackError: String? = null
            var livePlaybackDone = false

            fun startLiveStreamIfNeeded(): Long? {
                if (!useLiveReading || voiceSession != callId || !current.inCall || !foreground) return null
                liveStreamId?.let { return it }
                val session = voiceSession
                val streamId = speech.beginSpeechStream(
                    settings = settings,
                    onPhraseStart = { phrase -> activeSpokenPhrase = phrase },
                    onPhraseDone = { phrase ->
                        lastCompletedPhrase = phrase
                        if (activeSpokenPhrase == phrase) activeSpokenPhrase = null
                    },
                    finished = { error ->
                        livePlaybackDone = true
                        livePlaybackError = error
                        val shouldListen = callId == session && current.inCall && !current.busy && foreground && !current.loading
                        update {
                            it.copy(
                                reading = null,
                                notice = error ?: it.notice,
                                call = when {
                                    callId != session || !it.inCall -> it.call
                                    error != null -> CallStage.PAUSED
                                    shouldListen -> CallStage.WAITING
                                    else -> it.call
                                }
                            )
                        }
                        if (shouldListen && error == null) scheduleListening(300)
                    }
                )
                if (streamId != null) {
                    liveStreamId = streamId
                    update { it.copy(reading = CALL_PLAYBACK, call = CallStage.SPEAKING, level = 0f) }
                }
                return streamId
            }

            fun feedLiveSpeech(fullText: String, flush: Boolean) {
                if (!useLiveReading || voiceSession != callId || !current.inCall) return
                if (fullText.length > liveConsumed) {
                    livePending += fullText.substring(liveConsumed)
                    liveConsumed = fullText.length
                }
                if (livePending.isEmpty() && !flush) return
                val split = splitSpeech(livePending, flush = flush, opening = !liveSpokenAny)
                livePending = split.rest
                if (split.phrases.isNotEmpty()) {
                    val streamId = startLiveStreamIfNeeded() ?: return
                    for (phrase in split.phrases) {
                        liveSpokenAny = true
                        speech.enqueueSpeechPhrase(streamId, phrase)
                    }
                }
                if (flush) {
                    val streamId = liveStreamId
                    if (streamId != null) {
                        speech.sealSpeechStream(streamId)
                    }
                }
            }

            try {
                withContext(NonCancellable) {
                    pollJob?.cancelAndJoin()
                    withContext(Dispatchers.IO) {
                        store.startTurn(scope, thread, user, now)
                        store.rememberThread(scope, thread.id)
                    }
                    stored = true
                }
                ensureActive()
                val remoteId = if (!settings.usesConversation) null else thread.remoteId ?: run {
                    val created = api.createConversation(settings, mapOf("source" to "turnline"))
                    withContext(NonCancellable) {
                        withContext(Dispatchers.IO) { store.setRemoteId(thread.id, created) }
                        update { it.copy(conversation = it.conversation.copy(remoteId = created)) }
                    }
                    created
                }
                if (remoteId != null && isFirstMessage && !text.startsWith("/")) {
                    viewModelScope.launch {
                        runCatching {
                            api.updateConversationMetadata(
                                settings,
                                remoteId,
                                mapOf("source" to "turnline", "title" to thread.title)
                            )
                        }
                    }
                }
                ensureActive()
                val voiceInstructions = if (voice) {
                    buildVoiceInstructions(settings.customInstructions, interruptionContext)
                } else null
                answers = api.respond(
                    settings = settings,
                    conversationId = remoteId,
                    messages = messages,
                    voice = voice,
                    instructions = voiceInstructions,
                    background = remoteId != null,
                    onResponseCreated = { createdResponseId -> activeResponseId = createdResponseId }
                ) { draft ->
                    latest.set(draft)
                    viewModelScope.launch {
                        if (current.activeTurn == user.id) {
                            update {
                                it.copy(
                                    draft = draft,
                                    reachable = true,
                                    notice = draft.failureNotice ?: it.notice
                                )
                            }
                            if (useLiveReading && draft.text.isNotBlank()) {
                                feedLiveSpeech(draft.text, flush = false)
                            }
                        }
                    }
                }.map { output ->
                    Message(
                        role = Role.ASSISTANT,
                        text = output.text,
                        remoteId = output.id.takeIf { settings.usesConversation },
                        timestamp = System.currentTimeMillis()
                    )
                }
                result = Delivery.COMPLETE
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
                // Finish the local turn, including the UI update, even when the HTTP call was cancelled.
                withContext(NonCancellable) {
                    activeResponseId = null
                    val complete = result == Delivery.COMPLETE
                    if (!complete) {
                        if (liveStreamId != null) stopReading()
                        answers = latest.get().outputs.map { output ->
                            Message(
                                role = Role.ASSISTANT,
                                text = output.text,
                                delivery = result,
                                remoteId = output.id.takeIf { settings.usesConversation },
                                timestamp = System.currentTimeMillis()
                            )
                        }
                    }
                    var transcript = current.messages.filterNot { it.id == user.id }
                    var history = current.history
                    var saveIssue: String? = null
                    if (stored) {
                        transcript = (transcript + user.copy(delivery = result) + answers).takeLast(TRANSCRIPT_LIMIT)
                        try {
                            val (savedMessages, savedHistory) = withContext(Dispatchers.IO) {
                                store.finishTurn(thread.id, user.id, result, answers)
                                store.messages(thread.id) to store.conversations(scope)
                            }
                            transcript = savedMessages
                            history = savedHistory
                        } catch (_: Exception) {
                            saveIssue = "本轮未能写入本机历史。"
                        }
                    }
                    if (current.activeTurn == user.id) {
                        val combinedText = answers.joinToString("\n\n") { it.text }
                        update {
                            val conversation = if (stored) it.conversation else it.conversation.copy(title = existing.title)
                            it.copy(conversation = conversation,
                                messages = transcript, history = history, activeTurn = null, draft = null,
                                reachable = complete || (issue == null && it.reachable),
                                notice = saveIssue ?: issue ?: livePlaybackError ?: it.notice,
                                recoverText = text.takeIf { result == Delivery.FAILED })
                        }
                        if (current.inCall && foreground && !current.loading) {
                            when {
                                complete && voiceSession == callId && useLiveReading -> {
                                    feedLiveSpeech(combinedText, flush = true)
                                    if (!liveSpokenAny) {
                                        update { it.copy(call = CallStage.WAITING) }
                                        scheduleListening(300)
                                    } else if (livePlaybackDone) {
                                        if (livePlaybackError != null) {
                                            update { it.copy(call = CallStage.PAUSED) }
                                        } else {
                                            update { it.copy(call = CallStage.WAITING) }
                                            scheduleListening(300)
                                        }
                                    }
                                }
                                complete && voiceSession == callId ->
                                    play(combinedText, CALL_PLAYBACK)
                                issue != null || saveIssue != null -> update { it.copy(call = CallStage.PAUSED) }
                                else -> scheduleListening(300)
                            }
                        }
                        refreshPolling()
                    }
                }
            }
        }
        return true
    }

    fun stopResponse() {
        val settings = current.settings
        val responseId = activeResponseId
        if (settings?.usesConversation == true && responseId != null) {
            activeResponseId = null
            viewModelScope.launch {
                runCatching { api.cancelResponse(settings, responseId) }
            }
        }
        turnJob?.cancel()
    }

    fun startCall() {
        if (!foreground || current.settings == null || current.inCall || current.loading) return
        stopReading()
        callId++
        silenceCount = 0
        pendingInterruption = ""
        update {
            it.copy(
                call = CallStage.WAITING,
                callStartedAt = SystemClock.elapsedRealtime(),
                notice = null
            )
        }
        if (!current.busy) scheduleListening(0)
    }

    fun endCall() {
        if (!current.inCall) return
        callId++
        listenJob?.cancel()
        speech.cancelRecognition()
        stopReading()
        pendingInterruption = ""
        activeSpokenPhrase = null
        lastCompletedPhrase = null
        update { it.copy(call = CallStage.OFF, callStartedAt = null, partialSpeech = "", level = 0f) }
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
                recordInterruptionPoint()
                if (current.busy) stopResponse()
                stopReading()
                update { it.copy(call = CallStage.WAITING) }
                scheduleListening(280)
            }
            CallStage.PAUSED -> {
                silenceCount = 0
                update { it.copy(notice = null) }
                scheduleListening(0)
            }
            CallStage.OFF -> Unit
        }
    }

    private fun recordInterruptionPoint() {
        val fragment = activeSpokenPhrase?.trim().orEmpty()
        val last = lastCompletedPhrase?.trim().orEmpty()
        pendingInterruption = when {
            fragment.isNotEmpty() -> "上一轮语音回复在播到「$fragment」附近时被打断。"
            last.isNotEmpty() -> "上一轮语音回复被打断。最后完整播完的一句是「$last」。"
            else -> "上一轮语音回复被打断时，还没有完整播完一句。"
        }
        activeSpokenPhrase = null
        lastCompletedPhrase = null
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
                        if (isBackchannel(heard.value)) {
                            repeatAfterSilence()
                            return@listen
                        }
                        silenceCount = 0
                        if (!send(heard.value, voice = true)) {
                            update { it.copy(call = CallStage.PAUSED, partialSpeech = "", level = 0f) }
                        }
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
        update {
            it.copy(call = if (silenceCount >= 3) CallStage.PAUSED else CallStage.WAITING,
                partialSpeech = "", level = 0f)
        }
        if (silenceCount < 3) scheduleListening(400L * silenceCount)
    }

    fun readMessage(message: Message) {
        if (!foreground || current.inCall || current.loading) return
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
        activeSpokenPhrase = null
        lastCompletedPhrase = null
        fun finished(error: String?) {
            val shouldListen = call && callId == session && current.inCall
            update {
                it.copy(reading = null, notice = error ?: it.notice,
                    call = if (!shouldListen) it.call else if (error == null) CallStage.WAITING else CallStage.PAUSED)
            }
            if (shouldListen && error == null) scheduleListening(300)
        }
        val spoken = speakableText(text)
        if (spoken.none { it.isLetterOrDigit() }) {
            stopReading()
            finished(if (call) null else "这条消息没有可朗读的文字。")
            return
        }
        update { it.copy(reading = id, call = if (call) CallStage.SPEAKING else CallStage.OFF, level = 0f) }
        speech.speak(
            text = spoken,
            settings = settings,
            onPhraseStart = { phrase -> activeSpokenPhrase = phrase },
            onPhraseDone = { phrase ->
                lastCompletedPhrase = phrase
                if (activeSpokenPhrase == phrase) activeSpokenPhrase = null
            },
            finished = ::finished
        )
    }

    private fun stopReading() {
        speech.stopSpeaking()
        if (current.reading != null) update { it.copy(reading = null) }
    }

    private fun refreshPolling() {
        val settings = current.settings
        val scope = current.serviceScope
        val thread = current.conversation
        val remoteId = thread.remoteId
        val previous = pollJob
        if (!foreground || settings?.usesConversation != true || scope == null || remoteId == null ||
            current.loading || current.busy
        ) {
            previous?.cancel()
            return
        }
        if (previous?.isActive == true) return

        pollJob = viewModelScope.launch {
            // A cancelled poll may still be committing its last page.
            withContext(NonCancellable) { previous?.join() }
            var cursor = current.conversation.cursor
            var gap = 2_000L
            while (isActive) {
                delay(gap)
                try {
                    val page = api.items(settings, remoteId, cursor)
                    val changed = page.messages.isNotEmpty() || page.cursor != cursor
                    if (current.conversation.id != thread.id || current.busy) return@launch
                    if (changed) {
                        withContext(NonCancellable) {
                            val (arrived, messages, history) = withContext(Dispatchers.IO) {
                                val added = store.applyPage(thread.id, page)
                                Triple(added, store.messages(thread.id), store.conversations(scope))
                            }
                            cursor = page.cursor
                            update { state ->
                                val pending = state.messages.lastOrNull()?.takeIf { it.id == state.activeTurn }
                                val transcript = if (pending == null) messages else (messages + pending).takeLast(TRANSCRIPT_LIMIT)
                                state.copy(conversation = state.conversation.copy(cursor = cursor), messages = transcript,
                                    history = history, reachable = true)
                            }
                            if (arrived.isNotEmpty() && current.inCall && foreground && !current.busy &&
                                current.reading == null && current.call != CallStage.TRANSCRIBING
                            ) {
                                val summary = updateSpeech(arrived.last().text)
                                if (!summary.isNullOrBlank()) play(summary, CALL_PLAYBACK)
                            }
                        }
                    } else if (!current.reachable) {
                        update { it.copy(reachable = true) }
                    }
                    gap = if (page.hasMore) 0 else if (changed) 2_000L else (gap + 1_000L).coerceAtMost(6_000L)
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    if (error is ApiFailure) update { it.copy(reachable = false) }
                    if (error is ApiFailure && error.status in setOf(401, 403, 404)) {
                        break
                    }
                    gap = 8_000L
                }
            }
        }
    }

    fun clearNotice() = update { it.copy(notice = null, recoverText = null) }

    override fun onCleared() {
        foreground = false
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
