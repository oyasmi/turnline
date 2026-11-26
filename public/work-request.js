import { cancelResponse, openResponse, resumeResponse } from './responses.js';
import { isTerminalEvent, ResponsesSocket } from './responses-ws.js';

function delay(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class WorkRequest {
  constructor(settings, conversation, controller, cancelResult) {
    this.settings = settings;
    this.conversation = conversation;
    this.signal = controller.signal;
    this.cancelResult = cancelResult;
  }

  steer(input, target, requestId) {
    return this.socket?.steer(input, target, requestId) ?? false;
  }

  stop() {
    this.stopRequested = true;
    if (this.socket) this.socket.cancel();
    else if (this.background) this.stopBackground();
    else if (!this.started || this.settings.mode === 'demo') this.cancelResult('cancelled');
    else this.cancelResult('unconfirmed');
  }

  stopBackground() {
    if (!this.responseId || this.cancelPending) return;
    this.cancelPending = cancelResponse(this.settings, this.responseId, AbortSignal.timeout(7_000))
      .then(result => this.cancelResult(result?.status ?? 'unconfirmed'))
      .catch(() => this.cancelResult('unconfirmed'))
      .finally(() => { this.cancelPending = undefined; });
  }

  async *events(payload) {
    const { signal, settings, conversation } = this;
    if (settings.mode === 'relay' && conversation && 'WebSocket' in window) {
      const socket = this.socket = new ResponsesSocket(settings.url);
      const subscribe = () => ({ type: 'response.subscribe', conversation, turn_id: this.turnId, after: this.cursor });
      let command = payload ? {
        type: 'response.create', conversation, input: payload.text, instructions: payload.instructions,
      } : subscribe();
      let fallback = false;
      let terminal = false;
      for (const wait of [0, 450, 1250, 2800]) {
        if (wait) await delay(wait, signal);
        if (signal.aborted) return;
        try {
          for await (const event of socket.stream(command, signal, () => {
            if (this.stopRequested) socket.cancel();
          })) {
            if (payload && wait === 0 && event.error?.code === 'upstream_unavailable') {
              fallback = true;
              break;
            }
            this.cursor = event.turnline_cursor ?? this.cursor;
            this.turnId = event.turnline_turn ?? this.turnId;
            terminal = isTerminalEvent(event);
            if (event.type === 'turnline.idle' && payload) break;
            yield event;
          }
        } catch (error) {
          if (error.status === 401 || !error.beforeSubmission) throw error;
          fallback = Boolean(payload && !wait);
        }
        if (terminal || fallback) break;
        command = subscribe();
      }
      this.socket = undefined;
      if (!fallback || signal.aborted) return;
      if (this.stopRequested) {
        this.cancelResult('cancelled');
        return;
      }
    }
    if (!payload) return;

    this.started = true;
    this.background = settings.context === 'conversation' && Boolean(conversation);
    let after;
    let events = await openResponse(settings, { ...payload, conversation, background: this.background }, signal);
    for (const wait of [0, 600, 1500, 3000]) {
      if (wait) {
        if (!this.background || !this.responseId || after === undefined) return;
        await delay(wait, signal);
        if (signal.aborted) return;
        try {
          events = await resumeResponse(settings, this.responseId, after, signal);
        } catch (error) {
          if ([400, 401, 404].includes(error.status)) throw error;
          continue;
        }
      }
      try {
        for await (const event of events) {
          if (event.response?.id && event.type === 'response.created') {
            this.responseId = event.response.id;
            if (this.stopRequested) this.stopBackground();
          }
          after = event.sequence_number ?? after;
          yield event;
          if (isTerminalEvent(event)) return;
        }
      } catch (error) {
        if (signal.aborted || !this.background || !this.responseId || after === undefined) throw error;
      }
      if (this.cancelPending) await this.cancelPending;
      if (signal.aborted) return;
    }
  }
}
