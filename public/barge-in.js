import { isBackchannel } from './responses.js';

const normalized = text => (text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function echoes(text, reference) {
  const sample = Array.from(normalized(text));
  const output = Array.from(normalized(reference));
  if (sample.length < 2 || output.length < sample.length * 0.75) return false;
  if (output.join('').includes(sample.join(''))) return true;
  if (sample.length < 4) return false;
  // Local alignment tolerates a few ASR substitutions without requiring the
  // user to have repeated the start of the currently spoken phrase.
  let previous = new Uint16Array(output.length + 1);
  for (const character of sample) {
    const row = new Uint16Array(output.length + 1);
    row[0] = previous[0] + 1;
    for (let index = 1; index < row.length; index++) {
      row[index] = Math.min(row[index - 1] + 1, previous[index] + 1,
        previous[index - 1] + Number(character !== output[index - 1]));
    }
    previous = row;
  }
  return Math.min(...previous) <= Math.floor(sample.length * 0.25);
}

export function matchesEcho(text, references = []) {
  return references.some(reference => echoes(text, reference)) ||
    (references.length > 1 && echoes(text, references.join(' ')));
}

export function acknowledgement(text) {
  return !/[？?]/u.test(text) && (isBackchannel(text) || /^(?:嗯|对|是|好的|好|行|嗯哼|okay|ok|yeah|uhhuh){1,3}$/iu.test(normalized(text)));
}

export class BargeIn {
  constructor(player, act) {
    this.player = player;
    this.act = act;
  }

  duck(at, references) {
    if (this.candidate) return;
    const candidate = { at, references };
    this.candidate = candidate;
    this.act({ type: 'duck' });
    this.player.gain(0.25, 24, false, 'duck');
    // Keep the stop reversible while Silero and the first transcript catch up.
    this.pauseTimer = setTimeout(() => this.provisionalPause(), 130);
    this.timeout(candidate, 600);
  }

  provisionalPause() {
    const candidate = this.candidate;
    if (!candidate || candidate.paused) return;
    clearTimeout(this.pauseTimer);
    candidate.paused = true;
    this.act({ type: 'pause' });
    this.player.gain(0, 24, true, 'pause');
  }

  pause(event, at) {
    this.duck(at, this.player.echoReferences);
    const candidate = this.candidate;
    candidate.input = event.input;
    candidate.at = Math.min(candidate.at, at);
    this.provisionalPause();
    this.timeout(candidate, 750);
  }

  timeout(candidate, ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.candidate !== candidate) return;
      if (candidate.input === undefined) {
        this.restore();
        return;
      }
      // A slow ASR result should not leave playback frozen or discard a
      // genuine interruption that Silero has already heard.
      this.player.gain(1, 70);
      this.act({ type: 'barge-waiting' });
    }, ms);
  }

  transcript(event) {
    const candidate = this.candidate;
    if (!candidate || candidate.input !== event.input) return;
    const { text } = event;
    if (!text || acknowledgement(text) || matchesEcho(text, candidate.references) || matchesEcho(text, this.player.echoReferences)) {
      if (event.type !== 'partial') this.restore();
      return;
    }
    const phrase = normalized(text);
    const command = /^(?:停|等|等等|别说|不要|stop|no)$/iu.test(phrase);
    if (phrase.length < 3 && !command) {
      if (event.type === 'partial') return;
      if (event.voicedMs < 280) {
        this.restore();
        return;
      }
    }
    this.clear();
    this.act({ type: 'barge-confirmed', at: candidate.at });
  }

  restore() {
    if (!this.candidate) return;
    const { input } = this.candidate;
    this.clear();
    this.player.gain(1, 70, false, 'restore');
    this.act({ type: 'restore', input });
  }

  clear() {
    this.candidate = undefined;
    clearTimeout(this.pauseTimer);
    clearTimeout(this.timer);
  }
}
