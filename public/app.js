import { clock } from './audio.js';
import { openCallAudio, closeCallAudio } from './call-audio.js';
import { VoiceSession } from './voice-session.js';
import { SpeechPlayer } from './player.js';
import { BargeIn, matchesEcho } from './barge-in.js';
import { callPhase, captureMode, initialCallState, reduceCall } from './call-state.js';
import { announce, clearCaption, renderCall, setIcon, showDraft, showLevel, showWaiting, speakCaption, updateCallTitle } from './call-view.js';
import { bindShortcuts, updateMediaSession, vibrate } from './call-controls.js';
import { ResponseTurn } from './response-turn.js';
import { WaitingFeedback } from './waiting.js';
import { bindConversationHistory, cacheConversationTitle, conversationText, rememberConversation } from './conversation-history.js';
import { ConversationUpdates, updateSpeech } from './conversation-updates.js';
import {
  CALL_INSTRUCTIONS, cancelResponse, checkDirectConnection, createConversation, isBackchannel, isConversationId,
  listConversationItems, normalizeDirectUrl, openResponse, resumeResponse, updateConversationMetadata,
} from './responses.js';
import { ResponsesSocket } from './responses-ws.js';
import { splitSpeech } from './chunker.js';
import { directSettings, preferences, saveDirectSettings, savePreferences, store, stored } from './settings.js';
import { Transcript } from './transcript.js';
import { CallTrace } from './call-trace.js';

const $ = id => document.getElementById(id);
const metrics = {
  asr: $('metric-asr'),
  feedback: $('metric-feedback'),
  created: $('metric-created'),
  reasoning: $('metric-reasoning'),
  firstMessage: $('metric-first-message'),
  firstTool: $('metric-first-tool'),
  text: $('metric-text'),
  endpointToRequest: $('metric-endpoint-request'),
  audio: $('metric-audio'),
  perceived: $('metric-perceived'),
  silenceWait: $('metric-silence-wait'),
  partialLag: $('metric-partial-lag'),
  interruption: $('metric-interruption'),
  backendQueue: $('metric-backend-queue'),
  textWait: $('metric-text-wait'),
  speakable: $('metric-speakable'),
  queue: $('metric-queue'),
  synthesis: $('metric-synthesis'),
  pcm: $('metric-pcm'),
  gaps: $('metric-gaps'),
};
const transcript = new Transcript($('messages'), $('empty'), {
  error: showError,
  replay: replayMessage,
  retry: () => { void send('请重新回答上一条问题。'); },
}, $('scroll-bottom'));
const field = $('message');
const dialog = $('settings');
const diagnostics = $('diagnostics');
const ACTIVE_CONVERSATION = 'turnline.active-conversation.v1';
const directMode = location.pathname === '/direct';
const directDialog = $('direct-settings');
const authDialog = $('auth-dialog');
const relay = { mode: 'relay', url: '/api/pipiclaw/v1', model: 'pipiclaw', context: 'conversation' };

let settings = {
  ...preferences(), ...relay, ...(directMode ? directSettings() : {}),
};
let connection = 'checking';
let connectionDetail;
let connectionGeneration = 0;
let relayAvailable = false;
let authMode = 'none';
let authCooldownTimer;
let conversation;
let conversationTitled = false;
let opening;
let updates;
let responsesSocket;
let pendingSteer;
let pendingUpdates = [];
let call;
let turn;
let state = initialCallState;
let readyModels = false;
let interruption = '';
let history = [];
let voiceQueue = [];
let previousCommit;
let previousOutput;
let inputTelemetry;
let expectingAnswer = false;
let held = false;
let releasing = false;
let textOnly = false;
let activeRange;
let replay;
let signalQuality;
let poorSince;
let warmTimer;
const smallScreen = matchMedia('(max-width: 760px)');

const trace = new CallTrace({ getItem: stored, setItem: store }, (count, available) => {
  $('export-timing').disabled = !available;
  $('trace-count').textContent = count ? '已记录 ' + count + ' 轮' : '暂无通话计时';
});
const voice = new VoiceSession(onVoice);
const player = new SpeechPlayer(voice, onPlayback);
const barge = new BargeIn(player, onBarge);
const waiting = new WaitingFeedback((stage, tool, toolLabel) => {
  showWaiting(stage, tool, toolLabel);
  render();
}, () => {
  if (settings.tones && settings.waitingTone && call?.ready && turn?.voice && state.input === 'quiet' &&
      state.connection === 'ready' && !state.muted && !held && !releasing) player.tone('waiting');
}, () => player.stopTone('waiting'));

function dispatch(event) {
  const [next, effects] = reduceCall(state, event);
  state = next;
  for (const effect of effects) {
    if (effect === 'capture') voice.capture(captureMode(state, settings.duplex), event.tailAt);
    if (effect === 'drain') queueMicrotask(drainWaiting);
  }
  if (effects.length) render();
}

function showError(message, location = $('error')) {
  location.textContent = message ?? '';
  location.hidden = !message;
  if (location.id === 'error') render();
}

function showMetric(name, value) {
  (metrics[name] ?? $('metric-' + name)).textContent = value === undefined ? '—' : Math.max(0, Math.round(value)) + ' ms';
}

function renderModelStatus() {
  $('models').textContent = readyModels ? 'SenseVoice · Matcha 已就绪' : 'SenseVoice · Matcha';
}

function setMetric(current, name, value) {
  trace.metric(current.traceItem, name, value);
  if (turn === current) showMetric(name, value);
}

function renderConnection() {
  const { label, detail } = {
    checking: { label: '正在连接', detail: '正在检查连接。' },
    ready: { label: 'PipiClaw 已连接', detail: '' },
    setup: { label: '等待设置', detail: '填写你自己的 PipiClaw 地址和 Key。' },
    locked: { label: '需要验证', detail: '请输入访问口令以解锁当前设备。' },
    offline: { label: 'PipiClaw 离线', detail: '请启动 PipiClaw，再重试连接。' },
    demo: { label: '离线演示', detail: '' },
  }[connection];
  $('backend-label').dataset.connection = connection;
  $('backend-label').lastChild.textContent = label;
  $('connection-panel').hidden = !detail;
  $('connection-detail').textContent = connectionDetail ?? detail;
  $('retry-connection').hidden = connection !== 'offline';
  $('unlock-auth').hidden = connection !== 'locked';
  $('logout-auth').hidden = authMode !== 'passcode' || connection === 'locked';
  $('setup-direct').hidden = !directMode || !['setup', 'offline'].includes(connection);
  $('edit-direct').hidden = !directMode;
  $('switch-mode').hidden = !relayAvailable || connection === 'locked';
  $('switch-mode').href = directMode ? '/' : '/direct';
  $('switch-mode').textContent = directMode ? '服务端中转' : '浏览器直连';
  $('open-conversations').hidden = connection !== 'ready' || settings.context !== 'conversation';
  render();
}

