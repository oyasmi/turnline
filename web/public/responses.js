export const CALL_INSTRUCTIONS = `你正在和用户实时通话。用用户当前使用的语言，像电话里说话一样回答。

第一句给最有用的信息：结论、下一步，或者已确认的状态。把第一句写成能独立听懂的短句，用句号或问号收尾。平常一到三句，说完把话权交给用户。对方追问时再展开。

使用可直接朗读的纯文本和自然标点。把条目说成短句，把复杂细节压缩成口头摘要。保留影响理解的数字、单位、版本和专名。遇到长命令、路径、链接或代码，先解释用途，再问用户是否要切到文字查看。

能直接回答就直接回答。必须核实或执行时，只说有用的进展。区分准备做、正在做和已完成。耗时工作适合交给后台时，可以安排可追踪的任务，确认实际创建后再告诉用户。需要澄清时，一次只问一个能决定下一步的问题。

用户可能在任意一句中间插话。优先回应他刚说的话。收到播报停点时，以最后完整播完的一句为准。用户说“接着说”，就从那里往下讲；用户改了方向，就跟随新方向。如实说明已经执行的操作。

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

async function request(url, body, signal) {
  const headers = {};
  const options = { headers, signal, redirect: 'error' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    options.method = 'POST';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('无法连接后端。请检查 Base URL、网络和后端 CORS 设置。');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.error?.message ?? '后端返回 HTTP ' + response.status + '。');
    error.status = response.status;
    throw error;
  }
  return response;
}

export async function createConversation(settings, signal) {
  const response = await request(settings.url + '/conversations', {}, signal);
  const { id } = await response.json();
  if (typeof id !== 'string' || !id) throw new Error('后端没有返回会话 ID。');
  return id;
}

export async function listConversationItems(settings, conversation, after, signal, order = 'asc') {
  const query = new URLSearchParams({ order, limit: '50' });
  if (after) query.set('after', after);
  const response = await request(settings.url + '/conversations/' + encodeURIComponent(conversation) + '/items?' + query,
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
  const response = await request(settings.url + '/responses', body, signal);
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('后端没有返回 SSE。请检查该地址是否支持流式 Responses API。');
  }
  return readEvents(response.body);
}

export function speechText(text) {
  const chinese = /\p{Script=Han}/u.test(text) || !/[A-Za-z]/.test(text);
  const units = chinese
    ? { TB: '太字节', GB: '吉字节', MB: '兆字节', KB: '千字节' }
    : { TB: ' terabytes', GB: ' gigabytes', MB: ' megabytes', KB: ' kilobytes' };
  return text
    .replace(/`{3}[\s\S]*?(?:`{3}|$)/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s，。！？]+/g, '')
    .replace(/^[ \t]*(?:#+|>|[-*+]\s|\d+\.\s)/gm, '')
    .replace(/([+-]?\d+(?:\.\d+)?)\s*[%％]/gu, chinese ? '百分之$1' : '$1 percent')
    .replace(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB)\b/gi, (_, number, unit) =>
      number + units[unit.toUpperCase()])
    .replace(/~\/\.([a-z][a-z\d-]*)(?![\w/-])/gi, chinese ? '家目录的点 $1' : 'home directory dot $1')
    .replace(/[`*#~_《》]/g, '')
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
