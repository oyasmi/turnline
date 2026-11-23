export const CALL_INSTRUCTIONS = '我们正在语音通话。请直接说结论，通常一两句。需要澄清时只问一个问题。长任务简短确认，完成后汇报结果。用自然的口语，把代码、链接、路径和长日志留给屏幕。';

export async function* readEvents(stream) {
  if (!stream) throw new Error('后端没有返回响应流。');
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  let data = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += value ?? '';
      let lineEnd;
      const separator = done ? /\r\n|\n|\r/ : /\r\n|\n|\r(?!$)/;
      while ((lineEnd = separator.exec(pending))) {
        const line = pending.slice(0, lineEnd.index);
        pending = pending.slice(lineEnd.index + lineEnd[0].length);
        if (line === '' && data.length) {
          const payload = data.join('\n');
          data = [];
          if (payload === '[DONE]') return;
          yield JSON.parse(payload);
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function backendUrl(value, origin) {
  if (!value.trim()) return (origin ?? location.origin) + '/demo/v1';
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('请填写不含凭据或查询参数的 HTTP(S) Base URL。');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('远程后端请使用 HTTPS。本机后端可以使用 HTTP。');
  }
  return url.href.replace(/\/+$/, '').replace(/\/(?:responses|conversations)$/, '');
}

async function request(url, key, body, signal) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = 'Bearer ' + key;
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('无法连接后端。请检查 Base URL、网络和后端 CORS 设置。');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message ?? '后端返回 HTTP ' + response.status + '。');
  }
  return response;
}

export async function createConversation(settings, signal) {
  const response = await request(settings.url + '/conversations', settings.key, {}, signal);
  const { id } = await response.json();
  if (typeof id !== 'string' || !id) throw new Error('后端没有返回会话 ID。');
  return id;
}

export async function openResponse(settings, { conversation, messages, text, interruption }, signal) {
  const body = {
    model: settings.model,
    stream: true,
    instructions: [CALL_INSTRUCTIONS, settings.instructions, interruption].filter(Boolean).join('\n'),
    ...(conversation ? { conversation, input: text } : { store: false, input: messages }),
  };
  const response = await request(settings.url + '/responses', settings.key, body, signal);
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('后端没有返回 SSE。请检查该地址是否支持流式 Responses API。');
  }
  return readEvents(response.body);
}

export function speechText(text) {
  return text
    .replace(/`{3}[\s\S]*?(?:`{3}|$)/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s，。！？]+/g, '')
    .replace(/^[ \t]*(?:#+|>|[-*+]\s|\d+\.\s)/gm, '')
    .replace(/[`*#~_]/g, '')
    .trim();
}

export function splitSpeech(text, flush = false) {
  const phrases = [];
  let rest = text;
  while (rest) {
    const sentence = /[。！？!?；;\n]+|\.(?=\s)/u.exec(rest);
    let end = sentence ? sentence.index + sentence[0].length : 0;
    // Bound the latency for unpunctuated text while avoiding tiny fragments.
    if ((!end || end > 80) && rest.length >= 64) {
      const soft = Math.max(rest.lastIndexOf('，', 63), rest.lastIndexOf('、', 63), rest.lastIndexOf(' ', 63));
      end = soft >= 24 ? soft + 1 : 64;
    }
    if (!end && flush) end = rest.length;
    if (!end) break;
    // Keep fenced code intact until its closing fence or the end of the item.
    if ((rest.slice(0, end).match(/`{3}/g)?.length ?? 0) % 2) {
      const close = rest.indexOf('```', rest.indexOf('```') + 3);
      if (close < 0 && !flush) break;
      end = close < 0 ? rest.length : close + 3;
    }
    const phrase = speechText(rest.slice(0, end));
    if (/[\p{L}\p{N}]/u.test(phrase)) phrases.push(phrase);
    rest = rest.slice(end);
  }
  return { phrases, rest };
}
