export const initialCallState = Object.freeze({
  connection: 'idle', input: 'quiet', output: 'idle', muted: false, congested: false,
});

export function captureMode(state, duplex) {
  if (!['ready', 'reconnecting'].includes(state.connection) || state.muted) return 'off';
  if (!['speaking', 'ducked', 'paused'].includes(state.output)) return 'listen';
  if (state.input !== 'quiet' && !state.barge) return 'listen';
  return duplex ? 'barge' : 'monitor';
}

export function callPhase(state) {
  if (state.connection === 'connecting') return 'preparing';
  if (state.connection === 'reconnecting') return 'reconnecting';
  if (state.input === 'speaking' && !state.barge) return 'recognizing';
  if (state.input === 'pausing' && !state.barge) return 'pausing';
  if (['speaking', 'ducked', 'paused'].includes(state.output)) return 'speaking';
  if (state.output === 'thinking') return 'thinking';
  return state.connection === 'ready' && !state.muted ? 'listening' : 'idle';
}

export function reduceCall(state, event) {
  const idle = { input: 'quiet', inputId: undefined, barge: false };
  let next;
  switch (event.type) {
    case 'connect':
      next = { ...initialCallState, connection: 'connecting' };
      break;
    case 'ready':
    case 'reconnected':
      next = { ...state, connection: 'ready' };
      break;
    case 'reconnecting':
      next = { ...state, ...idle, connection: 'reconnecting', congested: false, output: state.barge ? 'speaking' : state.output };
      break;
    case 'hangup':
      next = initialCallState;
      break;
    case 'mute':
      next = { ...state, ...idle, muted: !state.muted, output: state.barge ? 'speaking' : state.output };
      break;
    case 'reset-input':
    case 'input-gap':
    case 'input-error':
    case 'commit':
      if (event.input !== undefined && event.input !== state.inputId) return [state, []];
      next = { ...state, ...idle, output: state.barge ? 'speaking' : state.output };
      break;
    case 'speech-start':
      next = { ...state, input: 'speaking', inputId: event.input, barge: event.duringPlayback };
      break;
    case 'resumed':
    case 'tentative':
      if (event.input !== state.inputId) return [state, []];
      next = { ...state, input: event.type === 'resumed' ? 'speaking' : 'pausing' };
      break;
    case 'request-started':
      next = { ...state, output: 'thinking' };
      break;
    case 'playback-started':
      next = { ...state, output: 'speaking' };
      break;
    case 'playback-ended':
      next = { ...state, output: event.waiting ? 'thinking' : 'idle', barge: false };
      break;
    case 'duck':
      next = { ...state, output: 'ducked', barge: true };
      break;
    case 'pause':
      next = { ...state, output: 'paused', barge: true };
      break;
    case 'barge-waiting':
      next = { ...state, output: 'speaking' };
      break;
    case 'restore':
      next = { ...state, ...idle, output: event.playing ? 'speaking' : 'idle' };
      break;
    case 'congestion':
      next = { ...state, congested: event.congested };
      break;
    default:
      return [state, []];
  }
  const effects = ['capture'];
  if (next.connection === 'ready' && next.output === 'idle' && next.input === 'quiet') effects.push('drain');
  return [next, effects];
}