function canCall() { return connection === 'ready' || connection === 'demo'; }

function watchConversation(id, cursor) {
  updates?.stop();
  updates = new ConversationUpdates(settings, id, () => !turn || turn.ended, showConversationUpdate, cursor);
}

function showRestoredConversation(id, page) {
  conversation = id;
  conversationTitled = page.data.length > 0;
  store(conversationKey(), id);
  rememberConversation(settings, id);
  let lastAnswer;
  for (const item of page.data.slice().reverse()) {
    if (item?.type !== 'message' || item.status !== 'completed') continue;
    const text = conversationText(item);
    if (text && (item.role === 'user' || item.phase === 'final_answer')) {
      const time = item.created_at == null ? null : new Date(typeof item.created_at === 'number' ? item.created_at * 1000 : item.created_at);
      const row = transcript.add(item.role === 'user' ? 'user' : 'assistant', text, time);
      lastAnswer = item.role === 'assistant' ? row : undefined;
    }
  }
  transcript.retryFor(lastAnswer);
  watchConversation(id, page.data.find(item => item?.id && item.status !== 'in_progress')?.id);
}

async function restoreConversation(generation) {
  const key = conversationKey();
  const id = stored(key);
  if (!isConversationId(id) || conversation) return;
  try {
    const page = await listConversationItems(settings, id, undefined, AbortSignal.timeout(5_000), 'desc');
    if (generation !== connectionGeneration || conversation || opening || stored(key) !== id) return;
    showRestoredConversation(id, page);
  } catch (error) {
    if (generation === connectionGeneration && !conversation && stored(key) === id && error.status === 404) store(key);
  }
}

async function selectConversation(id, signal) {
  const generation = connectionGeneration;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
  const page = await listConversationItems(settings, id, undefined, deadline, 'desc');
  if (signal.aborted) return;
  if (deadline.aborted) throw new Error('打开会话超时，请重试。');
  if (generation !== connectionGeneration) throw new Error('连接已变更，请重新打开历史会话。');
  newSession({ forget: false });
  showRestoredConversation(id, page);
}

function conversationKey() {
  return directMode ? ACTIVE_CONVERSATION + ':' + settings.url : ACTIVE_CONVERSATION;
}

function directFailure(error) {
  return error.status === 401 ? 'PipiClaw 拒绝了这把 Key，请核对或更换 Key。' : error.message;
}

async function refreshConnection(directChecked = false) {
  const generation = ++connectionGeneration;
  connection = 'checking';
  connectionDetail = undefined;
  renderConnection();
  try {
    const path = directMode ? '/api/session?mode=direct' : '/api/session';
    const response = await fetch(path, { signal: AbortSignal.timeout(7_000), cache: 'no-store' });
    if (!response.ok) throw new Error('Connection check failed.');
    const { connection: state, relay: available, auth } = await response.json();
    if (!['ready', 'offline', 'demo', 'direct', 'locked'].includes(state)) throw new Error('Bad connection state.');
    if (generation !== connectionGeneration) return;
    authMode = auth === 'passcode' ? 'passcode' : 'none';
    relayAvailable = available === true;
    connection = state;
    if (state === 'locked') {
      openAuthDialog();
    }
    if (state === 'demo') settings = { ...settings, mode: 'demo', model: 'demo', url: '/demo/v1', context: 'history' };
    if (state === 'direct') {
      connection = 'setup';
      if (settings.url && settings.key) {
        try {
          if (!directChecked) await checkDirectConnection(settings, AbortSignal.timeout(7_000));
          if (generation !== connectionGeneration) return;
          connection = 'ready';
        } catch (error) {
          if (generation !== connectionGeneration) return;
          connection = 'offline';
          connectionDetail = directFailure(error);
        }
      }
    }
    if (connection === 'ready') await restoreConversation(generation);
  } catch {
    if (generation === connectionGeneration) {
      connection = 'offline';
      connectionDetail = '无法连接 Turnline，请检查当前页面的访问地址。';
    }
  }
  if (generation === connectionGeneration) {
    renderConnection();
    prewarmVoice();
  }
}

function ensureConversation() {
  if (conversation) return Promise.resolve(conversation);
  if (opening) return opening.promise;
  const controller = new AbortController();
  const attempt = { controller };
  const key = conversationKey();
  opening = attempt;
  attempt.promise = createConversation(settings, controller.signal, { source: 'turnline' }).then(id => {
    if (opening !== attempt) throw new DOMException('Conversation changed', 'AbortError');
    conversation = id;
    conversationTitled = false;
    store(key, id);
    rememberConversation(settings, id);
    watchConversation(id);
    return id;
  }).finally(() => {
    if (opening === attempt) opening = undefined;
  });
  return attempt.promise;
}

function render() {
  renderCall(state, {
    canCall: canCall(), duplex: settings.duplex, pendingPlayback: player.active,
    busy: Boolean(turn && !turn.ended) || player.active || player.playing || Boolean(replay),
    holdMode: settings.inputMode === 'hold', held, signal: signalQuality,
    slow: poorSince !== undefined && performance.now() - poorSince >= 3000,
  });
}

