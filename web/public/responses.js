export const CALL_INSTRUCTIONS = `你正在和用户实时通话。用用户当前使用的语言，像电话里说话一样回答。

第一句给最有用的信息：结论、下一步，或者已确认的状态。把第一句写成能独立听懂的短句，用句号或问号收尾。平常一到三句，说完把话权交给用户。对方追问时再展开。

使用可直接朗读的纯文本和自然标点。把条目说成短句，把复杂细节压缩成口头摘要。保留影响理解的数字、单位、版本和专名。遇到长命令、路径、链接或代码，先解释用途，再问用户是否要切到文字查看。

能直接回答就直接回答。必须核实或执行时，只说有用的进展。区分准备做、正在做和已完成。耗时工作适合交给后台时，可以安排可追踪的任务，确认实际创建后再告诉用户。需要澄清时，一次只问一个能决定下一步的问题。

用户可能在任意一句中间插话。优先回应他刚说的话。收到播报停点时，以已播到的那段文字为准。用户说“接着说”，就从那里往下讲；用户改了方向，就跟随新方向。如实说明已经执行的操作。

语音转写里的名字、数字或命令有歧义时，先用最短的一句话核对关键词。确认前不要搜索猜测的人名或执行猜测的命令。简单问候和确认只说一句。磁盘容量用口语读出，路径可以放在文字记录。`;

export function isBackchannel(text) {
  const syllables = text.replace(/[\s，。,.、…]/gu, '');
  return /^(?:[嗯唔哦噢喔啊ん]{1,3}|(?:うー?ん){1,3})$/u.test(syllables);
}

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

export function normalizeDirectUrl(value, turnlineOrigin) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整的 Pipiclaw 地址，例如 https://pipi.local:8787。'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('局域网地址请使用 HTTPS。本机可使用 http://127.0.0.1:8787。');
  }
  if (url.origin === turnlineOrigin || url.username || url.password || url.search || url.hash ||
      !['/', '/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('请填写 Pipiclaw 的服务地址或 /v1 地址，密钥请单独填写。');
  }
  return url.origin + '/v1';
}

async function request(settings, path, body, signal) {
  const url = settings.url + path;
  const headers = {};
  const options = { headers, signal, redirect: 'error' };
  if (settings.mode === 'direct') {
    headers.authorization = 'Bearer ' + settings.key;
    options.credentials = 'omit';
    if (url.startsWith('http:')) options.targetAddressSpace = 'loopback';
  }
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    options.method = 'POST';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (signal?.aborted && signal.reason?.name !== 'TimeoutError') throw error;
    throw new Error(settings.mode === 'direct'
      ? '无法连接 Pipiclaw。请检查地址、HTTPS 证书和浏览器的本地网络权限。'
      : '无法连接后端。请检查 Turnline 与 Pipiclaw 是否可用。');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.error?.message ?? '后端返回 HTTP ' + response.status + '。');
    error.status = response.status;
    throw error;
  }
  return response;
}

export async function checkDirectConnection(settings, signal) {
  const response = await request(settings, '/models/pipiclaw', undefined, signal);
  const model = await response.json().catch(() => null);
  if (model?.id !== 'pipiclaw') throw new Error('该地址未返回 Pipiclaw 模型。请检查服务地址。');
}

export async function createConversation(settings, signal) {
  const response = await request(settings, '/conversations', {}, signal);
  const { id } = await response.json();
  if (typeof id !== 'string' || !id) throw new Error('后端没有返回会话 ID。');
  return id;
}

export async function listConversationItems(settings, conversation, after, signal, order = 'asc') {
  const query = new URLSearchParams({ order, limit: '50' });
  if (after) query.set('after', after);
  const response = await request(settings, '/conversations/' + encodeURIComponent(conversation) + '/items?' + query,
    undefined, signal);
  const page = await response.json();
  if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') throw new Error('会话消息格式无效。');
  return page;
}

export async function openResponse(settings, { conversation, messages, text, voice, interruption }, signal) {
  const body = {
    model: settings.model,
    stream: true,
    ...(voice ? { instructions: [CALL_INSTRUCTIONS, settings.instructions, interruption].filter(Boolean).join('\n') } : {}),
    ...(conversation ? { conversation, input: text } : { store: false, input: messages }),
  };
  const response = await request(settings, '/responses', body, signal);
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('后端没有返回 SSE。请检查该地址是否支持流式 Responses API。');
  }
  return readEvents(response.body);
}
