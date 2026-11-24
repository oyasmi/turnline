import { clock } from './audio.js';
import { openCallAudio, closeCallAudio } from './call-audio.js';
import { VoiceSession } from './voice-session.js';
import { SpeechPlayer } from './player.js';
import { BargeIn, matchesEcho } from './barge-in.js';
import { callPhase, captureMode, initialCallState, reduceCall } from './call-state.js';
import { renderCall, showLevel, showThinking } from './call-view.js';
import { ConversationUpdates, updateSpeech } from './conversation-updates.js';
import { checkDirectConnection, createConversation, isBackchannel, listConversationItems, normalizeDirectUrl,
  openResponse } from './responses.js';
import { splitSpeech } from './chunker.js';
import { directSettings, preferences, saveDirectSettings, savePreferences, store, stored } from './settings.js';
import { Transcript } from './transcript.js';
import { CallTrace } from './call-trace.js';

const $ = id => document.getElementById(id);
const metrics = {
  asr: $('metric-asr'),
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
const transcript = new Transcript($('messages'), $('empty'));
const field = $('message');
const dialog = $('settings');
const diagnostics = $('diagnostics');
const ACTIVE_CONVERSATION = 'turnline.active-conversation.v1';
const directMode = location.pathname === '/direct';
const directDialog = $('direct-settings');
const relay = { mode: 'relay', url: '/api/pipiclaw/v1', model: 'pipiclaw', context: 'conversation' };

let settings = {
  ...preferences(), ...relay, ...(directMode ? directSettings() : {}),
};
let connection = 'checking';
let connectionDetail;
let connectionGeneration = 0;
let relayAvailable = false;
let conversation;
let opening;
let updates;
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

const trace = new CallTrace({ getItem: stored, setItem: store }, count => {
  $('export-timing').disabled = !count;
  $('trace-count').textContent = count ? '已记录 ' + count + ' 轮' : '暂无通话计时';
});
const voice = new VoiceSession(onVoice);
const player = new SpeechPlayer(voice, onPlayback);
const barge = new BargeIn(player, onBarge);

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
}

function showMetric(name, value) {
  metrics[name].textContent = value === undefined ? '—' : Math.max(0, Math.round(value)) + ' ms';
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
    ready: { label: 'Pipiclaw 已连接', detail: '' },
    setup: { label: '等待设置', detail: '填写你自己的 Pipiclaw 地址和 Key。' },
    offline: { label: 'Pipiclaw 离线', detail: '请启动 Pipiclaw，再重试连接。' },
    demo: { label: '离线演示', detail: '' },
  }[connection];
  $('backend-label').dataset.connection = connection;
  $('backend-label').lastChild.textContent = label;
  $('connection-panel').hidden = !detail;
  $('connection-detail').textContent = connectionDetail ?? detail;
  $('retry-connection').hidden = connection !== 'offline';
  $('setup-direct').hidden = !directMode || !['setup', 'offline'].includes(connection);
  $('edit-direct').hidden = !directMode;
  $('switch-mode').hidden = !relayAvailable;
  $('switch-mode').href = directMode ? '/' : '/direct';
  $('switch-mode').textContent = directMode ? '服务端中转' : '浏览器直连';
  render();
}

function canCall() { return connection === 'ready' || connection === 'demo'; }

function watchConversation(id, cursor) {
  updates?.stop();
  updates = new ConversationUpdates(settings, id, () => !turn || turn.ended, showConversationUpdate, cursor);
}

async function restoreConversation(generation) {
  const key = conversationKey();
  const id = stored(key);
  if (!/^conv_[a-f0-9]{32}$/.test(id ?? '') || conversation) return;
  try {
    const page = await listConversationItems(settings, id, undefined, AbortSignal.timeout(5_000), 'desc');
    if (generation !== connectionGeneration || conversation || opening) return;
    conversation = id;
    for (const item of page.data.slice().reverse()) {
      if (item.type !== 'message' || item.status !== 'completed') continue;
      const text = item.content.map(part => part.text).filter(Boolean).join('\n');
      if (text && (item.role === 'user' || item.phase === 'final_answer')) {
        transcript.add(item.role === 'user' ? 'user' : 'assistant', text);
      }
    }
    watchConversation(id, page.data[0]?.id);
  } catch (error) {
    if (generation === connectionGeneration && !conversation && error.status === 404) store(key);
  }
}

