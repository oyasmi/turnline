import { callPhase } from './call-state.js';

const $ = id => document.getElementById(id);

export function renderCall(state, { canCall, duplex, pendingPlayback, busy }) {
  const phase = callPhase(state);
  const connected = state.connection === 'ready';
  const active = state.connection !== 'idle';
  let [label, hint] = {
    idle: connected ? ['麦克风已静音', '你仍可以输入文字消息。'] : ['准备通话', '开麦后，说完一句稍作停顿即可发送。'],
    preparing: ['正在准备', '语音服务正在加载模型，请允许麦克风访问。'],
    reconnecting: ['正在重连', '网络不稳定，通话会自动恢复。'],
    listening: ['正在聆听', '说完稍作停顿即可发送。'],
    recognizing: ['正在听你说', '点光球可以立即发送。'],
    pausing: ['等你继续说', '点光球可以立即发送。'],
    thinking: [pendingPlayback ? '正在合成' : '等待回复', '收到正文后会显示在对话记录里。'],
    speaking: ['正在播报', duplex && !state.muted ? '你可以直接开口插话。' : '点光球或「打断」即可继续说。'],
  }[phase];
  if (state.congested && connected) hint = '网络较慢，正在补传麦克风音频。';
  const orb = $('orb');
  orb.dataset.state = phase;
  orb.disabled = !connected || !['speaking', 'recognizing', 'pausing'].includes(phase);
  orb.setAttribute('aria-label', phase === 'speaking' ? '打断播报' : '立即发送语音');
  if ($('status').textContent !== label) $('status').textContent = label;
  $('hint').textContent = hint;
  $('call').textContent = active ? '挂断' : '开始通话';
  $('call').classList.toggle('hang-up', active);
  $('call').disabled = !active && !canCall;
  $('message').disabled = !canCall;
  $('send-message').disabled = !canCall;
  $('mute').textContent = state.muted ? '取消静音' : '静音';
  $('mute').setAttribute('aria-pressed', String(state.muted));
  $('mute').disabled = !connected;
  $('interrupt').disabled = !busy;
}

export function showLevel(rms) {
  $('orb').style.setProperty('--level', Math.min(1, Math.sqrt(rms * 6)).toFixed(3));
}

export function showThinking(on) {
  $('orb').classList.toggle('thinking-long', on);
}