function updateDuration() {
  const seconds = call ? Math.floor((clock() - call.started) / 1000) : 0;
  const duration = [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  if ($('duration').textContent !== duration) {
    $('duration').textContent = duration;
    updateCallTitle();
  }
  if (poorSince !== undefined && performance.now() - poorSince >= 3000 && !$('hint').textContent.startsWith('网络较慢')) render();
}

function clearInput() {
  barge.clear();
  player.gain(1, 35);
  clearCaption('draft');
  inputTelemetry = undefined;
  voice.reset();
  dispatch({ type: 'reset-input' });
}

function prewarmVoice() {
  if (call || !('WebSocket' in window) || !('AudioContext' in window)) return;
  clearTimeout(warmTimer);
  if (!canCall() || document.hidden) {
    voice.close();
    return;
  }
  void voice.connect().catch(() => {});
  warmTimer = setTimeout(() => {
    if (!call) voice.close();
  }, 60_000);
}

function configureVoice() {
  voice.configure(settings.speed, expectingAnswer, settings.inputMode === 'hold' || held || releasing,
    settings.minVoiceSeconds);
}

function syncMedia() {
  updateMediaSession({
    active: Boolean(call?.ready), mic: Boolean(call?.ready && !state.muted),
    hangUp, mute: toggleMute,
  });
}

async function startCall() {
  if (!canCall() || call) return;
  stopReplay();
  clearTimeout(warmTimer);
  showError();
  let context;
  try {
    context = new AudioContext({ latencyHint: 'interactive' });
  } catch {
    showError('当前浏览器无法打开语音通话。');
    return;
  }
  const controller = new AbortController();
  const { signal } = controller;
  const started = { started: clock(), controller, context };
  call = started;
  voice.inCall = true;
  configureVoice();
  readyModels = false;
  previousCommit = previousOutput = undefined;
  trace.start(started.started);
  dispatch({ type: 'connect' });
  renderModelStatus();
  updateDuration();
  if (settings.context === 'conversation') void ensureConversation().catch(() => {});
  try {
    await openCallAudio(started, voice, player, {
      onFrame: onCapture,
      muted: () => state.muted,
      switched: clearInput,
      showError,
    });
    if (signal.aborted) return;
    readyModels = started.ready = true;
    dispatch({ type: 'ready' });
    if (document.activeElement === $('call')) $('status').focus({ preventScroll: true });
    syncMedia();
    renderModelStatus();
    const latency = clock() - started.started;
    showMetric('ready', latency);
    trace.callMetric('click_to_ready_ms', latency);
    if (smallScreen.matches) store('turnline.microphone-explained.v1', 'yes');
    if (settings.tones) player.tone('connect');
  } catch (error) {
    if (signal.aborted) return;
    hangUp();
    showError(error.name === 'NotAllowedError' ? '麦克风权限未开启。请点地址栏左侧图标 → 网站设置 → 麦克风，允许后重试。' : error.message);
  }
}

function hangUp() {
  const ended = call;
  clearTimeout(warmTimer);
  call = undefined;
  held = releasing = false;
  signalQuality = poorSince = undefined;
  voice.inCall = false;
  stopReplay();
  syncMedia();
  voiceQueue = [];
  pendingUpdates = [];
  dispatch({ type: 'hangup' });
  ended?.controller.abort();
  clearCaption('draft');
  voice.close();
  interrupt(false, 'hangup');
  if (ended) {
    trace.stop(clock());
    vibrate(settings.tones);
    closeCallAudio(ended, player, settings.tones);
  }
  updateDuration();
  render();
}

function onCapture({ samples, rms, fastStart }, at) {
  if (state.muted || releasing || settings.inputMode === 'hold' && !held) return;
  if (held && !player.playing) {
    showLevel('input', rms);
    voice.frame(samples, at, rms >= 0.012);
    return;
  }
  if (settings.duplex && player.playing && !state.barge && state.input === 'quiet' && fastStart) {
    barge.duck(at - 64, player.echoReferences);
  }
  if (!player.playing || state.input !== 'quiet' && !state.barge) showLevel('input', rms);
  voice.frame(samples, at, rms >= 0.012);
}

function rememberAnswer(current, content) {
  if (current.historyItem) {
    if (content) current.historyItem.content = content;
    else history = history.filter(item => item !== current.historyItem);
  } else if (content) {
    current.historyItem = { role: 'assistant', content };
    history.push(current.historyItem);
    if (history.length > 16) history.splice(0, history.length - 16);
  }
}

function showConversationUpdate(text, speak) {
  transcript.add('update', text);
  if (!speak || !call?.ready) return;
  const summary = updateSpeech(text);
  if (summary) {
    pendingUpdates.push(summary);
    if (pendingUpdates.length > 5) pendingUpdates.shift();
    drainWaiting();
  }
}

function canSteer(text) {
  return Boolean(
    turn && !turn.ended && turn.ws && turn.responseId && !turn.firstAudio && !player.playing &&
    settings.mode === 'relay' && !text.trim().startsWith('/'),
  );
}

function drainWaiting() {
  if (!canCall() || state.input !== 'quiet') return;
  if (['connecting', 'reconnecting'].includes(state.connection)) return;
  if (voiceQueue.length && canSteer(voiceQueue[0].text)) {
    const queued = voiceQueue.shift();
    void send(queued.text, queued, queued.display);
    return;
  }
  if (state.output !== 'idle' || turn && !turn.ended) return;
  const queued = voiceQueue.shift();
  if (queued) {
    void send(queued.text, queued, queued.display);
    return;
  }
  if (!call?.ready || state.muted) return;
  const text = pendingUpdates.shift();
  if (text) {
    turn = undefined;
    dispatch({ type: 'request-started' });
    const group = player.begin();
    player.enqueue(group, { text, speed: settings.rate });
    player.seal(group);
    render();
  }
}

function interrupt(note = true, reason = 'interrupted') {
  stopReplay();
  const previous = turn;
  const position = player.heardPosition;
  const fragment = position?.heard || '';
  const point = position?.entry.range || previous?.lastRange;
  const completedBeforeInterrupt = previous?.ended;
  const hadOutput = Boolean(previous && (!previous.ended || player.active));
  barge.clear();
  if (previous) {
    if (!previous.ended) {
      updates?.interrupted();
      trace.finish(previous.traceItem, reason, clock() - previous.startedAt);
      if (previous.ws) responsesSocket?.cancel(previous.responseId);
      else if (previous.background && previous.responseId) {
        void cancelResponse(previous.settings, previous.responseId).catch(() => {});
      }
    }
    waiting.stop();
    previous.ended = true;
    previous.controller.abort();
  }
  pendingSteer = undefined;
  turn = undefined;
  player.stop();
  waiting.stop();
  dispatch({ type: 'playback-ended', waiting: false });
  if (hadOutput) {
    if (note && call?.ready) vibrate(settings.tones);
    const display = point?.display ?? previous.answer[0]?.display;
    const at = position?.entry.range ? sourcePosition(point, fragment) : point?.end ?? 0;
    transcript.interrupted(display, at);
    if (point?.display && position?.entry.text) {
      speakCaption(position.entry.text, fragment);
      const caption = $('stage-caption').lastElementChild;
      if (caption) caption.dataset.interrupted = 'true';
      setTimeout(() => { if (caption?.isConnected) clearCaption('assistant'); }, 1000);
    }
    if (previous.traceItem && completedBeforeInterrupt) previous.traceItem.playback_interrupted = true;
    if (previous.voice && note) {
      const heard = [...previous.heard];
      if (fragment && fragment !== heard.at(-1)) heard.push(fragment);
      rememberAnswer(previous, heard.join('\n'));
      interruption = fragment
        ? '上一轮语音回复在播到「' + fragment + '」附近时被打断。'
        : heard.length
          ? '上一轮语音回复被打断。最后完整播完的一句是「' + heard.at(-1) + '」。'
          : '上一轮语音回复被打断时，还没有完整播完一句。';
    }
  }
  render();
}

function metricCount(item, name) {
  if (!item) return;
  item[name] = (item[name] ?? 0) + 1;
  trace.save();
}

function onBarge(event) {
  switch (event.type) {
    case 'barge-confirmed': {
      const preceding = turn?.traceItem;
      trace.metric(preceding, 'bargeStop', clock() - event.at);
      inputTelemetry.stopAt = event.at;
      interrupt();
      // The in-progress interruption is now an ordinary user utterance.
      dispatch({ type: 'speech-start', input: state.inputId, duringPlayback: false });
      break;
    }
    case 'restore':
      if (event.input !== undefined) voice.send({ type: 'discard-input', input: event.input });
      metricCount(turn?.traceItem, 'false_barge');
      inputTelemetry = undefined;
      clearCaption('draft');
      dispatch({ ...event, playing: player.playing });
      break;
    default:
      dispatch(event);
  }
}

function onPlayback(event) {
  switch (event.type) {
    case 'playback-started':
      if (state.input !== 'quiet' && !state.barge) player.gain(0, 0, true);
      dispatch(event);
      break;
    case 'playback-ended':
    case 'playback-silent':
      activeRange = undefined;
      transcript.highlight();
      clearCaption('assistant');
      showLevel('output', 0);
      if (event.type === 'playback-silent') player.gain(1, 35);
      if (event.references?.length) {
        previousOutput = { references: event.references, at: event.tailAt ?? clock() };
      }
      barge.clear();
      dispatch({ ...event, type: 'playback-ended', waiting: Boolean(turn && !turn.ended || player.active) });
      break;
    case 'playback-level':
      showLevel('output', event.rms);
      if (event.position?.entry.range && activeRange === event.position.entry.range) {
        speakCaption(event.position.entry.text, event.position.heard);
      }
      break;
    case 'playback-gain': {
      const candidate = barge.candidate;
      if (!candidate || !['duck', 'pause'].includes(event.event)) break;
      const name = event.event === 'duck' ? 'bargeDuck' : 'bargePause';
      const item = turn?.traceItem;
      // Per-turn latency measures the first time playback yielded. Later
      // recovery attempts have their own counter.
      if (item?.timing_ms[name] !== undefined) break;
      const latency = event.at - candidate.at;
      trace.metric(item, name, latency);
      if (event.event === 'pause') {
        showMetric('interruption', latency);
        trace.metric(item, 'interruption', latency);
      }
      break;
    }
    case 'playback-gap':
      if (turn) {
        turn.gaps += event.ms;
        setMetric(turn, 'gaps', turn.gaps);
        metricCount(turn.traceItem, 'underrun');
      }
      break;
    case 'playback-error':
      showError(event.message);
      break;
  }
}

function onVoice(event) {
  if (event.type === 'auth-required') {
    handleAuthRequired();
    return;
  }
  if (event.type === 'warm-disconnected') return;
  if (!call) return;
  if (event.type === 'rtt') {
    signalQuality = event.ms < 180 ? 'good' : event.ms < 500 ? 'fair' : 'poor';
    poorSince = signalQuality === 'poor' ? poorSince ?? performance.now() : undefined;
    render();
    return;
  }
  if (event.type === 'fatal') {
    readyModels = false;
    renderModelStatus();
    hangUp();
    showError(event.message);
    return;
  }
  if (['reconnecting', 'input-gap', 'input-error'].includes(event.type)) {
    if (event.input !== undefined && event.input !== state.inputId) return;
    if (held || releasing) voice.reset();
    held = releasing = false;
    configureVoice();
    if (event.type === 'reconnecting') {
      signalQuality = 'poor';
      poorSince = performance.now();
      trace.reconnect();
    }
    barge.clear();
    player.gain(1, 70);
    clearCaption('draft');
    inputTelemetry = undefined;
    dispatch(event);
    if (event.type === 'input-error' || event.voiced) showError(event.message ?? '网络较慢，刚才的语音可能不完整，请再说一遍。');
    return;
  }
  if (event.type === 'reconnected' || event.type === 'congestion') {
    dispatch(event);
    return;
  }
  if (state.muted || event.epoch !== voice.epoch) return;
  if (event.type === 'hold-empty') {
    if (releasing) {
      voice.reset();
      finishHold();
    }
    return;
  }
  const at = clock();
  if (event.type === 'speech-start') {
    const onset = voice.captureTime(event.startSample) ?? at;
    const recentOutput = previousOutput && Math.abs(onset - previousOutput.at) <= 450;
    const echoRisk = event.duringPlayback || event.overlap || recentOutput;
    const references = event.duringPlayback ? player.echoReferences : previousOutput?.references;
    inputTelemetry = { onset, references, echoRisk };
    dispatch(event);
    if (event.duringPlayback && settings.duplex && player.playing) barge.pause(event, onset);
    return;
  }
  if (!inputTelemetry || event.input !== state.inputId) return;
  if (event.type === 'resumed') {
    showDraft(inputTelemetry.draft);
    dispatch(event);
    return;
  }
  const text = event.text?.trim();
  if (event.type === 'partial' && text) inputTelemetry.partialLag ??= at - inputTelemetry.onset;
  if (state.barge) {
    barge.transcript(event);
    if (state.barge && event.type !== 'commit') return;
    if (!inputTelemetry) return;
  }
  if (event.type === 'partial') {
    inputTelemetry.draft = text;
    showDraft(text);
  } else if (event.type === 'tentative') {
    dispatch(event);
    const voiceEnd = voice.captureTime(event.voiceEndSample);
    inputTelemetry.draft = text;
    if (text) showDraft(text, event.waitMs - (voiceEnd === undefined ? 0 : at - voiceEnd));
  } else if (event.type === 'commit') {
    const telemetry = inputTelemetry;
    inputTelemetry = undefined;
    if (releasing) finishHold();
    dispatch(event);
    player.gain(1, 35);
    const echo = telemetry.echoRisk && !telemetry.stopAt && (
      matchesEcho(text, telemetry.references) || matchesEcho(text, player.echoReferences) ||
      matchesEcho(text, previousOutput?.references)
    );
    if (!text || isBackchannel(text) || echo) {
      clearCaption('draft');
      return;
    }
    if (previousCommit && telemetry.onset - previousCommit.endpointAt < 1500 && !telemetry.stopAt) {
      previousCommit.cut = true;
      if (previousCommit.traceItem) {
        previousCommit.traceItem.cut = true;
        trace.save();
      }
    }
    const timing = {
      text, endpointAt: at, voiceEndAt: voice.captureTime(event.voiceEndSample) ?? at - event.silenceWaitMs,
      silenceWaitMs: event.silenceWaitMs, asrMs: event.asrMs, partialLag: telemetry.partialLag,
      display: transcript.add('user', text),
    };
    previousCommit = timing;
    clearCaption('draft');
    announce('已发送：' + text);
    vibrate(settings.tones);
    if (settings.tones) player.tone('commit');
    voiceQueue.push(timing);
    drainWaiting();
  }
}

function sourcePosition(range, heard) {
  if (!heard.length) return range.start;
  return (range.offsets[Math.min(heard.length, range.offsets.length) - 1] ?? range.start) + 1;
}

function speechEntry(phrase, range) {
  return {
    text: phrase, range, speed: settings.rate,
    onStart() {
      activeRange = range;
      transcript.highlight(range);
      speakCaption(phrase);
    },
    onEnd() {
      if (activeRange === range) {
        activeRange = undefined;
        transcript.highlight();
        clearCaption('assistant');
      }
      announce(phrase);
    },
  };
}

function enqueue(current, phrase, range, firstTextAt) {
  if (!current.voice || !call?.ready || current.controller.signal.aborted) return;
  if (current.firstSpeakable === undefined) {
    current.firstSpeakable = clock();
    waiting.stop();
    setMetric(current, 'speakable', current.firstSpeakable - current.sentAt);
    if (firstTextAt !== undefined) setMetric(current, 'textWait', current.firstSpeakable - firstTextAt);
  }
  const shouldRender = !player.active;
  const speech = speechEntry(phrase, range);
  player.enqueue(current.playback, {
    ...speech,
    speed: current.settings.rate,
    onPcm(at, timing) {
      if (current.firstPcm) return;
      current.firstPcm = at;
      setMetric(current, 'pcm', at - current.firstSpeakable);
      setMetric(current, 'queue', timing.queue);
      setMetric(current, 'synthesis', timing.synthesis);
    },
    onStart(at) {
      speech.onStart();
      if (current.firstAudio) return;
      current.firstAudio = at;
      if (!current.gaps) setMetric(current, 'gaps', 0);
      $('metric-audio').previousElementSibling.textContent = current.timing ? '提交到首声' : '发送到首声';
      setMetric(current, 'audio', at - (current.timing?.endpointAt ?? current.sentAt));
      if (current.timing) setMetric(current, 'perceived', at - current.timing.voiceEndAt);
    },
    onEnd() {
      speech.onEnd();
      current.lastRange = range;
      current.heard.push(phrase);
    },
  });
  if (shouldRender) render();
}

function ensureResponsesSocket() {
  if (settings.mode !== 'relay' || settings.context !== 'conversation' || !('WebSocket' in window)) return undefined;
  if (!responsesSocket || responsesSocket.url !== settings.url) {
    responsesSocket?.close();
    responsesSocket = new ResponsesSocket(settings.url, { onAuthRequired: handleAuthRequired });
  }
  return responsesSocket;
}

function shortTitle(text) {
  const chars = Array.from(text.replace(/\s+/gu, ' ').trim());
  return chars.length > 60 ? chars.slice(0, 60).join('') + '…' : chars.join('');
}

async function send(text, timing, display, quiet = false) {
  if (!canCall() || !text.trim()) return;
  if (text.length > 12000) {
    showError('这条消息过长，请分段发送。');
    return;
  }
  // Mid-turn steering over WebSocket: when the assistant is still thinking or
  // running tools (not yet speaking), steer the running turn instead of
  // aborting its progress.
  if (canSteer(text) && responsesSocket?.steer(text, turn.responseId)) {
    if (!display) transcript.add('user', text);
    pendingSteer = { text, timing, quiet };
    return;
  }
  interrupt();
  showError();
  for (const name of Object.keys(metrics)) {
    if (name !== 'interruption') showMetric(name, name === 'asr' ? timing?.asrMs : undefined);
  }
  if (!display) transcript.add('user', text);
  history.push({ role: 'user', content: text });
  if (history.length > 16) history.splice(0, history.length - 16);
  const startedAt = clock();
  transcript.retryFor(undefined);
  const current = new ResponseTurn({
    startedAt, traceItem: trace.begin(startedAt, timing ? 'voice' : 'text'), settings, timing,
    voice: Boolean(call?.ready && readyModels && !quiet),
  }, {
    metric: (name, value) => setMetric(current, name, value),
    text(entry) {
      entry.display ??= transcript.add('assistant');
      transcript.update(entry.display, entry.text, entry.phase === 'commentary', entry.done, {
        level: entry.level, keepExpanded: entry.spokenAsCommentary,
      });
    },
    track: id => updates?.track(id),
    enqueue: (phrase, range, at) => enqueue(current, phrase, range, at),
    tool: (active, label) => waiting.update(undefined, active, label),
    notice: (level, message) => transcript.notice(level, message),
    usage: value => trace.usage(current.traceItem, value),
  });
  turn = current;
  if (current.voice) current.playback = player.begin();
  if (timing) {
    setMetric(current, 'asr', timing.asrMs);
    setMetric(current, 'silenceWait', timing.silenceWaitMs);
    setMetric(current, 'partialLag', timing.partialLag);
    timing.traceItem = current.traceItem;
    if (timing.cut && current.traceItem) current.traceItem.cut = true;
  }
  dispatch({ type: 'request-started' });
  waiting.start();
  setMetric(current, 'feedback', clock() - (timing?.endpointAt ?? startedAt));
  const previousInterruption = interruption;
  interruption = '';
  const { signal } = current.controller;
  render();
  let steerFallback;
  try {
    if (current.settings.context === 'conversation') await ensureConversation();
    if (signal.aborted) return;
    if (conversation && !conversationTitled && !text.trim().startsWith('/')) {
      conversationTitled = true;
      const title = shortTitle(text);
      cacheConversationTitle(conversation, title);
      void updateConversationMetadata(current.settings, conversation, { source: 'turnline', title }).catch(() => {});
    }
    current.sentAt = clock();
    if (timing) setMetric(current, 'endpointToRequest', current.sentAt - timing.endpointAt);

    const instructions = current.voice
      ? [CALL_INSTRUCTIONS, current.settings.instructions, previousInterruption].filter(Boolean).join('\n')
      : undefined;

    const consume = async events => {
      for await (const event of events) {
        if (signal.aborted || turn !== current) return 'aborted';
        if (event.type === 'response.steer.accepted') continue;
        if (event.type === 'response.steer.failed') {
          if (pendingSteer) {
            steerFallback = pendingSteer;
            pendingSteer = undefined;
          }
          continue;
        }
        if (event.type === 'response.created' && current.steered) {
          pendingSteer = undefined;
        }
        if (current.event(event)) return 'completed';
      }
      return 'disconnected';
    };

    let outcome = 'disconnected';
    const socket = ensureResponsesSocket();
    if (socket && conversation) {
      try {
        current.ws = true;
        const wsPayload = {
          model: current.settings.model,
          conversation,
          input: text,
          ...(instructions ? { instructions } : {}),
        };
        outcome = await consume(socket.create(wsPayload, signal));
      } catch (error) {
        if (signal.aborted || current.responseId) throw error;
        current.ws = false;
        socket.close();
      }
    }

    if (!current.ws) {
      const useBackground = current.settings.context === 'conversation' && Boolean(conversation);
      current.background = useBackground;
      const openInitial = () => openResponse(current.settings, {
        conversation, messages: history.slice(-16), text, voice: current.voice,
        interruption: previousInterruption, background: useBackground,
      }, signal);
      try {
        outcome = await consume(await openInitial());
      } catch (error) {
        if (signal.aborted || !useBackground || !current.responseId || current.lastSequence === undefined || error.status) {
          throw error;
        }
      }
      if (outcome === 'disconnected' && useBackground && !signal.aborted &&
          current.responseId && current.lastSequence !== undefined) {
        for (const delayMs of [600, 1500, 3000]) {
          if (signal.aborted || turn !== current) break;
          await new Promise(resolve => setTimeout(resolve, delayMs));
          if (signal.aborted || turn !== current) break;
          try {
            const resumed = await resumeResponse(current.settings, current.responseId, current.lastSequence, signal);
            outcome = await consume(resumed);
            if (outcome !== 'disconnected') break;
          } catch (error) {
            if (signal.aborted || error.status === 400 || error.status === 404) break;
          }
        }
      }
    }

    if (outcome === 'aborted') return;
    if (outcome !== 'completed') throw new Error('回复提前断开。可查看已有文字或发送下一条。');
    const answers = current.answer;
    const answer = answers.map(entry => entry.text).join('\n');
    transcript.retryFor(answers.at(-1)?.display);
    rememberAnswer(current, answer);
    expectingAnswer = /[？?][”’」』"]?\s*$/u.test(answer);
    configureVoice();
    trace.finish(current.traceItem, 'completed', clock() - current.startedAt);
  } catch (error) {
    if (!signal.aborted) {
      updates?.interrupted();
      showError(error.message);
      trace.finish(current.traceItem, 'failed', clock() - current.startedAt);
      if (error.status === 401) {
        hangUp();
        newSession({ forget: false });
        if (directMode) {
          saveDirectSettings(settings.url, '');
          settings = { ...settings, key: '' };
          connection = 'setup';
          connectionDetail = directFailure(error);
          renderConnection();
        } else if (authMode === 'passcode') {
          handleAuthRequired();
        } else {
          showError('正在刷新浏览器会话，请稍后重新发送。');
          void refreshConnection();
        }
      }
    }
  } finally {
    current.ended = true;
    if (turn === current) {
      waiting.stop();
      if (current.playback) player.seal(current.playback);
      else dispatch({ type: 'playback-ended', waiting: false });
    }
  }
  if (steerFallback && !signal.aborted) {
    void send(steerFallback.text, steerFallback.timing, true, steerFallback.quiet);
  }
}

function newSession({ forget = true } = {}) {
  opening?.controller.abort();
  opening = undefined;
  if (forget) {
    const key = conversationKey();
    rememberConversation(settings, stored(key));
    store(key);
  }
  updates?.stop();
  updates = undefined;
  pendingUpdates = [];
  voiceQueue = [];
  previousCommit = previousOutput = undefined;
  expectingAnswer = false;
  held = releasing = false;
  configureVoice();
  clearInput();
  interrupt(false, 'new_conversation');
  history = [];
  conversation = undefined;
  conversationTitled = false;
  interruption = '';
  transcript.clear();
  for (const name of Object.keys(metrics)) showMetric(name);
  showError();
}

bindConversationHistory({
  settings: () => settings,
  current: () => conversation,
  select: selectConversation,
  onDeleteCurrent: () => newSession({ forget: true }),
});

function openAuthDialog(detail) {
  if (detail) connectionDetail = detail;
  showError(undefined, $('auth-error'));
  $('auth-passcode').value = '';
  if (!authDialog.open) authDialog.showModal();
  $('auth-passcode').focus();
}

function handleAuthRequired(detail = '会话已失效，请重新输入访问口令。') {
  authMode = 'passcode';
  hangUp();
  responsesSocket?.close();
  newSession({ forget: false });
  connection = 'locked';
  connectionDetail = detail;
  renderConnection();
  openAuthDialog(detail);
}

function startAuthCooldown(seconds) {
  clearInterval(authCooldownTimer);
  let remaining = Math.max(1, Math.ceil(seconds));
  const submit = $('auth-submit');
  const tick = () => {
    if (remaining <= 0) {
      clearInterval(authCooldownTimer);
      authCooldownTimer = undefined;
      submit.disabled = false;
      submit.textContent = '解锁';
      return;
    }
    submit.disabled = true;
    submit.textContent = `${remaining} 秒后重试`;
    remaining--;
  };
  tick();
  authCooldownTimer = setInterval(tick, 1000);
}

$('auth-form').onsubmit = async event => {
  event.preventDefault();
  if (authCooldownTimer) return;
  const passcode = $('auth-passcode').value;
  if (!passcode) return;
  const submit = $('auth-submit');
  submit.disabled = true;
  showError(undefined, $('auth-error'));
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode }),
      signal: AbortSignal.timeout(7_000),
    });
    if (response.ok) {
      $('auth-passcode').value = '';
      authDialog.close();
      void refreshConnection();
      return;
    }
    const payload = await response.json().catch(() => null);
    showError(payload?.error?.message ?? '访问验证失败，请重试。', $('auth-error'));
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after')) || 60;
      startAuthCooldown(retryAfter);
    } else {
      $('auth-passcode').select();
      $('auth-passcode').focus();
    }
  } catch {
    showError('无法连接 Turnline，请稍后重试。', $('auth-error'));
  } finally {
    if (!authCooldownTimer) submit.disabled = false;
  }
};
$('unlock-auth').onclick = () => openAuthDialog();
$('logout-auth').onclick = async () => {
  dialog.close();
  try {
    await fetch('/api/auth/logout', { method: 'POST', signal: AbortSignal.timeout(5_000) });
  } catch {
    // Even if offline, clear local state and lock UI.
  }
  handleAuthRequired('已退出当前设备，请重新输入访问口令。');
};

