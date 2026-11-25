import { captureMicrophone, keepScreenAwake } from './audio.js';

export async function openCallAudio(started, voice, player, options) {
  const context = started.context;
  if (!context.audioWorklet || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('请用 localhost 或 HTTPS 在 Chrome / Edge 里打开麦克风。');
  }
  const { signal } = started.controller;
  const playback = context.resume().then(() => { if (!signal.aborted) return player.open(context); });
  const recognition = voice.connect();
  const capture = context.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url));
  const openMicrophone = async () => {
    const replacement = new AbortController();
    started.pendingMicrophone?.abort();
    started.pendingMicrophone = replacement;
    const micSignal = AbortSignal.any([signal, replacement.signal]);
    const mic = await captureMicrophone(context, (data, at) => {
      if (started.microphone === mic && !signal.aborted) options.onFrame(data, at);
    }, micSignal);
    if (micSignal.aborted) return;
    started.pendingMicrophone = undefined;
    if (started.microphone) {
      started.microphone.stop();
      options.switched();
    }
    started.microphone = mic;
    mic.setEnabled(!options.muted());
  };
  await Promise.all([playback, recognition, capture.then(openMicrophone)]);
  if (signal.aborted) return;
  keepScreenAwake(signal);
  const restore = () => {
    void openMicrophone().catch(error => {
      if (!signal.aborted && error.name !== 'AbortError') options.showError('无法恢复麦克风，请检查设备后重试。');
    });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (context.state !== 'running') void context.resume().catch(() => {});
    if (!started.pendingMicrophone && !started.microphone?.active()) restore();
  }, { signal });
  navigator.mediaDevices.addEventListener('devicechange', () => {
    void openMicrophone().catch(error => {
      if (!signal.aborted && error.name !== 'AbortError') options.showError('无法切换麦克风，请检查设备后重试。');
    });
  }, { signal });
}

export function closeCallAudio(call, player, tones) {
  const delay = tones && call.ready ? 180 : 0;
  if (delay) player.tone('disconnect');
  player.close(delay);
  const close = () => void call.context.close().catch(() => {});
  if (delay) setTimeout(close, delay);
  else close();
}