function conversationKey() {
  return directMode ? ACTIVE_CONVERSATION + ':' + settings.url : ACTIVE_CONVERSATION;
}

function directFailure(error) {
  return error.status === 401 ? 'Pipiclaw 拒绝了这把 Key，请核对或更换 Key。' : error.message;
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
    const { connection: state, relay: available } = await response.json();
    if (!['ready', 'offline', 'demo', 'direct'].includes(state)) throw new Error('Bad connection state.');
    if (generation !== connectionGeneration) return;
    relayAvailable = available === true;
    connection = state;
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
  if (generation === connectionGeneration) renderConnection();
}

function ensureConversation() {
  if (conversation) return Promise.resolve(conversation);
  if (opening) return opening.promise;
  const controller = new AbortController();
  const attempt = { controller };
  const key = conversationKey();
  opening = attempt;
  attempt.promise = createConversation(settings, controller.signal).then(id => {
    if (opening !== attempt) throw new DOMException('Conversation changed', 'AbortError');
    conversation = id;
    store(key, id);
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
    busy: Boolean(turn && !turn.ended) || player.active || player.playing,
  });
}

function updateDuration() {
  const seconds = call ? Math.floor((clock() - call.started) / 1000) : 0;
  $('duration').textContent = [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}

function clearInput() {
  barge.clear();
  player.gain(1, 35);
  transcript.clearDraft();
  inputTelemetry = undefined;
  voice.reset();
  dispatch({ type: 'reset-input' });
}

async function startCall() {
  if (!canCall()) return;
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
  readyModels = false;
  previousCommit = previousOutput = undefined;
  trace.start(started.started);
  dispatch({ type: 'connect' });
  renderModelStatus();
  updateDuration();
  if (settings.context === 'conversation') void ensureConversation().catch(() => {});
  try {
    await openCallAudio(started, voice, player, {
      speed: settings.speed,
      expectingAnswer,
      onFrame: onCapture,
      muted: () => state.muted,
      switched: clearInput,
      showError,
    });
    if (signal.aborted) return;
    readyModels = started.ready = true;
    dispatch({ type: 'ready' });
    renderModelStatus();
    if (settings.tones) player.tone('connect');
  } catch (error) {
    if (signal.aborted) return;
    hangUp();
    showError(error.name === 'NotAllowedError' ? '麦克风权限未开启。请在浏览器允许访问后重试。' : error.message);
  }
}

function hangUp() {
  const ended = call;
  call = undefined;
  voiceQueue = [];
  pendingUpdates = [];
  dispatch({ type: 'hangup' });
  ended?.controller.abort();
  transcript.clearDraft();
  voice.close();
  interrupt(false, 'hangup');
  if (ended) {
    trace.stop(clock());
    closeCallAudio(ended, player, settings.tones);
  }
  updateDuration();
  render();
}

function onCapture({ samples, rms, fastStart }, at) {
  if (state.muted) return;
  if (settings.duplex && player.playing && !state.barge && state.input === 'quiet' && fastStart) {
    barge.duck(at - 64, player.echoReferences);
  }
  if (!player.playing || state.input !== 'quiet' && !state.barge) showLevel(rms);
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

function drainWaiting() {
  if (!canCall() || state.input !== 'quiet' || state.output !== 'idle' || turn && !turn.ended) return;
  if (['connecting', 'reconnecting'].includes(state.connection)) return;
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
  const previous = turn;
  const fragment = player.heardFragment;
  const completedBeforeInterrupt = previous?.ended;
  const hadOutput = Boolean(previous && (!previous.ended || player.active));
  barge.clear();
  if (previous) {
    if (!previous.ended) {
      updates?.interrupted();
      trace.finish(previous.traceItem, reason, clock() - previous.startedAt);
    }
    stopProgress(previous);
    previous.ended = true;
    previous.controller.abort();
  }
  turn = undefined;
  player.stop();
  showThinking(false);
  dispatch({ type: 'playback-ended', waiting: false });
  if (hadOutput) {
    for (const entry of previous.items.values()) {
      if (entry.display && entry.phase !== 'commentary') entry.display.row.dataset.interrupted = 'true';
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
      transcript.clearDraft();
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
      if (event.type === 'playback-silent') player.gain(1, 35);
      if (event.references?.length) {
        previousOutput = { references: event.references, at: event.tailAt ?? clock() };
      }
      barge.clear();
      dispatch({ ...event, type: 'playback-ended', waiting: Boolean(turn && !turn.ended || player.active) });
      break;
    case 'playback-level':
      if (player.playing && (state.input === 'quiet' || state.barge)) showLevel(event.rms);
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
  if (!call) return;
  if (event.type === 'fatal') {
    readyModels = false;
    renderModelStatus();
    hangUp();
    showError(event.message);
    return;
  }
  if (['reconnecting', 'input-gap', 'input-error'].includes(event.type)) {
    if (event.input !== undefined && event.input !== state.inputId) return;
    barge.clear();
    player.gain(1, 70);
    transcript.clearDraft();
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
    transcript.resumeDraft();
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
    transcript.showDraft(text);
  } else if (event.type === 'tentative') {
    dispatch(event);
    const voiceEnd = voice.captureTime(event.voiceEndSample);
    transcript.showDraft(text, event.waitMs - (voiceEnd === undefined ? 0 : at - voiceEnd));
  } else if (event.type === 'commit') {
    const telemetry = inputTelemetry;
    inputTelemetry = undefined;
    dispatch(event);
    player.gain(1, 35);
    const echo = telemetry.echoRisk && !telemetry.stopAt && (
      matchesEcho(text, telemetry.references) || matchesEcho(text, player.echoReferences) ||
      matchesEcho(text, previousOutput?.references)
    );
    if (!text || isBackchannel(text) || echo) {
      transcript.clearDraft();
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
      display: transcript.finalizeDraft(text),
    };
    previousCommit = timing;
    if (settings.tones) player.tone('commit');
    voiceQueue.push(timing);
    drainWaiting();
  }
}

function enqueue(current, phrase, firstTextAt) {
  if (!current.voice || !call?.ready || current.controller.signal.aborted) return;
  if (current.firstSpeakable === undefined) {
    current.firstSpeakable = clock();
    setMetric(current, 'speakable', current.firstSpeakable - current.sentAt);
    if (firstTextAt !== undefined) setMetric(current, 'textWait', current.firstSpeakable - firstTextAt);
  }
  player.enqueue(current.playback, {
    text: phrase,
    speed: current.settings.rate,
    onPcm(at, timing) {
      if (current.firstPcm) return;
      current.firstPcm = at;
      setMetric(current, 'pcm', at - current.firstSpeakable);
      setMetric(current, 'queue', timing.queue);
      setMetric(current, 'synthesis', timing.synthesis);
    },
    onStart(at) {
      if (current.firstAudio) return;
      current.firstAudio = at;
      if (!current.gaps) setMetric(current, 'gaps', 0);
      $('metric-audio').previousElementSibling.textContent = current.timing ? '提交到首声' : '发送到首声';
      setMetric(current, 'audio', at - (current.timing?.endpointAt ?? current.sentAt));
      if (current.timing) setMetric(current, 'perceived', at - current.timing.voiceEndAt);
      showThinking(false);
    },
    onEnd() { current.heard.push(phrase); },
  });
}

function itemEntry(current, key) {
  let entry = current.items.get(key);
  if (!entry) {
    entry = { text: '', pendingSpeech: '', phase: undefined, spoken: false, done: false };
    current.items.set(key, entry);
  }
  return entry;
}

function updateText(current, entry) {
  if (!entry.text.trim()) return;
  entry.firstTextAt ??= clock();
  if (!current.firstText) {
    current.firstText = entry.firstTextAt;
    setMetric(current, 'text', current.firstText - current.sentAt);
  }
  entry.display ??= transcript.add('assistant');
  const follow = transcript.following();
  const commentary = entry.phase === 'commentary';
  entry.display.row.classList.toggle('commentary', commentary);
  entry.display.who.textContent = commentary ? '进度' : '助手';
  entry.display.content.textContent = entry.text;
  if (follow) transcript.scroll();
}

function drain(current, entry, finish) {
  if (!current.voice || entry.phase === 'commentary') return;
  const split = splitSpeech(entry.pendingSpeech, finish, !current.firstSpeakable);
  entry.pendingSpeech = split.rest;
  for (const phrase of split.phrases) {
    entry.spoken = true;
    enqueue(current, phrase, entry.firstTextAt);
  }
}

function outputItem(current, key, item) {
  updates?.track(item.id);
  if (item.type !== 'message' || item.role !== 'assistant') return;
  const entry = itemEntry(current, key);
  if (entry.done) return;
  entry.done = true;
  entry.phase = item.phase ?? entry.phase;
  const spokenPrefix = entry.text.slice(0, entry.text.length - entry.pendingSpeech.length);
  const finalText = item.content?.filter(part => part.type === 'output_text').map(part => part.text).join('\n');
  entry.text = finalText || entry.text;
  updateText(current, entry);
  if (current.settings.reading === 'confirmed' || !entry.spoken) entry.pendingSpeech = entry.text;
  else if (entry.text.startsWith(spokenPrefix)) entry.pendingSpeech = entry.text.slice(spokenPrefix.length);
  drain(current, entry, true);
}

function stopProgress(current) {
  clearTimeout(current.progressTimer);
  current.progressTimer = undefined;
}

function toolProgress(current) {
  if (!current.voice || current.progressSpoken || current.progressTimer || current.firstSpeakable) return;
  current.progressTimer = setTimeout(() => {
    if (turn !== current || current.ended || current.firstSpeakable || state.barge || !call?.ready) return;
    current.progressSpoken = true;
    player.enqueue(current.playback, {
      text: current.progressText,
      speed: current.settings.rate,
      onStart() { if (current.traceItem) current.traceItem.progress_spoken = true; },
    });
  }, 1800);
}

function processEvent(current, event) {
  const key = event.output_index ?? event.item?.id ?? event.item_id;
  if (event.type === 'response.created' && event.response?.id && current.traceItem) {
    current.traceItem.response_id = event.response.id;
  }
  if (event.type === 'response.queued' || (event.type === 'response.created' && event.response?.status === 'queued')) {
    current.backendQueuedAt ??= clock();
  } else if (event.type === 'response.in_progress' || (event.type === 'response.created' && event.response?.status === 'in_progress')) {
    setMetric(current, 'backendQueue', current.backendQueuedAt === undefined ? 0 : clock() - current.backendQueuedAt);
  } else if (event.type === 'response.output_item.added') {
    if (event.item.type === 'mcp_call') {
      current.tools.add(key);
      toolProgress(current);
    }
    if (event.item.type === 'message' && event.item.role === 'assistant') {
      updates?.track(event.item.id);
      itemEntry(current, key).phase = event.item.phase;
      if (event.item.phase === 'final_answer') stopProgress(current);
    }
  } else if (event.type === 'response.output_text.delta') {
    const entry = itemEntry(current, key);
    entry.text += event.delta;
    entry.pendingSpeech += event.delta;
    updateText(current, entry);
    if (current.settings.reading === 'live') drain(current, entry, false);
  } else if (event.type === 'response.output_item.done') {
    if (event.item.type === 'mcp_call') {
      current.tools.delete(key);
      if (!current.tools.size) stopProgress(current);
    }
    outputItem(current, key, event.item);
  } else if (event.type === 'response.completed') {
    for (const [index, item] of (event.response.output ?? []).entries()) outputItem(current, index, item);
    return true;
  } else if (['error', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) {
    throw new Error(event.error?.message ?? event.response?.error?.message ?? '后端在回复完成前结束了请求。');
  }
  return false;
}

async function send(text, timing, display) {
  if (!canCall() || !text.trim()) return;
  if (text.length > 12000) {
    showError('这条消息过长，请分段发送。');
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
  const current = {
    startedAt, traceItem: trace.begin(startedAt, timing ? 'voice' : 'text'),
    controller: new AbortController(), settings, items: new Map(), tools: new Set(), heard: [], timing, ended: false,
    voice: Boolean(call?.ready && readyModels), gaps: 0,
    progressText: /[A-Za-z]/.test(text) && !/\p{Script=Han}/u.test(text)
      ? 'I’m checking. One moment.' : '我在查，稍等一下。',
  };
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
  const thinkingTimer = setTimeout(() => {
    if (turn === current && !current.firstSpeakable) showThinking(true);
  }, 1200);
  const previousInterruption = interruption;
  interruption = '';
  const { signal } = current.controller;
  render();
  try {
    if (current.settings.context === 'conversation') await ensureConversation();
    if (signal.aborted) return;
    current.sentAt = clock();
    if (timing) setMetric(current, 'endpointToRequest', current.sentAt - timing.endpointAt);
    const events = await openResponse(current.settings, {
      conversation, messages: history.slice(-16), text, voice: current.voice, interruption: previousInterruption,
    }, signal);
    let completed = false;
    for await (const event of events) {
      if (signal.aborted || turn !== current) return;
      if (processEvent(current, event)) {
        completed = true;
        break;
      }
    }
    if (!completed) throw new Error('回复提前断开。可查看已有文字或发送下一条。');
    const answer = Array.from(current.items.values())
      .filter(entry => entry.phase !== 'commentary')
      .map(entry => entry.text).filter(Boolean).join('\n');
    rememberAnswer(current, answer);
    expectingAnswer = /[？?][”’」』"]?\s*$/u.test(answer);
    voice.configure(settings.speed, expectingAnswer);
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
        } else {
          showError('正在刷新浏览器会话，请稍后重新发送。');
          void refreshConnection();
        }
      }
    }
  } finally {
    clearTimeout(thinkingTimer);
    stopProgress(current);
    current.ended = true;
    if (turn === current) {
      showThinking(false);
      if (current.playback) player.seal(current.playback);
      else dispatch({ type: 'playback-ended', waiting: false });
    }
  }
}

function newSession({ forget = true } = {}) {
  opening?.controller.abort();
  opening = undefined;
  if (forget) store(conversationKey());
  updates?.stop();
  updates = undefined;
  pendingUpdates = [];
  voiceQueue = [];
  previousCommit = previousOutput = undefined;
  expectingAnswer = false;
  voice.configure(settings.speed, expectingAnswer);
  clearInput();
  interrupt(false, 'new_conversation');
  history = [];
  conversation = undefined;
  interruption = '';
  transcript.clear();
  for (const name of Object.keys(metrics)) showMetric(name);
  showError();
}

function openSettings() {
  $('instructions').value = settings.instructions;
  $('reading').value = settings.reading;
  $('speed').value = settings.speed;
  $('rate').value = String(settings.rate);
  $('tones').checked = settings.tones;
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
    if (!key || /[^\x21-\x7e]/.test(key)) throw new Error('请输入完整的 Pipiclaw Key。');
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
    tones: $('tones').checked, duplex: $('duplex').checked, instructions: $('instructions').value.trim(),
  };
  const duplexChanged = next.duplex !== settings.duplex;
  settings = { ...settings, ...next };
  savePreferences(next);
  voice.configure(settings.speed, expectingAnswer);
  if (duplexChanged) clearInput();
  dialog.close();
  render();
};
$('retry-connection').onclick = () => void refreshConnection();
$('export-timing').onclick = () => trace.download();
$('call').onclick = () => call ? hangUp() : void startCall();
$('mute').onclick = () => {
  dispatch({ type: 'mute' });
  call?.microphone?.setEnabled(!state.muted);
  clearInput();
};
$('interrupt').onclick = () => interrupt();
$('orb').onclick = () => {
  if (callPhase(state) === 'speaking') interrupt();
  else voice.send({ type: 'force-commit' });
};
$('new-session').onclick = newSession;
const composerToggle = $('toggle-composer');
composerToggle.onclick = () => {
  const composer = $('composer');
  const open = composer.hidden;
  composer.hidden = !open;
  composerToggle.setAttribute('aria-expanded', String(open));
  composerToggle.textContent = open ? '收起文字' : '文字输入';
  if (open && !field.disabled) field.focus();
};
$('composer').onsubmit = event => {
  event.preventDefault();
  const text = field.value.trim();
  if (!text) return;
  field.value = '';
  void send(text);
};

setInterval(updateDuration, 250);
window.addEventListener('pagehide', hangUp);
trace.save();
if (directMode) $('home').href = '/direct';
void refreshConnection();