function openSettings() {
  $('instructions').value = settings.instructions;
  $('reading').value = settings.reading;
  $('speed').value = settings.speed;
  $('rate').value = String(settings.rate);
  $('tones').checked = settings.tones;
  $('waiting-tone').checked = settings.waitingTone;
  $('input-mode').value = settings.inputMode;
  $('min-voice-seconds').value = String(settings.minVoiceSeconds);
  $('duplex').checked = settings.duplex;
  dialog.showModal();
}

function openDirectSettings() {
  dialog.close();
  $('direct-url').value = settings.url;
  $('direct-key').value = settings.key;
  $('forget-direct').hidden = !settings.key;
  showError(undefined, $('direct-error'));
  directDialog.showModal();
}

let directAttempt;
$('direct-form').onsubmit = async event => {
  event.preventDefault();
  if (directAttempt) return;
  const controller = new AbortController();
  directAttempt = controller;
  $('test-direct').disabled = true;
  showError(undefined, $('direct-error'));
  try {
    const url = normalizeDirectUrl($('direct-url').value, location.origin);
    const key = $('direct-key').value.trim();
    if (!key || /[^\x21-\x7e]/.test(key)) throw new Error('请输入完整的 PipiClaw Key。');
    const next = { mode: 'direct', url, key };
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(7_000)]);
    await checkDirectConnection(next, signal);
    if (controller.signal.aborted) return;
    if (url !== settings.url || key !== settings.key) {
      hangUp();
      newSession({ forget: false });
      settings = { ...settings, ...next };
      saveDirectSettings(url, key);
    }
    directDialog.close();
    void refreshConnection(true);
  } catch (error) {
    if (!controller.signal.aborted) showError(directFailure(error), $('direct-error'));
  } finally {
    directAttempt = undefined;
    $('test-direct').disabled = false;
  }
};
directDialog.onclose = () => {
  directAttempt?.abort();
  $('direct-key').value = '';
};
$('close-direct').onclick = () => directDialog.close();
$('setup-direct').onclick = openDirectSettings;
$('edit-direct').onclick = openDirectSettings;
$('forget-direct').onclick = () => {
  hangUp();
  newSession({ forget: false });
  saveDirectSettings(settings.url, '');
  settings = { ...settings, key: '' };
  directDialog.close();
  void refreshConnection();
};
$('open-settings').onclick = openSettings;
$('close-settings').onclick = () => dialog.close();
$('open-diagnostics').onclick = () => diagnostics.showModal();
$('close-diagnostics').onclick = () => diagnostics.close();
$('settings-form').onsubmit = event => {
  event.preventDefault();
  const next = {
    reading: $('reading').value, speed: $('speed').value, rate: Number($('rate').value),
    minVoiceSeconds: Number($('min-voice-seconds').value),
    tones: $('tones').checked, waitingTone: $('waiting-tone').checked, inputMode: $('input-mode').value, duplex: $('duplex').checked, instructions: $('instructions').value.trim(),
  };
  const captureChanged = next.duplex !== settings.duplex || next.inputMode !== settings.inputMode;
  if (captureChanged) held = releasing = false;
  settings = { ...settings, ...next };
  savePreferences(next);
  configureVoice();
  if (captureChanged) clearInput();
  if (!settings.tones || !settings.waitingTone) player.stopTone('waiting');
  dialog.close();
  render();
};
$('retry-connection').onclick = () => void refreshConnection();
$('export-timing').onclick = () => trace.download();
function toggleMute() {
  if (state.connection !== 'ready') return;
  held = releasing = false;
  configureVoice();
  dispatch({ type: 'mute' });
  call?.microphone?.setEnabled(!state.muted);
  clearInput();
  syncMedia();
}

