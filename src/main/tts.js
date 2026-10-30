// ============================================================
// Озвучка: два движка + очередь.
//
//   speechify — облачный Speechify (нужен ключ, высокое качество);
//   piper     — офлайн-нейроголос Piper (вшит в приложение, без
//               интернета и без ключей, ~0.25 с на 4 с речи);
//   none      — выключено.
//
// Очередь: сообщения из чата приходят пачками, синтез занимает
// время. Фразы складываются в короткую очередь, лишнее вытесняет
// самое старое — в стриме свежая реплика важнее отставшей.
//
// Ключ Speechify: config.json → speechify_key или переменная
// окружения SPEECHIFY_API_KEY.
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const SPEECHIFY_ENDPOINT = 'https://api.speechify.ai/v1/audio/stream';

// Голоса, реально доступные для русского в Speechify
const RU_VOICES = [
  { id: 'alexei', label: 'Alexei — мужской (Speechify)' },
  { id: 'agrippina', label: 'Agrippina — женский (Speechify)' },
];

// Офлайн-голоса Piper: файлы лежат в assets/piper/voices
const PIPER_VOICES = [
  { id: 'dmitri', label: 'Dmitri — мужской (офлайн)', model: 'ru_RU-dmitri-medium.onnx' },
  { id: 'irina', label: 'Irina — женский (офлайн)', model: 'ru_RU-irina-medium.onnx' },
];

const MODELS = ['simba-3.5', 'simba-3.0', 'simba-english'];
const LANGUAGES = ['ru-RU', 'en-US'];

const REQUEST_TIMEOUT_MS = 30000;
const PIPER_TIMEOUT_MS = 60000;
const MAX_CACHE_FILES = 30;
const MAX_QUEUE = 3;

// Каталог кэша: %TEMP%\aronchat-tts
const CACHE_DIR = () => path.join(os.tmpdir(), 'aronchat-tts');

function ensureCacheDir() {
  const dir = CACHE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Очередной temp_speech-*.mp3 / .wav
let counter = 0;
function cacheFile(ext = 'mp3') {
  counter += 1;
  return path.join(ensureCacheDir(), `temp_speech-${Date.now()}-${counter}.${ext}`);
}

// Убираем старые файлы, чтобы папка не разрасталась во время стрима
function pruneCache(dir) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('temp_speech-'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);

    for (const stale of files.slice(MAX_CACHE_FILES)) {
      try { fs.unlinkSync(path.join(dir, stale.f)); } catch { /* уже удалён */ }
    }
  } catch { /* кэш не критичен */ }
}

function isMp3(buffer) {
  if (!buffer || buffer.length < 4) return false;
  if (buffer.toString('ascii', 0, 3) === 'ID3') return true;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

function snippet(value, max = 200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describeHttpError(status, raw) {
  const detail = snippet(raw);
  if (status === 401 || status === 403) return `Speechify отклонил ключ (HTTP ${status}). Проверьте API-ключ в настройках. ${detail}`;
  if (status === 402) return `Speechify: закончился баланс или тариф (HTTP 402). ${detail}`;
  if (status === 429) return `Speechify: превышен лимит запросов (HTTP 429). ${detail}`;
  if (status === 400) return `Speechify: неверный запрос (HTTP 400). ${detail}`;
  return `Speechify вернул HTTP ${status}: ${detail}`;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`превышен таймаут ${Math.round(timeoutMs / 1000)} с (${url})`);
    }
    throw new Error(`нет соединения с ${url} (${err.message})`);
  } finally {
    clearTimeout(timer);
  }
}

// Запуск Piper: текст пишем в stdin, аудио — в файл.
// Без cmd.exe и пайпов между процессами: так работает и в упакованном
// приложении, и в ограниченных окружениях.
function runPiper(exe, args, text, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* уже завершён */ }
      reject(new Error(`Piper не ответил за ${Math.round(timeoutMs / 1000)} с`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`не удалось запустить Piper: ${err.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Piper завершился с кодом ${code}`));
    });

    try {
      child.stdin.end(String(text || ''), 'utf8');
    } catch (err) {
      clearTimeout(timer);
      reject(new Error(`не удалось передать текст в Piper: ${err.message}`));
    }
  });
}

class SpeechifyTTS {
  constructor(getConfig, play, log) {
    this.getConfig = getConfig;
    this.play = play || (() => {});
    this.log = log || (() => {});
    this.queue = [];
    this.processing = false;
    this.piperRoot = path.join(__dirname, '../../assets/piper');
  }

  // Куда распакован Piper (в portable — app.asar.unpacked/assets/piper)
  setPiperRoot(dir) {
    if (dir) this.piperRoot = dir;
  }

  get apiKey() {
    const fromConfig = String(this.getConfig().speechify_key || '').trim();
    return fromConfig || String(process.env.SPEECHIFY_API_KEY || '').trim();
  }

