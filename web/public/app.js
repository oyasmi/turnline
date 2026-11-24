import { captureMicrophone, clock, RecognizerConnection, speechServer, SpeechPlayer } from './audio.js';
import { ConversationUpdates, updateSpeech } from './conversation-updates.js';
import { checkDirectConnection, createConversation, isBackchannel, listConversationItems, normalizeDirectUrl,
  openResponse, splitSpeech } from './responses.js';
import { CallTrace } from './call-trace.js';
import { VoiceTurn } from './voice-turn.js';

const $ = id => document.getElementById(id);
const metrics = {
  asr: $('metric-asr'),
  text: $('metric-text'),
  endpointToRequest: $('metric-endpoint-request'),
  audio: $('metric-audio'),
  interruption: $('metric-interruption'),
  backendQueue: $('metric-backend-queue'),
  textWait: $('metric-text-wait'),
  speakable: $('metric-speakable'),
  queue: $('metric-queue'),
  synthesis: $('metric-synthesis'),
  pcm: $('metric-pcm'),
  gaps: $('metric-gaps'),
};
const messages = $('messages');
const field = $('message');
const dialog = $('settings');
const PREFERENCES = 'turnline.preferences.v1';
const ACTIVE_CONVERSATION = 'turnline.active-conversation.v1';
const DIRECT_ADDRESS = 'turnline.direct-address.v1';
const DIRECT_CREDENTIALS = 'turnline.direct-credentials.v1';
const directMode = location.pathname === '/direct';
const directDialog = $('direct-settings');
const relay = { mode: 'relay', url: '/api/pipiclaw/v1', model: 'pipiclaw', context: 'conversation' };

function stored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function store(key, value) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

function directSettings() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(DIRECT_CREDENTIALS));
    const url = normalizeDirectUrl(saved?.url || stored(DIRECT_ADDRESS) || '', location.origin);
    return { mode: 'direct', url, key: saved?.url === url ? saved.key : '' };
  } catch {
    return { mode: 'direct', url: '', key: '' };
  }
}

function saveDirectSettings(url, key) {
  store(DIRECT_ADDRESS, url);
  try {
    if (key) sessionStorage.setItem(DIRECT_CREDENTIALS, JSON.stringify({ url, key }));
    else sessionStorage.removeItem(DIRECT_CREDENTIALS);
  } catch {}
}

function preferences() {
  try {
    const saved = JSON.parse(stored(PREFERENCES));
    return {
      reading: saved?.reading === 'live' ? 'live' : 'confirmed',
      silence: [0.35, 0.5, 0.8, 1.2].includes(saved?.silence) ? saved.silence : 0.8,
      duplex: saved?.duplex === true,
      instructions: typeof saved?.instructions === 'string' ? saved.instructions.slice(0, 3000) : '',
    };
  } catch {
    return { reading: 'confirmed', silence: 0.8, duplex: false, instructions: '' };
  }
}

let settings = {
  ...preferences(), ...relay, ...(directMode ? directSettings() : {}), voice: 0,
};
let connection = 'checking';
let connectionDetail;
let connectionGeneration = 0;
let sessionPaired = false;
let relayAvailable = false;
let conversation;
let opening;
let updates;
let pendingUpdates = [];
let call;
let turn;
let barge;
let muted = false;
let micEpoch = 0;
let micBlocked = true;
let recognizing = false;
let speakingUser = false;
let asrReady = false;
let ttsReady = false;
let interruption = '';
let history = [];

const endpoints = new Map();
const voiceTurn = new VoiceTurn((text, timing) => void send(text, timing), render);
const trace = new CallTrace({ getItem: stored, setItem: store }, count => {
  $('export-timing').disabled = !count;
  $('trace-count').textContent = count ? '已记录 ' + count + ' 轮' : '暂无通话计时';
});
const asr = new RecognizerConnection(onRecognition);
const player = new SpeechPlayer(speechServer, () => {
  updateListening();
  render();
}, error => showError(error.message));

function showError(message, location = $('error')) {
  location.textContent = message ?? '';
  location.hidden = !message;
}

function showMetric(name, value) {
  metrics[name].textContent = value === undefined ? '—' : Math.max(0, Math.round(value)) + ' ms';
}

