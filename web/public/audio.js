export const clock = () => performance.timeOrigin + performance.now();

export async function captureMicrophone(context, onFrame, signal) {
  if (!navigator.mediaDevices?.getUserMedia || !context.audioWorklet) {
    throw new Error('请用 localhost 或 HTTPS 在 Chrome / Edge 里打开麦克风。');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let worklet;
  let source;
  const stop = () => {
    signal.removeEventListener('abort', stop);
    for (const track of stream.getTracks()) track.stop();
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.close();
      worklet.disconnect();
    }
    source?.disconnect();
  };
  try {
    signal.throwIfAborted();
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, 'microphone-frames', { channelCount: 1 });
    worklet.port.onmessage = ({ data }) => {
      const at = clock() - (context.currentTime - data.time) * 1000;
      onFrame(data, at);
    };
    source.connect(worklet).connect(context.destination);
    signal.addEventListener('abort', stop, { once: true });
    return {
      active: () => stream.getAudioTracks().some(track => track.readyState === 'live'),
      setEnabled(enabled) {
        for (const track of stream.getAudioTracks()) track.enabled = enabled;
      },
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}

export function keepScreenAwake(signal) {
  let lock;
  let acquiring = false;
  async function acquire() {
    if (!navigator.wakeLock || signal.aborted || document.hidden || lock || acquiring) return;
    acquiring = true;
    try {
      const next = await navigator.wakeLock.request('screen');
      if (signal.aborted) {
        await next.release();
        return;
      }
      lock = next;
      next.addEventListener('release', () => {
        if (lock === next) lock = undefined;
        if (!document.hidden && !signal.aborted) void acquire();
      }, { once: true });
    } catch {
      // The system can deny a wake lock when power is low.
    } finally {
      acquiring = false;
    }
  }
  document.addEventListener('visibilitychange', acquire, { signal });
  signal.addEventListener('abort', () => void lock?.release().catch(() => {}), { once: true });
  void acquire();
}
