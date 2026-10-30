// ============================================================
// Проверка модуля TTS (Speechify Cloud).
//   node tts_test.js
// Сеть подменяется фикстурами: реальных запросов нет.
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

const TTS_MODULE = './src/main/tts';
const SpeechifyTTS = require(TTS_MODULE);
const { CACHE_DIR, RU_VOICES, MODELS, LANGUAGES } = require(TTS_MODULE);

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2048, 0x20)]);
const NOT_AUDIO = Buffer.from('{"error":"invalid voice_id"}', 'utf8');

const results = [];
function check(name, ok, extra = '') {
  results.push(ok);
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${extra ? ' — ' + extra : ''}`);
}

// Ответ, похожий на нативный: arrayBuffer + headers.get
function audioResponse(body, status = 200, contentType = 'audio/mpeg') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    text: async () => body.toString('utf8'),
  };
}

const calls = [];
const origFetch = global.fetch;

function stubFetch(responder) {
  global.fetch = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method,
      body: JSON.parse(init.body || '{}'),
      headers: init.headers || {},
    });
    return responder(url, init);
  };
}

function freshConfig(over = {}) {
  return {
    speechify_key: 'sk_test_key_1234567890',
    voice_id: 'alexei',
    model: 'simba-3.5',
    language: 'ru-RU',
    ...over,
  };
}

// make() — сервис с сбором логов и play-событий
function make(cfg = {}, play) {
  const state = { config: freshConfig(cfg), logs: [], played: [] };
  const svc = new SpeechifyTTS(
    () => state.config,
    (file, url) => state.played.push({ file, url }),
    (entry) => state.logs.push(entry)
  );
  return { svc, state };
}

(async () => {
  // ═══════ 1. Без ключа запрос не уходит ═══════
  stubFetch(() => audioResponse(MP3));
  {
    const { svc, state } = make({ speechify_key: '' });
    const res = await svc.speak('Привет');
    check('без ключа: ничего не озвучено', res === null);
    check('без ключа: fetch не вызван', calls.length === 0);
    check('без ключа: ошибка про API-ключ', /API-ключ/.test(state.logs.map((l) => l.text).join(' ')),
      state.logs.map((l) => l.text).join(' | '));
  }

  // ═══════ 2. Успешный синтез: payload и заголовки ═══════
  calls.length = 0;
  stubFetch(() => audioResponse(MP3));
  {
    const { svc, state } = make({ voice_id: 'agrippina', model: 'simba-3.0', language: 'en-US' });
    const file = await svc.speak('Всем привет');
    const call = calls[0] || {};
    check('запрос на api.speechify.ai', /api\.speechify\.ai\/v1\/audio\/stream/.test(call.url || ''), call.url);
    check('метод POST', call.method === 'POST');
    check('input = текст озвучки', call.body.input === 'Всем привет', JSON.stringify(call.body));
    check('voice_id из конфига', call.body.voice_id === 'agrippina');
    check('model из конфига', call.body.model === 'simba-3.0');
    check('language из конфига', call.body.language === 'en-US');
    check('audio_format = mp3', call.body.audio_format === 'mp3');
    check('Bearer-заголовок', call.headers.Authorization === 'Bearer sk_test_key_1234567890');
    check('Content-Type: application/json', call.headers['Content-Type'] === 'application/json');
    check('Accept: audio/mpeg', call.headers.Accept === 'audio/mpeg');
    check('файл возвращён', typeof file === 'string' && file.endsWith('.mp3'), String(file));
    check('mp3 реально записан', fs.existsSync(file) && fs.readFileSync(file).slice(0, 3).toString() === 'ID3');
    check('play получен с file://', state.played.length === 1 && /^file:\//.test(state.played[0].url),
      JSON.stringify(state.played[0] || {}));
    check('имя файла temp_speech-*.mp3', /temp_speech-\d+-\d+\.mp3$/.test(path.basename(file)), path.basename(file));
    check('лежит в %TEMP%\\aronchat-tts', path.dirname(file) === CACHE_DIR(), path.dirname(file));

    fs.unlinkSync(file);
  }

  // ═══════ 3. Пустая строка ═══════
  calls.length = 0;
  {
    const { svc } = make();
    check('пустой текст → null', (await svc.speak('   ')) === null);
    check('пустой текст: fetch не вызван', calls.length === 0);
    check('null-текст → null', (await svc.speak(null)) === null);
  }

  // ═══════ 4. Ошибки HTTP ═══════
  for (const [status, needle] of [[401, '401'], [402, '402'], [429, '429'], [400, '400'], [500, '500']]) {
    calls.length = 0;
    stubFetch(() => audioResponse(Buffer.from('some api detail'), status, 'application/json'));
    const { svc, state } = make();
    const res = await svc.speak('Текст');
    check(`HTTP ${status}: озвучка не удалась`, res === null);
    check(`HTTP ${status}: в тексте есть код`, state.logs.some((l) => l.text.includes(needle)),
      state.logs.map((l) => l.text).join(' | '));
  }

  // ═══════ 5. 401 — подсказка про настройки ═══════
  calls.length = 0;
  stubFetch(() => audioResponse(Buffer.from('unauthorized'), 401, 'application/json'));
  {
    const { svc, state } = make();
    await svc.speak('Текст');
    check('401: подсказка «Проверьте API-ключ»', /Проверьте API-ключ/.test(state.logs.map((l) => l.text).join(' ')));
  }

  // ═══════ 6. Ответ не-аудио с кодом 200 ═══════
  calls.length = 0;
  stubFetch(() => audioResponse(NOT_AUDIO, 200, 'application/json'));
  {
    const { svc, state } = make();
    check('200 + JSON: озвучка не удалась', (await svc.speak('Текст')) === null);
    check('200 + JSON: ошибка про mp3', /не похож на mp3/.test(state.logs.map((l) => l.text).join(' ')),
      state.logs.map((l) => l.text).join(' | '));
  }

  // ═══════ 7. Пустое тело ═══════
  calls.length = 0;
  stubFetch(() => audioResponse(Buffer.alloc(0), 200, 'audio/mpeg'));
  {
    const { svc, state } = make();
    check('пустое тело: озвучка не удалась', (await svc.speak('Текст')) === null);
    check('пустое тело: ошибка про пустой ответ', /пустой ответ/.test(state.logs.map((l) => l.text).join(' ')));
  }

  // ═══════ 8. Мьютекс: параллельные вызовы ═══════
  calls.length = 0;
  let resolveHold = null;
  stubFetch(() => new Promise((r) => { resolveHold = () => r(audioResponse(MP3)); }));
  {
    const { svc } = make();
    const p1 = svc.speak('Первое');
    const p2 = svc.speak('Второе');
    const p3 = svc.speak('Третье');
    check('мьютекс: пока занято, вызовы отклоняются', calls.length === 1);
    resolveHold();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    check('мьютекс: первый озвучен', typeof r1 === 'string');
    check('мьютекс: остальные пропущены', r2 === null && r3 === null);
    check('мьютекс: запросов ровно 1', calls.length === 1, String(calls.length));
    if (r1) fs.unlinkSync(r1);
  }

  // ═══════ 9. После завершения мьютекс отпускается ═══════
  calls.length = 0;
  stubFetch(() => audioResponse(MP3));
  {
    const { svc } = make();
    await svc.speak('Первая');
    const second = await svc.speak('Вторая');
    check('мьютекс отпущен: вторая озвучка прошла', typeof second === 'string');
    check('второй запрос отправлен', calls.length === 2);
  }

  // ═══════ 10. Сеть недоступна ═══════
  calls.length = 0;
  global.fetch = async () => { throw new Error('ENOTFOUND api.speechify.ai'); };
  {
    const { svc, state } = make();
    check('сбой сети: озвучка не удалась', (await svc.speak('Текст')) === null);
    check('сбой сети: текст ошибки понятен', /нет соединения/.test(state.logs.map((l) => l.text).join(' ')),
      state.logs.map((l) => l.text).join(' | '));
  }

  // ═══════ 11. Таймаут ═══════
  calls.length = 0;
  global.fetch = (url, init = {}) =>
    new Promise((_r, reject) => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      init.signal.addEventListener('abort', () => reject(err));
    });
  {
    const { svc, state } = make();
    const p = svc.speak('Долгий текст');
    // Ждём срабатывания таймера внутри модуля нельзя (30 с),
    // поэтому проверяем только, что вызов ещё в работе
    check('таймаут: озвучка ещё занята', svc.busy === true);
    // Форсируем снятие блокировки, чтобы не ждать 30 секунд
    svc.busy = false;
    p.catch(() => {});
  }

  // ═══════ 12. maskedKey ═══════
  {
    const a = new SpeechifyTTS(() => freshConfig(), () => {});
    check('маскирование ключа', a.maskedKey() === 'sk_tes…7890', a.maskedKey());
    const b = new SpeechifyTTS(() => ({ speechify_key: '' }), () => {});
    check('без ключа: «не задан»', b.maskedKey() === 'не задан');
    const c = new SpeechifyTTS(() => ({ speechify_key: 'short' }), () => {});
    check('короткий ключ: только многоточие', c.maskedKey() === '…');
  }

  // ═══════ 13. Кэш чистится (не больше 30 файлов) ═══════
  {
    calls.length = 0;
    stubFetch(() => audioResponse(MP3));
    const dir = CACHE_DIR();
    for (const f of fs.readdirSync(dir)) {
      if (/^temp_speech-.*\.mp3$/.test(f)) fs.unlinkSync(path.join(dir, f));
    }
    const { svc } = make();
    for (let i = 0; i < 40; i++) {
      await svc.speak(`Сообщение ${i}`);
    }
    const left = fs.readdirSync(dir).filter((f) => /^temp_speech-.*\.mp3$/.test(f));
    check('кэш ограничен 30 файлами', left.length <= 30, `осталось ${left.length}`);
    for (const f of left) fs.unlinkSync(path.join(dir, f));
  }

  // ═══════ 14. test() — проба озвучки ═══════
  calls.length = 0;
  stubFetch(() => audioResponse(MP3));
  {
    const { svc, state } = make();
    check('test(): true при успехе', (await svc.test()) === true);
    check('test(): текст в логе', /Озвучка проверена/.test(state.logs.map((l) => l.text).join(' ')));
    check('test(): запрос ушёл', calls.length === 1);
    check('test(): input — дефраза проверки', /Проверка озвучки/.test(calls[0].body.input));
  }

  calls.length = 0;
  stubFetch(() => audioResponse(Buffer.from('nope'), 401, 'application/json'));
  {
    const { svc, state } = make();
    check('test(): false при ошибке', (await svc.test()) === false);
    check('test(): ошибка в логе', /Проверка озвучки не удалась/.test(state.logs.map((l) => l.text).join(' ')));
  }

  // ═══════ 15. Справочники для интерфейса ═══════
  check('RU_VOICES непустой', Array.isArray(RU_VOICES) && RU_VOICES.length >= 2);
  check('голоса alexei/agrippina есть', RU_VOICES.some((v) => v.id === 'alexei') && RU_VOICES.some((v) => v.id === 'agrippina'));
  check('MODELS содержит simba-3.5', MODELS.includes('simba-3.5'));
  check('LANGUAGES содержит ru-RU', LANGUAGES.includes('ru-RU'));

  // ═══════ 16. Конфиг читается динамически ═══════
  calls.length = 0;
  stubFetch(() => audioResponse(MP3));
  {
    const { svc, state } = make({ voice_id: 'alexei' });
    state.config.voice_id = 'agrippina';
    state.config.model = 'simba-3.0';
    await svc.speak('Голос изменён');
    check('изменение конфига применяется на лету (voice_id)', calls[0].body.voice_id === 'agrippina',
      JSON.stringify(calls[0].body));
    check('изменение конфига применяется на лету (model)', calls[0].body.model === 'simba-3.0');
  }

  global.fetch = origFetch;

  const failed = results.filter((r) => !r).length;
  console.log(`\n=== ${results.length - failed}/${results.length} проверок пройдено ===`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  global.fetch = origFetch;
  console.error('[FAIL] исключение:', err && err.stack ? err.stack : err);
  process.exit(1);
});
