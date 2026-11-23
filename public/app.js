import { captureMicrophone, clock, RecognizerConnection, speechServer, SpeechPlayer } from './audio.js';
import { backendUrl, createConversation, openResponse, splitSpeech } from './responses.js';

const $ = id => document.getElementById(id);
const metrics = {
  asr: $('metric-asr'),
  text: $('metric-text'),
  audio: $('metric-audio'),
  interruption: $('metric-interruption'),
  speakable: $('metric-speakable'),
  queue: $('metric-queue'),
  synthesis: $('metric-synthesis'),
  pcm: $('metric-pcm'),
  gaps: $('metric-gaps'),
};
const messages = $('messages');
const field = $('message');
const dialog = $('settings');
let settings = {
  url: backendUrl(''), inputUrl: '', model: 'demo', key: '', instructions: '',
  context: 'history', reading: 'confirmed', silence: 0.5, duplex: false, voice: 0,
};
let conversation;
let call;
let turn;
let muted = false;
let micEpoch = 0;
let micBlocked = true;
let recognizing = false;
let speakingUser = false;
let asrReady = false;
let ttsReady = false;
let ttsEngine;
let interruption = '';
let history = [];

let endpointAt;
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
  const ready = [asrReady && 'SenseVoice', ttsReady && (ttsEngine === 'kokoro' ? 'Kokoro' : 'Matcha')].filter(Boolean);
  $('models').textContent = ready.length ? ready.join(' · ') + ' 已就绪' : '语音模型未加载';
}

function applyVoiceInfo({ engine, voices }) {
  if (ttsEngine === engine) return;
  ttsEngine = engine;
  const select = $('voice');
  select.replaceChildren(...voices.map(({ id, label }) => new Option(label, id)));
  if (!voices.some(({ id }) => id === settings.voice)) settings.voice = voices[0].id;
  select.value = String(settings.voice);
  select.disabled = voices.length < 2;
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
  } else if (speakingUser || recognizing) {
    state = 'recognizing';
    label = recognizing ? '正在识别' : '正在听你说';
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
  $('mute').textContent = muted ? '取消静音' : '静音';
  $('mute').setAttribute('aria-pressed', String(muted));
  $('mute').disabled = !call?.ready;
  $('interrupt').disabled = !busy;
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
  micEpoch++;
  endpointAt = undefined;
  if (call?.ready) asr.reset(micEpoch, settings.silence);
}