function startHold() {
  if (state.connection !== 'ready' || state.muted || held || releasing) return false;
  if (state.output !== 'idle' || player.active || turn && !turn.ended) interrupt();
  player.stopTone('waiting');
  held = true;
  configureVoice();
  render();
  return true;
}

function finishHold() {
  releasing = false;
  configureVoice();
  render();
}

function releaseHold(commit) {
  if (!held) return false;
  held = false;
  if (commit && voice.ready) {
    releasing = true;
    voice.releaseInput();
  } else {
    clearInput();
    finishHold();
  }
  render();
  return true;
}

function expandTranscript(expanded) {
  document.querySelector('.workspace').dataset.expanded = String(expanded);
  const button = $('expand-transcript');
  const label = expanded ? '收起对话记录' : '展开对话记录';
  button.setAttribute('aria-expanded', String(expanded));
  button.setAttribute('aria-label', label);
  button.title = label;
  setIcon(button, expanded ? 'collapse' : 'expand');
  if (expanded) button.scrollIntoView({ block: 'nearest' });
}

function stopReplay() {
  if (!replay) return;
  const current = replay;
  replay = undefined;
  current.player.close();
  current.voice.close();
  void current.context.close().catch(() => {});
  activeRange = undefined;
  transcript.highlight();
  clearCaption('assistant');
}