function renderModelStatus() {
  const ready = [asrReady && 'SenseVoice', ttsReady && 'Matcha'].filter(Boolean);
  $('models').textContent = ready.length ? ready.join(' · ') + ' 已就绪' : 'SenseVoice · Matcha';
}

function setMetric(current, name, value) {
  trace.metric(current.traceItem, name, value);
  if (turn === current) showMetric(name, value);
}

function renderConnection() {
  const { label, detail } = {
    checking: { label: '正在连接', detail: '正在检查连接。' },
    ready: { label: 'Pipiclaw 已连接', detail: '' },
    pair: { label: '等待配对', detail: '打开配对链接，或从 Turnline 服务端获取一次性配对码。' },
    setup: { label: '等待设置', detail: '填写你自己的 Pipiclaw 地址和 Key。' },
    offline: { label: 'Pipiclaw 离线', detail: '请启动 Pipiclaw，再重试连接。' },
    demo: { label: '离线演示', detail: '' },
  }[connection];
  $('backend-label').dataset.connection = connection;
  $('backend-label').lastChild.textContent = label;
  $('connection-panel').hidden = !detail;
  $('connection-detail').textContent = connectionDetail ?? detail;
  $('retry-connection').hidden = connection !== 'offline';
  $('pair-form').hidden = connection !== 'pair';
  $('setup-direct').hidden = !directMode || !sessionPaired || !['setup', 'offline'].includes(connection);
  $('edit-direct').hidden = !directMode || !sessionPaired;
  $('sign-out').hidden = !sessionPaired;
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
        addMessage(item.role === 'user' ? 'user' : 'assistant', text);
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

async function refreshConnection(pairing, directChecked = false) {
  const generation = ++connectionGeneration;
  connection = 'checking';
  connectionDetail = undefined;
  renderConnection();
  try {
    if (pairing) {
      const paired = await fetch('/api/pair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: pairing }), signal: AbortSignal.timeout(7_000),
      });
      if (generation !== connectionGeneration) return;
      if (!paired.ok) showError('配对码已使用或失效，请生成新的配对码。');
    }
    const path = directMode ? '/api/session?mode=direct' : '/api/session';
    const response = await fetch(path, { signal: AbortSignal.timeout(7_000), cache: 'no-store' });
    if (!response.ok) throw new Error('Connection check failed.');
    const { connection: state, relay: available } = await response.json();
    if (!['pair', 'ready', 'offline', 'demo', 'direct'].includes(state)) throw new Error('Bad connection state.');
    if (generation !== connectionGeneration) return;
    relayAvailable = available === true;
    sessionPaired = state !== 'pair' && state !== 'demo';
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

function acceptPairingLink() {
  const token = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (token) {
    window.history.replaceState(window.history.state, '', location.pathname + location.search);
    void refreshConnection(token);
  }
  return Boolean(token);
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
  const preparing = call && !call.ready;
  const busy = Boolean(turn && !turn.ended) || player.active;
  let state = 'idle';
  let label = '准备通话';
  let hint = '开麦后，说完一句稍作停顿即可发送。';
  if (preparing) {
    state = 'preparing';
    label = '正在准备';
    hint = '语音服务正在加载模型，请允许麦克风访问。';
  } else if (player.playing) {
    state = 'speaking';
    label = '正在播报';
    hint = settings.duplex && !muted ? '你可以直接开口插话。' : '点一下「打断」即可继续说。';
  } else if (speakingUser || recognizing || voiceTurn.waiting) {
    state = 'recognizing';
    label = recognizing ? '正在识别' : voiceTurn.waiting && !speakingUser ? '等你继续说' : '正在听你说';
    hint = '语音由 Turnline 服务处理。';
  } else if (busy) {
    state = 'thinking';
    label = player.active ? '正在合成' : '等待回复';
    hint = '收到正文后会显示在对话记录里。';
  } else if (call) {
    state = 'listening';
    label = muted ? '麦克风已静音' : '正在聆听';
    hint = muted ? '你仍可以输入文字消息。' : '说完稍作停顿即可发送。';
  }
  $('orb').dataset.state = state;
  $('status').textContent = label;
  $('hint').textContent = hint;
  $('call').textContent = call ? '挂断' : '开始通话';
  $('call').classList.toggle('hang-up', Boolean(call));
  $('call').disabled = !call && !canCall();
  field.disabled = !canCall();
  $('send-message').disabled = !canCall();
  $('mute').textContent = muted ? '取消静音' : '静音';
  $('mute').setAttribute('aria-pressed', String(muted));
  $('mute').disabled = !call?.ready;
  $('interrupt').disabled = !busy;
  if (pendingUpdates.length) queueMicrotask(speakNextUpdate);
}

function updateDuration() {
  const seconds = call ? Math.floor((clock() - call.started) / 1000) : 0;
  $('duration').textContent = [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}

function updateListening(force = false) {
  const blocked = !call?.ready || !asrReady || muted || (!settings.duplex && player.playing);
  if (!force && blocked === micBlocked) return;
  micBlocked = blocked;
  recognizing = false;
  speakingUser = false;
  releaseBarge();
  voiceTurn.reset();
  micEpoch++;
  endpoints.clear();
  if (call?.ready) asr.reset(micEpoch, settings.silence);
}

async function startCall() {
  if (!canCall()) return;
  showError();
  const started = { started: clock(), controller: new AbortController() };
  call = started;
  trace.start(started.started);
  muted = false;
  render();
  updateDuration();
  const playback = player.resume();
  const recognition = asr.connect().then(() => { asrReady = true; renderModelStatus(); });
  const synthesis = speechServer.prepare(started.controller.signal).then(() => {
    if (call !== started) return;
    ttsReady = true;
    renderModelStatus();
  });
  const microphone = captureMicrophone(samples => {
    if (call === started && !micBlocked) asr.frame(samples);
  }).then(microphone => {
    if (call !== started) microphone.stop();
    else started.microphone = microphone;
  });
  try {
    await Promise.all([playback, recognition, synthesis, microphone]);
    if (call !== started) return;
    started.ready = true;
    updateListening(true);
    render();
  } catch (error) {
    if (call !== started) return;
    hangUp();
    showError(error.name === 'NotAllowedError' ? '麦克风权限未开启。请在浏览器允许访问后重试。' : error.message);
  }
}

function hangUp() {
  const ended = call;
  call = undefined;
  pendingUpdates = [];
  ended?.controller.abort();
  ended?.microphone?.stop();
  asr.close();
  muted = false;
  interrupt(false, 'hangup');
  if (ended) trace.stop(clock());
  updateListening(true);
  updateDuration();
  render();
}

function addMessage(role, text = '') {
  $('empty').hidden = true;
  const row = document.createElement('article');
  const who = document.createElement('span');
  const content = document.createElement('p');
  const flag = document.createElement('span');
  row.className = 'entry ' + role;
  who.className = 'who';
  who.textContent = role === 'user' ? '你' : role === 'update' ? '会话更新' : '助手';
  content.className = 'content';
  content.textContent = text;
  flag.className = 'flag';
  flag.textContent = '已打断';
  row.append(who, content, flag);
  messages.append(row);
  scrollMessages();
  return { row, who, content };
}

function scrollMessages() {
  messages.scrollTop = messages.scrollHeight;
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
  addMessage('update', text);
  if (!speak || !call?.ready) return;
  const summary = updateSpeech(text);
  if (summary) {
    pendingUpdates.push(summary);
    if (pendingUpdates.length > 5) pendingUpdates.shift();
    speakNextUpdate();
  }
}

function speakNextUpdate() {
  if (!call?.ready || speakingUser || recognizing || player.active || (turn && !turn.ended)) return;
  const text = pendingUpdates.shift();
  if (text) {
    turn = undefined;
    player.enqueue({ text, voice: settings.voice });
  }
}

function releaseBarge() {
  if (!barge) return;
  barge = undefined;
  player.unpause();
}

function interrupt(note = true, reason = 'interrupted') {
  voiceTurn.reset();
  const previous = turn;
  const completedBeforeInterrupt = previous?.ended;
  const hadOutput = Boolean(previous && (!previous.ended || player.active));
  barge = undefined;
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
  if (hadOutput) {
    for (const entry of previous.items.values()) {
      if (entry.display && entry.phase !== 'commentary') entry.display.row.dataset.interrupted = 'true';
    }
    if (previous.traceItem && completedBeforeInterrupt) previous.traceItem.playback_interrupted = true;
    if (previous.voice && note) {
      rememberAnswer(previous, previous.heard.join('\n'));
      const last = previous.heard.at(-1);
      interruption = last
        ? '上一轮语音回复被打断。最后完整播完的一句是「' + last + '」。后面的内容尚未完整播出。'
        : '上一轮语音回复被打断时，还没有完整播完一句。';
    }
  }
  render();
}

function onRecognition(event) {
  if (event.type === 'fatal') {
    asrReady = false;
    renderModelStatus();
    if (call) {
      hangUp();
      showError(event.message);
    }
    return;
  }
  if (event.type === 'error') {
    if (call && !micBlocked) {
      releaseBarge();
      showError(event.message);
    }
    return;
  }
  if (!call || micBlocked || event.epoch !== micEpoch) return;
  if (event.type === 'speech-start') {
    speakingUser = true;
    voiceTurn.started();
    if (!barge && (player.active || (turn && !turn.ended))) {
      const candidate = { started: clock() };
      barge = candidate;
      void player.pause().then(() => {
        if (barge === candidate) {
          const elapsed = clock() - candidate.started;
          showMetric('interruption', elapsed);
          trace.metric(turn?.traceItem, 'interruption', elapsed);
        }
      }).catch(error => showError(error.message));
    }
  } else if (event.type === 'speech-end') {
    speakingUser = false;
    recognizing = true;
    endpoints.set(event.segment, clock());
  } else if (event.type === 'transcript') {
    const endpointAt = endpoints.get(event.segment);
    endpoints.delete(event.segment);
    recognizing = endpoints.size > 0;
    const text = event.text.trim();
    if (text && !isBackchannel(text)) {
      voiceTurn.accept(text, { endpointAt: endpointAt ?? clock(), asrMs: event.asrMs });
    } else {
      voiceTurn.finish();
      releaseBarge();
    }
  }
  render();
}

function enqueue(current, phrase, firstTextAt) {
  if (!current.voice || !call?.ready || current.controller.signal.aborted) return;
  if (current.firstSpeakable === undefined) {
    current.firstSpeakable = clock();
    setMetric(current, 'speakable', current.firstSpeakable - current.sentAt);
    if (firstTextAt !== undefined) setMetric(current, 'textWait', current.firstSpeakable - firstTextAt);
  }
  player.enqueue({
    text: phrase,
    voice: current.settings.voice,
    onPcm(at, timing) {
      if (current.firstPcm) return;
      current.firstPcm = at;
      setMetric(current, 'pcm', at - current.firstSpeakable);
      setMetric(current, 'queue', timing['tts-queue']);
      setMetric(current, 'synthesis', timing['tts-first-pcm']);
    },
    onStart(at) {
      if (current.firstAudio) return;
      current.firstAudio = at;
      if (!current.gaps) setMetric(current, 'gaps', 0);
      $('metric-audio').previousElementSibling.textContent = current.timing ? '断句到首声' : '发送到首声';
      setMetric(current, 'audio', at - (current.timing?.endpointAt ?? current.sentAt));
    },
    onGap(gap) {
      current.gaps += gap;
      setMetric(current, 'gaps', current.gaps);
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
  entry.display ??= addMessage('assistant');
  const commentary = entry.phase === 'commentary';
  entry.display.row.classList.toggle('commentary', commentary);
  entry.display.who.textContent = commentary ? '进度' : '助手';
  entry.display.content.textContent = entry.text;
  scrollMessages();
}

function drain(current, entry, finish) {
  if (entry.phase === 'commentary') return;
  const split = splitSpeech(entry.pendingSpeech, finish);
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
  entry.phase = item.phase;
  const finalText = item.content?.filter(part => part.type === 'output_text').map(part => part.text).join('\n');
  entry.text = finalText || entry.text;
  updateText(current, entry);
  if (current.settings.reading === 'confirmed' || !entry.spoken) entry.pendingSpeech = entry.text;
  drain(current, entry, true);
}

function stopProgress(current) {
  clearTimeout(current.progressTimer);
  current.progressTimer = undefined;
}

function toolProgress(current) {
  if (!current.voice || current.progressSpoken || current.progressTimer || current.firstSpeakable) return;
  current.progressTimer = setTimeout(() => {
    if (turn !== current || current.ended || current.firstSpeakable || barge || !call?.ready) return;
    current.progressSpoken = true;
    player.enqueue({
      text: current.progressText,
      voice: current.settings.voice,
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

async function send(text, timing) {
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
  addMessage('user', text);
  history.push({ role: 'user', content: text });
  if (history.length > 16) history.splice(0, history.length - 16);
  const startedAt = clock();
  const current = {
    startedAt, traceItem: trace.begin(startedAt, timing ? 'voice' : 'text'),
    controller: new AbortController(), settings, items: new Map(), tools: new Set(), heard: [], timing, ended: false,
    voice: Boolean(call?.ready && ttsReady), gaps: 0,
    progressText: /[A-Za-z]/.test(text) && !/\p{Script=Han}/u.test(text)
      ? 'I’m checking. One moment.' : '我在查，稍等一下。',
  };
  turn = current;
  if (timing) setMetric(current, 'asr', timing.asrMs);
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
        } else {
          sessionPaired = false;
          connection = 'pair';
        }
        renderConnection();
      }
    }
  } finally {
    stopProgress(current);
    current.ended = true;
    if (turn === current) render();
  }
}

function newSession({ forget = true } = {}) {
  opening?.controller.abort();
  opening = undefined;
  if (forget) store(conversationKey());
  updates?.stop();
  updates = undefined;
  pendingUpdates = [];
  interrupt(false, 'new_conversation');
  history = [];
  conversation = undefined;
  interruption = '';
  for (const entry of messages.querySelectorAll('.entry')) entry.remove();
  $('empty').hidden = false;
  for (const name of Object.keys(metrics)) showMetric(name);
  showError();
}

function openSettings() {
  $('instructions').value = settings.instructions;
  $('reading').value = settings.reading;
  $('silence').value = String(settings.silence);
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
    void refreshConnection(undefined, true);
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
$('pair-form').onsubmit = event => {
  event.preventDefault();
  const code = $('pair-code').value.trim();
  $('pair-code').value = '';
  if (code) {
    showError();
    void refreshConnection(code);
  }
};

$('open-settings').onclick = openSettings;
$('close-settings').onclick = () => dialog.close();
$('settings-form').onsubmit = event => {
  event.preventDefault();
  const next = {
    reading: $('reading').value, silence: Number($('silence').value),
    duplex: $('duplex').checked, instructions: $('instructions').value.trim(),
  };
  const audioChanged = next.silence !== settings.silence || next.duplex !== settings.duplex;
  settings = { ...settings, ...next };
  store(PREFERENCES, JSON.stringify(next));
  if (audioChanged) updateListening(true);
  dialog.close();
  render();
};
$('retry-connection').onclick = () => void refreshConnection();
$('export-timing').onclick = () => trace.download();
$('sign-out').onclick = async () => {
  try {
    const response = await fetch('/api/sign-out', { method: 'POST', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error();
    dialog.close();
    hangUp();
    newSession();
    if (directMode) {
      saveDirectSettings(settings.url, '');
      settings = { ...settings, key: '' };
    }
    void refreshConnection();
  } catch {
    showError('退出失败，请重试。');
  }
};
$('call').onclick = () => call ? hangUp() : void startCall();
$('mute').onclick = () => {
  muted = !muted;
  call?.microphone?.setEnabled(!muted);
  updateListening(true);
  render();
};
$('interrupt').onclick = () => interrupt();
$('new-session').onclick = newSession;
$('composer').onsubmit = event => {
  event.preventDefault();
  const text = field.value.trim();
  if (!text) return;
  field.value = '';
  void send(text);
};

setInterval(updateDuration, 250);
window.addEventListener('pagehide', hangUp);
window.addEventListener('hashchange', acceptPairingLink);
trace.save();
if (directMode) $('home').href = '/direct';
if (!acceptPairingLink()) void refreshConnection();
render();
