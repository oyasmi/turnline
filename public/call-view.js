import { callPhase } from './call-state.js';
import { CallScope } from './scope.js';

const $ = id => document.getElementById(id);
const scope = new CallScope($('call-scope'));
let waiting = 0;
let tool = false;
let toolLabel;

export function setIcon(element, name) {
  element.querySelector('use')?.setAttribute('href', '/assets/icons.svg#' + name);
}

export function renderCall(state, { canCall, duplex, pendingPlayback, busy, holdMode, held, signal, slow }) {
  const phase = callPhase(state);
  const connected = state.connection === 'ready';
  const active = state.connection !== 'idle';
  let [label, hint] = {
    idle: connected ? ['麦克风已静音', '你仍可以输入文字消息。'] : ['准备通话', '开麦后，说完一句稍作停顿即可发送。'],
    preparing: ['正在准备', '请允许麦克风访问。'],
    reconnecting: ['正在重连', '通话会自动恢复。'],
    listening: holdMode ? ['等待你说话', '按住光球或空格，松开发送。'] : ['正在聆听', '说完稍作停顿即可发送。'],
    recognizing: ['正在听你说', '点光球可以立即发送。'],
    pausing: ['等你继续说', '点光球可以立即发送。'],
    thinking: [tool ? (toolLabel || '正在查询') : pendingPlayback ? '正在合成' : waiting >= 2 ? '正在思考' : '等待回复',
      tool ? '正在等待 PipiClaw 工具返回。' : '回复也会显示在对话记录里。'],
    speaking: ['正在播报', duplex && !state.muted ? '你可以直接开口插话。' : '点光球或「打断」即可继续说。'],
  }[phase];
  if (held && connected && !state.muted) [label, hint] = ['正在听你说', '松开发送语音。'];
  if (state.congested && connected) hint = '网络较慢，正在补传麦克风音频。';
  else if (slow && connected) hint = '网络较慢，回复可能延迟。';

  const orb = $('orb');
  const orbPhase = held && connected ? 'recognizing' : phase;
  orb.dataset.state = orbPhase;
  orb.dataset.held = String(Boolean(held && connected && !state.muted));
  orb.disabled = !active
    ? !canCall
    : !connected || !(holdMode && !state.muted || ['speaking', 'recognizing', 'pausing'].includes(phase));
  orb.setAttribute('aria-label', !active
    ? '开启语音通话'
    : holdMode && !state.muted ? '按住说话' : phase === 'speaking' ? '打断播报' : '立即发送语音');
  scope.update(!$('error').hidden && ['idle', 'listening'].includes(phase) ? 'error' : orbPhase, state.barge, waiting);
  if ($('status').textContent !== label) $('status').textContent = label;
  $('hint').textContent = hint;
  $('duration').hidden = !active;
  const modeBadge = $('mode-badge');
  modeBadge.hidden = active;
  modeBadge.textContent = holdMode ? '按住说话' : '自动断句';
  const call = $('call');
  call.querySelector('span').textContent = active ? '挂断' : '开始通话';
  call.classList.toggle('hang-up', active);
  setIcon(call, active ? 'hangup' : 'phone');
  call.disabled = !active && !canCall;
  $('message').disabled = !canCall;
  $('send-message').disabled = !canCall;
  $('text-only').hidden = !active;
  for (const chip of document.querySelectorAll('.prompt-chip')) chip.disabled = !canCall;
  const mute = $('mute');
  const muteLabel = state.muted ? '取消静音' : '静音';
  mute.querySelector('span').textContent = muteLabel;
  mute.setAttribute('aria-label', muteLabel);
  mute.title = muteLabel;
  setIcon(mute, state.muted ? 'mic-off' : 'mic');
  mute.setAttribute('aria-pressed', String(state.muted));
  mute.hidden = !active;
  mute.disabled = !connected;
  $('toggle-composer').hidden = !active;
  $('interrupt').hidden = !active && !busy;
  $('interrupt').disabled = !busy;
  $('shortcut-hint').hidden = !active;
  $('shortcut-keys').innerHTML = holdMode
    ? '<kbd>Space</kbd> 按住说话 <span>·</span> <kbd>M</kbd> 静音 <span>·</span> <kbd>Esc</kbd> 打断'
    : '<kbd>Space</kbd> 按住插话 <span>·</span> <kbd>M</kbd> 静音 <span>·</span> <kbd>Esc</kbd> 打断';
  const indicator = $('signal');
  indicator.hidden = !active || !signal;
  if (signal) {
    indicator.dataset.quality = signal;
    indicator.title = '连接质量：' + { good: '好', fair: '一般', poor: '差' }[signal];
    indicator.lastElementChild.textContent = indicator.title;
  }
  document.documentElement.toggleAttribute('data-in-call', active);
  const favicon = $('favicon');
  const source = '/assets/icons/turnline' + (active ? '-call' : '') + '.svg';
  if (favicon.getAttribute('href') !== source) favicon.href = source;
  updateCallTitle();
}

export function updateCallTitle() {
  const active = document.documentElement.hasAttribute('data-in-call');
  const title = active ? '● ' + $('duration').textContent + ' · ' + $('status').textContent + ' — Turnline' : 'Turnline · 语音通话';
  if (title !== document.title) document.title = title;
}

export function showLevel(channel, rms) { scope.level(channel, rms); }

export function showWaiting(stage, hasTool, label) {
  waiting = stage;
  tool = hasTool;
  toolLabel = hasTool ? label : undefined;
}

export function showDraft(text, remaining) {
  const caption = $('stage-caption');
  caption.dataset.kind = 'draft';
  caption.textContent = text || '';
  caption.scrollTop = caption.scrollHeight;
  const progress = $('stage-progress');
  progress.hidden = remaining === undefined;
  if (remaining === undefined) {
    scope.countdown(0);
    return;
  }
  const track = document.createElement('span');
  track.style.setProperty('--wait', Math.max(0, remaining) + 'ms');
  progress.firstElementChild.replaceWith(track);
  scope.countdown(remaining);
}

export function speakCaption(text, heard = '') {
  const caption = $('stage-caption');
  if (caption.dataset.kind === 'draft' && caption.textContent) return;
  caption.dataset.kind = 'assistant';
  const rest = document.createElement('span');
  const captionText = value => value.replace(/[*`\[\]]|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '');
  rest.textContent = captionText(text.slice(heard.length));
  caption.replaceChildren(document.createTextNode(captionText(heard)), rest);
}

export function clearCaption(kind) {
  const caption = $('stage-caption');
  if (kind && caption.dataset.kind !== kind) return;
  caption.replaceChildren();
  delete caption.dataset.kind;
  $('stage-progress').hidden = true;
  scope.countdown(0);
}

export function announce(text) { $('announcement').textContent = text; }
