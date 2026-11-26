function wsUrl(httpBase) {
  const resolved = new URL(httpBase + '/responses', location.href);
  resolved.protocol = resolved.protocol === 'https:' ? 'wss:' : 'ws:';
  return resolved.toString();
}

export function isTerminalEvent(event) {
  if (event.turnline_continues) return false;
  return ['response.completed', 'response.failed', 'response.cancelled', 'turnline.idle'].includes(event.type) ||
    (event.type === 'response.incomplete' && event.response?.incomplete_details?.reason !== 'steered') ||
    (event.type === 'error' && event.sequence_number === undefined);
}

export class ResponsesSocket {
  constructor(url) {
    this.url = url;
  }

  async *stream(command, signal, onSubmitted) {
    if (signal.aborted) return;
    let ws;
    try {
      ws = this.ws = new WebSocket(wsUrl(this.url));
    } catch (cause) {
      const error = new Error('无法建立工作连接。', { cause });
      error.beforeSubmission = true;
      throw error;
    }
    const queue = [];
    let closed;
    let wake;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    ws.addEventListener('message', message => {
      let event;
      try { event = JSON.parse(message.data); } catch { return; }
      if (typeof event?.type !== 'string') return;
      queue.push(event);
      notify();
    });
    ws.addEventListener('close', event => {
      closed = event;
      notify();
    });
    signal.addEventListener('abort', notify, { once: true });

    try {
      await new Promise(resolve => {
        const done = () => {
          clearTimeout(timer);
          ws.removeEventListener('open', done);
          ws.removeEventListener('error', done);
          ws.removeEventListener('close', done);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, 5_000);
        ws.addEventListener('open', done);
        ws.addEventListener('error', done);
        ws.addEventListener('close', done);
        signal.addEventListener('abort', done, { once: true });
      });
      if (signal.aborted) return;
      if (ws.readyState !== WebSocket.OPEN) {
        const error = new Error('无法建立工作连接。');
        error.beforeSubmission = !closed || ![4401, 4429].includes(closed.code);
        if (closed?.code === 4401) error.status = 401;
        throw error;
      }
      ws.send(JSON.stringify(command));
      this.submitted = true;
      onSubmitted();

      while (!signal.aborted) {
        const event = queue.shift();
        if (event) {
          yield event;
          if (isTerminalEvent(event)) return;
        } else if (closed) {
          if (closed.code === 4401) {
            const error = new Error('会话已失效，请重新解锁。');
            error.status = 401;
            throw error;
          }
          return;
        } else {
          await new Promise(resolve => { wake = resolve; });
        }
      }
    } finally {
      signal.removeEventListener('abort', notify);
      this.ws = undefined;
      this.submitted = false;
      if (ws.readyState < WebSocket.CLOSING) ws.close();
    }
  }

  send(event) {
    if (!this.submitted || this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  steer(input, target, requestId) {
    return this.send({ type: 'response.steer', previous_response_id: target, input, request_id: requestId });
  }

  cancel() {
    return this.send({ type: 'response.cancel' });
  }
}
