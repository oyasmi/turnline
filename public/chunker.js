const hiddenSpeech = /`{3}[\s\S]*?(?:`{3}|$)|!\[[^\]\n]*\]\([^)]*(?:\)|$)|(?<=\])\([^)]*(?:\)|$)|https?:\/\/[^\s，。！？]+/gu;
const wordCharacter = String.raw`[\p{Script=Latin}\p{M}\p{Nd}]`;
const wordJoiner = "[.'’_．＿‐‑–－-]";
const word = `${wordCharacter}+(?:${wordJoiner}${wordCharacter}+)*`;
const number = String.raw`\p{Nd}+(?:[.,．:：]\p{Nd}+)*(?:[ \t]*(?:[%％]|[KMGTＫＭＧＴ][BＢ]))?`;
const speechWord = `${number}(?!${wordCharacter}|${wordJoiner}${wordCharacter})|${word}`;
const openingWords = new RegExp(String.raw`\p{Script=Han}|${speechWord}|[\p{L}\p{N}]`, 'gu');
const speechWords = new RegExp(speechWord, 'gu');
const unfinishedWord = new RegExp(`^${wordJoiner}?$`, 'u');
const wordEnding = new RegExp(`${wordCharacter}$`, 'u');
const numberEnding = /\p{Nd}$/u;

function pendingWord(word, gap) {
  return wordEnding.test(word) && unfinishedWord.test(gap) ||
    numberEnding.test(word) && /^[:：]$/u.test(gap);
}

function visibleSpeech(text) {
  return text.replace(hiddenSpeech, match => ' '.repeat(match.length))
    .replace(/^[ \t]*\d+\.\s/gm, match => ' '.repeat(match.length));
}

function openingEnd(text) {
  const visible = visibleSpeech(text);
  const words = [...visible.matchAll(openingWords)];
  let characters = 0;
  let han = 0;
  let latin = 0;
  let previousEnd = 0;
  for (const [index, match] of words.entries()) {
    const end = match.index + match[0].length;
    characters += (match[0].match(/[\p{L}\p{N}]/gu) ?? []).length;
    if (/\p{Script=Han}/u.test(match[0])) han++;
    else if (/^\p{Script=Latin}/u.test(match[0])) latin++;
    const gap = visible.slice(end, words[index + 1]?.index ?? visible.length);
    const complete = /[。！？!?；;]|\.(?=\s)/u.exec(gap);
    if (complete && words[index + 1]) return end + complete.index + complete[0].length;
    if (han >= 6 || latin >= 3) {
      const pause = /[。！？!?；;\n，、：:]+|,(?!\d)|\.(?=\s|$)/u.exec(gap);
      if (pause && !(numberEnding.test(match[0]) && pendingWord(match[0], gap))) {
        return end + pause.index + pause[0].length;
      }
    }
    if (characters >= 14) {
      // A final Latin token, number, or dangling decimal can still grow in a later delta.
      if (pendingWord(match[0], gap)) return previousEnd;
      return end;
    }
    if (han >= 6 || latin >= 3) previousEnd = end;
  }
  return 0;
}

function softSpeechEnd(text, start, end, flush) {
  for (const match of text.matchAll(speechWords)) {
    if (match.index >= end) break;
    const wordEnd = match.index + match[0].length;
    const pending = !flush && pendingWord(match[0], text.slice(wordEnd));
    if (end >= wordEnd && !pending) continue;
    if (match.index > start) return match.index;
    if (!pending && wordEnd - start <= 128) return wordEnd;
    // A single long identifier must still fit in a synthesis request.
    return pending && text.length - start < 128 ? 0 : start + 128;
  }
  return end;
}

function appendSpeech(phrases, ranges, source, offset) {
  // Track the source offsets even when links, code blocks, or whitespace are omitted.
  let raw = '';
  const positions = [];
  let cursor = 0;
  const append = (text, start) => {
    raw += text;
    if (ranges) for (let index = 0; index < text.length; index++) positions.push(offset + start + index);
  };
  for (const match of source.matchAll(hiddenSpeech)) {
    append(source.slice(cursor, match.index), cursor);
    if (!(source[match.index - 1] === ']' && match[0].startsWith('('))) append(' ', match.index);
    cursor = match.index + match[0].length;
  }
  append(source.slice(cursor), cursor);
  const paragraph = raw.endsWith('\n\n');
  let from = raw.length - raw.trimStart().length;
  const last = raw.trimEnd().length;
  const push = (end, suffix = '') => {
    const phrase = raw.slice(from, end);
    if (!/[\p{L}\p{N}]/u.test(phrase)) return;
    phrases.push(phrase + suffix);
    ranges?.push({ start: positions[from], end: positions[end - 1] + 1, offsets: positions.slice(from, end) });
  };
  while (last - from > (paragraph ? 126 : 128)) {
    const space = raw.lastIndexOf(' ', from + 128);
    let end = space >= from + 64 ? space : from + 128;
    if (/[\uD800-\uDBFF]/u.test(raw[end - 1])) end--;
    push(end);
    from = end + (/^\s*/u.exec(raw.slice(end))[0].length);
  }
  if (from < last) push(last, paragraph ? '\n\n' : '');
}

export function splitSpeech(text, flush = false, opening = false, mapped = false) {
  const phrases = [];
  const ranges = mapped ? [] : undefined;
  const result = () => mapped ? { phrases, rest, ranges } : { phrases, rest };
  let rest = text;
  if (opening && !flush) {
    const end = openingEnd(rest);
    if (!end) return result();
    appendSpeech(phrases, ranges, rest.slice(0, end), text.length - rest.length);
    rest = rest.slice(end);
  }
  while (rest) {
    const visible = visibleSpeech(rest);
    const sentence = /[。！？!?；;\n]+|\.\s+/u.exec(visible);
    let end = sentence ? sentence.index + sentence[0].length : 0;
    if ((!end || end > 80) && visible.trimStart().length >= 64) {
      const start = visible.length - visible.trimStart().length;
      const soft = Math.max(visible.lastIndexOf('，', start + 63), visible.lastIndexOf('、', start + 63),
        visible.lastIndexOf(' ', start + 63));
      end = softSpeechEnd(visible, start, soft >= start + 24 ? soft + 1 : start + 64, flush);
    }
    const fence = rest.indexOf('```');
    if (fence >= 0 && (!end || fence < end)) {
      const close = rest.indexOf('```', fence + 3);
      if (close < 0 && !flush) break;
      if (end && close >= end) end = close + 3;
    }
    if (!end && flush) end = rest.length;
    if (!end) break;
    appendSpeech(phrases, ranges, rest.slice(0, end), text.length - rest.length);
    rest = rest.slice(end);
  }
  return result();
}