  get engine() {
    return this.getConfig().tts_engine || 'speechify';
  }

  maskedKey() {
    const key = this.apiKey;
    if (!key) return 'не задан';
    if (key.length < 12) return '…';
    return `${key.slice(0, 6)}…${key.slice(-4)}`;
  }

  // ---------- Speechify ----------
  async sendToSpeechify(text) {
    const clean = String(text || '').trim();
    if (!clean) return null;

    const key = this.apiKey;
    if (!key) {
      throw new Error('не задан API-ключ Speechify — введите его на вкладке «Озвучка»');
    }

    const cfg = this.getConfig();
    const payload = {
      input: clean,
      voice_id: cfg.voice_id || RU_VOICES[0].id,
      model: cfg.model,
      language: cfg.language,
      audio_format: 'mp3',
    };

    const res = await fetchWithTimeout(SPEECHIFY_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify(payload),
    });

    const contentType = res.headers.get('content-type') || '';

    if (!res.ok) {
      throw new Error(describeHttpError(res.status, await res.text()));
    }

    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new Error('Speechify вернул пустой ответ вместо аудио');

    if (!isMp3(audio) && !/audio\//i.test(contentType)) {
      throw new Error(
        `ответ не похож на mp3 (${contentType || 'без Content-Type'}, ${audio.length} байт): `
        + snippet(audio.toString('utf8', 0, 200))
      );
    }

    const file = cacheFile('mp3');
    fs.writeFileSync(file, audio);
    pruneCache(path.dirname(file));
    return file;
  }

  // ---------- Piper (офлайн) ----------
  async synthesizePiper(text) {
    const cfg = this.getConfig();
    const voiceId = cfg.piper_voice || PIPER_VOICES[0].id;
    const voice = PIPER_VOICES.find((v) => v.id === voiceId) || PIPER_VOICES[0];

    const exe = path.join(this.piperRoot, 'piper.exe');
    const model = path.join(this.piperRoot, 'voices', voice.model);
    const espeakData = path.join(this.piperRoot, 'espeak-ng-data');

    if (!fs.existsSync(exe)) throw new Error(`Piper не найден: ${exe}`);
    if (!fs.existsSync(model)) throw new Error(`голос Piper не найден: ${model}`);

    const outFile = cacheFile('wav');

    // Скорость: 100% → length_scale 1.0, 150% → 0.667 (быстрее)
    const speed = Math.min(200, Math.max(50, Number(cfg.tts_speed) || 100));
    const lengthScale = (100 / speed).toFixed(3);

    const args = [
      '-m', model,
      '-c', `${model}.json`,
      '-f', outFile,
      '--espeak_data', espeakData,
      '--length_scale', lengthScale,
      '--quiet',
    ];

    await runPiper(exe, args, text, PIPER_TIMEOUT_MS);

    if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
      throw new Error('Piper не вернул аудио (проверьте файлы в assets/piper)');
    }
    pruneCache(path.dirname(outFile));
    return outFile;
  }

  // ---------- Общая точка синтеза ----------
  async synthesize(text) {
    const engine = this.engine;
    if (engine === 'none') return null;
    if (engine === 'piper') return this.synthesizePiper(text);
    return this.sendToSpeechify(text);
  }

  speak(text) {
    const clean = String(text || '').trim();
    if (!clean || this.engine === 'none') return;

    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(clean);
    this.drain();
  }

  async drain() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift();
        try {
          const file = await this.synthesize(next);
          if (file) this.play(file, pathToFileURL(file).href);
        } catch (err) {
          this.log({ level: 'error', text: `TTS (${this.engine}): ${err.message}` });
        }
      }
    } finally {
      this.processing = false;
    }
  }

  async test(text = 'Проверка озвучки сообщений') {
    if (this.engine === 'none') {
      this.log({ level: 'error', text: 'Озвучка выключена — выберите движок в настройках' });
      return false;
    }
    try {
      const file = await this.synthesize(text);
      this.play(file, pathToFileURL(file).href);
      this.log({ level: 'info', text: `Озвучка проверена (${this.engine}): ${path.basename(file)}` });
      return true;
    } catch (err) {
      this.log({ level: 'error', text: `Проверка озвучки не удалась: ${err.message}` });
      return false;
    }
  }
}

module.exports = SpeechifyTTS;
module.exports.SPEECHIFY_ENDPOINT = SPEECHIFY_ENDPOINT;
module.exports.RU_VOICES = RU_VOICES;
module.exports.PIPER_VOICES = PIPER_VOICES;
module.exports.MODELS = MODELS;
module.exports.LANGUAGES = LANGUAGES;
module.exports.CACHE_DIR = CACHE_DIR;
module.exports.MAX_QUEUE = MAX_QUEUE;