async function startCall() {
  showError();
  const started = { started: clock(), controller: new AbortController() };
  call = started;
  muted = false;
  render();
  updateDuration();
  const playback = player.resume();
  const recognition = asr.connect().then(() => { asrReady = true; renderModelStatus(); });
  const synthesis = speechServer.prepare(started.controller.signal).then(info => {
    if (call !== started) return;
    applyVoiceInfo(info);
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
  ended?.controller.abort();
  ended?.microphone?.stop();
  asr.close();
  muted = false;
  updateListening(true);
  interrupt();
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
  who.textContent = role === 'user' ? '你' : '助手';
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

function interrupt(note = true, detectedAt) {
  const previous = turn;
  const hadOutput = Boolean(previous && (!previous.ended || player.active));
  if (previous) {
    previous.ended = true;
    previous.controller.abort();
  }
  turn = undefined;
  player.stop();
  if (hadOutput) {
    for (const entry of previous.items.values()) {
      if (entry.display && entry.phase !== 'commentary') entry.display.row.dataset.interrupted = 'true';
    }
    if (previous.voice && note) {
      rememberAnswer(previous, previous.heard.join('\n'));
      const last = previous.heard.at(-1);
      interruption = last
        ? '上一轮语音回复被打断。最后完整播完的一句是「' + last + '」。后面的内容尚未完整播出。'
        : '上一轮语音回复被打断时，还没有完整播完一句。';
    }
  }
  if (detectedAt !== undefined && hadOutput) showMetric('interruption', clock() - detectedAt);
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
    if (call && !micBlocked) showError(event.message);
    return;
  }
  if (!call || micBlocked || event.epoch !== micEpoch) return;
  if (event.type === 'speech-start') {
    speakingUser = true;
    if (turn && (!turn.ended || player.active)) interrupt(true, clock());
  } else if (event.type === 'speech-end') {
    speakingUser = false;
    recognizing = true;
    endpointAt = clock();
  } else if (event.type === 'transcript') {
    speakingUser = false;
    recognizing = false;
    if (event.text) void send(event.text, { endpointAt: endpointAt ?? clock(), asrMs: event.asrMs });
  }
  render();
}

function enqueue(current, phrase) {
  if (!call?.ready || !ttsReady || current.controller.signal.aborted) return;
  current.voice = true;
  if (current.firstSpeakable === undefined) {
    current.firstSpeakable = clock();
    showMetric('speakable', current.firstSpeakable - current.sentAt);
  }
  player.enqueue({
    text: phrase,
    voice: current.settings.voice,
    onPcm(at, timing) {
      if (current.firstPcm) return;
      current.firstPcm = at;
      showMetric('pcm', at - current.firstSpeakable);
      showMetric('queue', timing['tts-queue']);
      showMetric('synthesis', timing['tts-first-pcm']);
    },
    onStart(at) {
      if (current.firstAudio) return;
      current.firstAudio = at;
      if (!current.gaps) showMetric('gaps', 0);
      $('metric-audio').previousElementSibling.textContent = current.timing ? '断句到首声' : '发送到首声';
      showMetric('audio', at - (current.timing?.endpointAt ?? current.sentAt));
    },
    onGap(gap) {
      current.gaps += gap;
      showMetric('gaps', current.gaps);
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
  if (!current.firstText) {
    current.firstText = clock();
    showMetric('text', current.firstText - current.sentAt);
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
    enqueue(current, phrase);
  }
}

function outputItem(current, key, item) {
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

function processEvent(current, event) {
  const key = event.output_index ?? event.item?.id ?? event.item_id;
  if (event.type === 'response.output_item.added' && event.item.type === 'message' && event.item.role === 'assistant') {
    itemEntry(current, key).phase = event.item.phase;
  } else if (event.type === 'response.output_text.delta') {
    const entry = itemEntry(current, key);
    entry.text += event.delta;
    entry.pendingSpeech += event.delta;
    updateText(current, entry);
    if (current.settings.reading === 'live') drain(current, entry, false);
  } else if (event.type === 'response.output_item.done') {
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
  if (!text.trim()) return;
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
  const current = {
    controller: new AbortController(), settings, items: new Map(), heard: [], timing, ended: false,
    voice: Boolean(call?.ready && ttsReady), gaps: 0,
  };
  turn = current;
  const previousInterruption = interruption;
  interruption = '';
  const { signal } = current.controller;
  render();
  try {
    if (current.settings.context === 'conversation' && !conversation) {
      const id = await createConversation(current.settings, signal);
      if (signal.aborted) return;
      conversation = id;
    }
    current.sentAt = clock();
    const events = await openResponse(current.settings, { conversation, messages: history.slice(-16), text, interruption: previousInterruption }, signal);
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
  } catch (error) {
    if (!signal.aborted) showError(error.message);
  } finally {
    current.ended = true;
    if (turn === current) render();
  }
}

function newSession() {
  interrupt(false);
  history = [];
  conversation = undefined;
  interruption = '';
  for (const entry of messages.querySelectorAll('.entry')) entry.remove();
  $('empty').hidden = false;
  for (const name of Object.keys(metrics)) showMetric(name);
  showError();
}

function openSettings() {
  $('base-url').value = settings.inputUrl;
  $('model').value = settings.model;
  $('api-key').value = settings.key;
  $('instructions').value = settings.instructions;
  $('context').value = settings.context;
  $('reading').value = settings.reading;
  $('silence').value = String(settings.silence);
  $('duplex').checked = settings.duplex;
  $('voice').value = String(settings.voice);
  showError(null, $('settings-error'));
  dialog.showModal();
}

$('open-settings').onclick = openSettings;
$('close-settings').onclick = () => dialog.close();
$('pipiclaw-preset').onclick = () => {
  $('base-url').value = 'http://127.0.0.1:8787/v1';
  $('model').value = 'pipiclaw';
  $('context').value = 'conversation';
};
$('settings-form').onsubmit = event => {
  event.preventDefault();
  try {
    const inputUrl = $('base-url').value.trim();
    const next = {
      url: backendUrl(inputUrl), inputUrl, model: inputUrl ? $('model').value.trim() : 'demo',
      key: inputUrl ? $('api-key').value.trim() : '', instructions: $('instructions').value.trim(),
      context: inputUrl ? $('context').value : 'history', reading: $('reading').value,
      silence: Number($('silence').value), duplex: $('duplex').checked, voice: Number($('voice').value),
    };
    if (!next.model) throw new Error('请填写模型名。');
    const switched = ['url', 'model', 'key', 'context'].some(key => settings[key] !== next[key]);
    const audioChanged = next.silence !== settings.silence || next.duplex !== settings.duplex;
    settings = next;
    if (switched) newSession();
    if (audioChanged) updateListening(true);
    $('backend-label').lastChild.textContent = inputUrl ? settings.model : '本地演示';
    dialog.close();
    render();
  } catch (error) {
    showError(error.message, $('settings-error'));
  }
};
void speechServer.info().then(applyVoiceInfo).catch(() => {});
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
render();