function replayMessage(display) {
  const { phrases, ranges } = splitSpeech(display.text, true, true, true);
  if (!phrases.length) return;
  interrupt(true, 'replay');
  showError();
  const play = output => {
    const group = output.begin();
    for (const [index, phrase] of phrases.entries()) {
      output.enqueue(group, speechEntry(phrase, { ...ranges[index], display }));
    }
    output.seal(group);
    render();
  };
  if (call?.ready) {
    play(player);
    return;
  }
  if (call) return;
  let context;
  try { context = new AudioContext({ latencyHint: 'interactive' }); }
  catch { showError('当前浏览器无法重播语音。'); return; }
  const session = new VoiceSession(event => {
    if (event.type === 'auth-required') {
      stopReplay();
      handleAuthRequired();
      return;
    }
    if (event.type === 'fatal' || event.type === 'warm-disconnected') {
      stopReplay();
      showError(event.message ?? '重播时语音连接已断开。');
    }
  });
  const output = new SpeechPlayer(session, event => {
    if (event.type === 'playback-ended') {
      stopReplay();
      render();
    } else if (event.type === 'playback-error') showError(event.message);
    else if (event.type === 'playback-level' && event.position?.entry.range === activeRange && activeRange) {
      speakCaption(event.position.entry.text, event.position.heard);
    }
  });
  const current = replay = { context, voice: session, player: output };
  render();
  void Promise.all([session.connect(), context.resume().then(() => {
    if (replay === current) return output.open(context);
  })]).then(() => {
    if (replay === current) play(output);
  }).catch(error => {
    if (replay !== current) return;
    stopReplay();
    showError(error.message);
  });
}

