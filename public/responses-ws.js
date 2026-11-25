function wsUrl(httpBase) {
  const resolved = new URL(httpBase + '/responses', location.href);
  resolved.protocol = resolved.protocol === 'https:' ? 'wss:' : 'ws:';
  return resolved.toString();
}

export class ResponsesSocket {
  constructor(url) {
    this.url = url;
    this.ws = undefined;
    this.connecting = undefined;
    this.activeResponseId = undefined;
    this.consumer = undefined;
    this.reconnectAfterTurn = false;
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(signal) {
    if (this.open) return Promise.resolve(this.ws);
    if (this.connecting) return this.connecting;
    const target = wsUrl(this.url);
    const attempt = new Promise((resolve, reject) => {
      const ws = new WebSocket(target);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket 连接超时。'));
      }, 5_000);
      const onAbort = () => {
        clearTimeout(timer);
        ws.close();
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.ws = ws;
        this.reconnectAfterTurn = false;
        resolve(ws);
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error('无法建立 WebSocket 连接。'));
      }, { once: true });
      ws.addEventListener('message', event => this.onMessage(event.data));
      ws.addEventListener('close', () => this.onClose(ws));
    }).finally(() => {
      if (this.connecting === attempt) this.connecting = undefined;
    });
    this.connecting = attempt;
    return attempt;
  }

  onMessage(raw) {
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (event.type === 'error' && event.error?.code === 'websocket_connection_limit_reached') {
      this.reconnectAfterTurn = true;
      if (!this.consumer) this.close();
      return;
    }
    if (event.type === 'response.created' && event.response?.id) {
      this.activeResponseId = event.response.id;
    } else if (
      ['response.completed', 'response.failed', 'response.cancelled'].includes(event.type) ||
      (event.type === 'response.incomplete' && event.response?.incomplete_details?.reason !== 'steered')
    ) {
      if (!event.response?.id || event.response.id === this.activeResponseId) {
        this.activeResponseId = undefined;
      }
    }
    if (this.consumer) this.consumer.push(event);
  }

  onClose(ws) {
    if (this.ws === ws) this.ws = undefined;
    this.activeResponseId = undefined;
    if (this.consumer) {
      const current = this.consumer;
      this.consumer = undefined;
      current.end();
    }
  }

  async *create(payload, signal) {
    const ws = await this.connect(signal);
    if (signal?.aborted) return;
    const queue = [];
    let ended = false;
    let wake;
    const notify = () => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };
    const consumer = {
      push(event) {
        queue.push(event);
        notify();
      },
      end() {
        ended = true;
        notify();
      },
    };
    this.consumer = consumer;
    const onAbort = () => notify();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      ws.send(JSON.stringify({ type: 'response.create', ...payload }));
      for (;;) {
        while (queue.length) {
          const event = queue.shift();
          yield event;
          if (
            ['response.completed', 'response.failed', 'response.cancelled'].includes(event.type) ||
            (event.type === 'response.incomplete' && event.response?.incomplete_details?.reason !== 'steered') ||
            (event.type === 'error' && event.sequence_number === undefined)
          ) {
            return;
          }
        }
        if (ended || signal?.aborted) return;
        await new Promise(resolve => { wake = resolve; });
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.consumer === consumer) this.consumer = undefined;
      if (this.reconnectAfterTurn) this.close();
    }
  }

  steer(input, targetId = this.activeResponseId) {
    if (!this.open || !targetId) return false;
    this.ws.send(JSON.stringify({ type: 'response.steer', previous_response_id: targetId, input }));
    return true;
  }

  cancel(responseId = this.activeResponseId) {
    if (!this.open) return false;
    this.ws.send(JSON.stringify({
      type: 'response.cancel',
      ...(responseId ? { response_id: responseId } : {}),
    }));
    this.activeResponseId = undefined;
    return true;
  }

  close() {
    this.reconnectAfterTurn = false;
    this.activeResponseId = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
  }
}
