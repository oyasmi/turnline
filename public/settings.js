import { normalizeDirectUrl } from './responses.js';

const PREFERENCES = 'turnline.preferences.v2';
const PREVIOUS_PREFERENCES = 'turnline.preferences.v1';
const RESPONSE_SPEEDS = ['quick', 'balanced', 'patient'];
const SPEECH_RATES = [0.9, 1, 1.07, 1.15];
const MIN_VOICE_SECONDS = [0, 1, 2, 3, 5];
const LEGACY_SPEED = { 0.35: 'quick', 0.5: 'quick', 0.8: 'balanced', 1.2: 'patient',
  1: 'quick', 1.5: 'quick', 2.2: 'balanced', 3: 'patient' };
const DIRECT_ADDRESS = 'turnline.direct-address.v1';
const DIRECT_CREDENTIALS = 'turnline.direct-credentials.v1';

export function stored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function store(key, value) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

export function directSettings() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(DIRECT_CREDENTIALS));
    const url = normalizeDirectUrl(saved?.url || stored(DIRECT_ADDRESS) || '', location.origin);
    return { mode: 'direct', url, key: saved?.url === url ? saved.key : '' };
  } catch {
    return { mode: 'direct', url: '', key: '' };
  }
}

export function saveDirectSettings(url, key) {
  store(DIRECT_ADDRESS, url);
  try {
    if (key) sessionStorage.setItem(DIRECT_CREDENTIALS, JSON.stringify({ url, key }));
    else sessionStorage.removeItem(DIRECT_CREDENTIALS);
  } catch {}
}

export function preferences() {
  let saved;
  try { saved = JSON.parse(stored(PREFERENCES)) ?? JSON.parse(stored(PREVIOUS_PREFERENCES)); } catch {}
  const migratedSpeed = typeof saved?.silence === 'number' ? LEGACY_SPEED[saved.silence] : undefined;
  return {
    reading: saved?.reading === 'confirmed' ? 'confirmed' : 'live',
    speed: RESPONSE_SPEEDS.includes(saved?.speed) ? saved.speed : migratedSpeed ?? 'balanced',
    rate: SPEECH_RATES.includes(saved?.rate) ? saved.rate : 1,
    tones: saved?.tones !== false,
    waitingTone: saved?.waitingTone !== false,
    inputMode: saved?.inputMode === 'hold' ? 'hold' : 'auto',
    minVoiceSeconds: MIN_VOICE_SECONDS.includes(saved?.minVoiceSeconds) ? saved.minVoiceSeconds : 2,
    duplex: saved?.duplex === true,
    instructions: typeof saved?.instructions === 'string' ? saved.instructions.slice(0, 3000) : '',
  };
}

export function savePreferences(settings) {
  store(PREFERENCES, JSON.stringify(settings));
}