$('call').onclick = () => {
  if (call) hangUp();
  else if (smallScreen.matches && !stored('turnline.microphone-explained.v1')) $('microphone-help').showModal();
  else void startCall();
};
$('allow-microphone').onclick = () => void startCall();
$('mute').onclick = toggleMute;
$('interrupt').onclick = () => interrupt();
$('orb').onclick = () => {
  if (!call) {
    $('call').click();
    return;
  }
  if (settings.inputMode === 'hold' && !state.muted) return;
  if (callPhase(state) === 'speaking') interrupt();
  else voice.send({ type: 'force-commit' });
};
$('mode-badge').onclick = () => {
  openSettings();
  $('input-mode').focus();
};
$('open-shortcuts').onclick = () => $('shortcuts').showModal();
let confirmNewTimer;
function resetNewSessionButton() {
  clearTimeout(confirmNewTimer);
  confirmNewTimer = undefined;
  const button = $('new-session');
  button.classList.remove('confirming');
  button.lastChild.textContent = '新对话';
}
$('new-session').onclick = () => {
  const needsConfirm = $('empty').hidden || Boolean(call);
  if (needsConfirm && !confirmNewTimer) {
    const button = $('new-session');
    button.classList.add('confirming');
    button.lastChild.textContent = '确认清空？';
    confirmNewTimer = setTimeout(resetNewSessionButton, 3000);
    return;
  }
  resetNewSessionButton();
  newSession();
};
for (const chip of document.querySelectorAll('.prompt-chip')) {
  chip.onclick = () => {
    const prompt = chip.dataset.prompt;
    if (prompt) void send(prompt, undefined, undefined, textOnly);
  };
}
$('toggle-composer').onclick = () => {
  if (!field.disabled) field.focus();
};
const expandButton = $('expand-transcript');
let drawerStart;
let drawerDragged = false;
expandButton.addEventListener('pointerdown', event => {
  drawerDragged = false;
  if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
  drawerStart = event.clientY;
  expandButton.setPointerCapture(event.pointerId);
});
expandButton.addEventListener('pointerup', event => {
  if (drawerStart === undefined) return;
  const delta = event.clientY - drawerStart;
  drawerStart = undefined;
  if (Math.abs(delta) > 30) {
    drawerDragged = true;
    expandTranscript(delta < 0);
  }
});
expandButton.addEventListener('pointercancel', () => { drawerStart = undefined; });
expandButton.onclick = event => {
  if (drawerDragged && event.detail) return;
  expandTranscript(expandButton.getAttribute('aria-expanded') === 'false');
};
$('text-only').onclick = event => {
  textOnly = !textOnly;
  const button = event.currentTarget;
  button.setAttribute('aria-pressed', String(textOnly));
  setIcon(button, textOnly ? 'speaker-off' : 'speaker');
  const label = textOnly ? '仅文字回复（已关闭语音播报）' : '回复时朗读语音';
  button.setAttribute('aria-label', label);
  button.title = textOnly ? '已关闭本轮语音播报（点击恢复）' : '回复时朗读语音（点击关闭本轮播报）';
};
function resizeComposer() {
  field.style.height = 'auto';
  field.style.height = Math.min(field.scrollHeight, 120) + 'px';
}
field.addEventListener('input', resizeComposer);
field.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
    event.preventDefault();
    field.form.requestSubmit();
  }
});
bindShortcuts($('orb'), field, {
  active: () => Boolean(call), holdMode: () => settings.inputMode === 'hold',
  press: startHold, release: releaseHold, mute: toggleMute, help: () => $('shortcuts').showModal(),
  escape() {
    if (held) releaseHold(false);
    else if ($('expand-transcript').getAttribute('aria-expanded') === 'true') expandTranscript(false);
    else if (callPhase(state) !== 'idle' || replay) interrupt();
  },
});
document.addEventListener('visibilitychange', prewarmVoice);
$('composer').onsubmit = event => {
  event.preventDefault();
  const text = field.value.trim();
  if (!text) return;
  field.value = '';
  resizeComposer();
  void send(text, undefined, undefined, textOnly);
};

if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/service-worker.js').catch(() => {});
setInterval(updateDuration, 250);
window.addEventListener('pagehide', () => {
  responsesSocket?.close();
  hangUp();
});
trace.save();
if (directMode) $('home').href = '/direct';
void refreshConnection();
