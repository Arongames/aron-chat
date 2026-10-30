// ============================================================
// Проверка config.js: структура, миграция, атомарная запись,
// выбор каталога (portable / dev / fallback).
//   node config_test.js
// Модуль electron подменяется заглушкой.
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Каталог для тестов ---
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aron-config-'));
const PROJECT_DIR = path.join(TMP, 'project');
const PORTABLE_DIR = path.join(TMP, 'portable');
const USER_DATA = path.join(TMP, 'userdata');
for (const d of [PROJECT_DIR, PORTABLE_DIR, USER_DATA]) fs.mkdirSync(d, { recursive: true });

// --- Заглушка electron ---
let packaged = false;
const electronStub = {
  app: {
    get isPackaged() { return packaged; },
    getAppPath: () => PROJECT_DIR,
    getPath: (name) => (name === 'userData' ? USER_DATA : TMP),
    getVersion: () => '1.8.0',
  },
};
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return origResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electronStub };

const cfg = require('./src/main/config');

const results = [];
function check(name, ok, extra = '') {
  results.push(ok);
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${extra ? ' — ' + extra : ''}`);
}

const CONFIG_FILE = () => path.join(cfg.getConfigDir(), 'config.json');

function writeRaw(obj) {
  fs.writeFileSync(CONFIG_FILE(), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8');
}

try {
  // ═══════ 1. Каталог: режим разработки ═══════
  delete process.env.PORTABLE_EXECUTABLE_DIR;
  packaged = false;
  check('dev: конфиг в корне проекта', cfg.getConfigDir() === PROJECT_DIR, cfg.getConfigDir());

  // ═══════ 2. Каталог: portable ═══════
  process.env.PORTABLE_EXECUTABLE_DIR = PORTABLE_DIR;
  check('portable: конфиг рядом с .exe', cfg.getConfigDir() === PORTABLE_DIR, cfg.getConfigDir());
  check('portable: путь к файлу', cfg.getConfigPath() === path.join(PORTABLE_DIR, 'config.json'));

  // ═══════ 3. Каталог: установленная (NSIS) версия ═══════
  delete process.env.PORTABLE_EXECUTABLE_DIR;
  packaged = true;
  check('packaged: конфиг в userData', cfg.getConfigDir() === USER_DATA, cfg.getConfigDir());

  // ═══════ 4. Значения по умолчанию ═══════
  packaged = false;
  const d = cfg.loadConfig();
  check('без файла: ключ пуст (не вшиваем)', d.speechify_key === '', JSON.stringify(d.speechify_key));
  check('без файла: tiktok_username пуст', d.tiktok_username === '');
  check('без файла: voice_id = geffen_32', d.voice_id === 'geffen_32', d.voice_id);
  check('без файла: model = simba-3.5', d.model === 'simba-3.5');
  check('без файла: language = ru-RU', d.language === 'ru-RU');
  check('без файла: speak_username = false', d.speak_username === false);
  check('без файла: speak_follows = true', d.speak_follows === true);
  check('без файла: speak_gifts = true', d.speak_gifts === true);
  check('без файла: ignored_prefixes = ["!g"]', JSON.stringify(d.ignored_prefixes) === '["!g"]');
  check('без файла: есть команда !дискорд', d.custom_commands[0].trigger === '!дискорд');
  check('без файла: команда с описанием', typeof d.custom_commands[0].description === 'string');

  // ═══════ 5. Полный набор полей в схеме ═══════
  const EXPECTED = ['speechify_key', 'tiktok_username', 'voice_id', 'model', 'language',
    'speak_username', 'speak_follows', 'speak_gifts', 'ignored_prefixes', 'custom_commands',
    // Площадки возвращены в 1.8: Twitch и YouTube чаты
    'twitch_channel', 'youtube_channel', 'youtube_api_key', 'youtube_video_id',
    'youtube_auto_reconnect'];
  check('схема: все поля ТЗ + площадки', EXPECTED.every((k) => k in d), EXPECTED.filter((k) => !(k in d)).join(','));
  check('схема: youtube_auto_reconnect=true', d.youtube_auto_reconnect === true);

  // ═══════ 6. Сохранение и чтение ═══════
  const saved = cfg.saveConfig({ ...d, tiktok_username: '@arongames', speechify_key: ' sk_key_123 ' });
  check('saveConfig: ok', saved.ok === true, JSON.stringify(saved));
  check('saveConfig: файл создан', fs.existsSync(saved.file));
  check('saveConfig: без fallback', !saved.fallback);
  const back = cfg.loadConfig();
  check('чтение: ник сохранён', back.tiktok_username === 'arongames', back.tiktok_username);
  check('чтение: @ снят', !back.tiktok_username.startsWith('@'));
  check('чтение: ключ обрезан', back.speechify_key === 'sk_key_123', JSON.stringify(back.speechify_key));
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
  check('на диске: ключ сохранён (для пользователя)', onDisk.speechify_key === 'sk_key_123');
  check('на диске: JSON pretty (2 пробела)', fs.readFileSync(CONFIG_FILE(), 'utf8').includes('\n  "'));

  // ═══════ 7. Атомарность: .tmp не остаётся ═══════
  check('запись: временный файл удалён', !fs.existsSync(CONFIG_FILE() + '.tmp'));

  // ═══════ 8. Миграция старых имён полей ═══════
  writeRaw({
    speechifyApiKey: 'sk_old_key_999',
    tiktokNickname: '@oldnick',
    speechifyVoice: 'alexei',
    speechifyModel: 'simba-3.0',
    speechifyLanguage: 'en-US',
    ttsSpeakNickname: true,
  });
  const m = cfg.loadConfig();
  check('миграция: speechifyApiKey → speechify_key', m.speechify_key === 'sk_old_key_999', m.speechify_key);
  check('миграция: tiktokNickname → tiktok_username', m.tiktok_username === 'oldnick', m.tiktok_username);
  check('миграция: speechifyVoice → voice_id', m.voice_id === 'alexei');
  check('миграция: speechifyModel → model', m.model === 'simba-3.0');
  check('миграция: speechifyLanguage → language', m.language === 'en-US');
  check('миграция: ttsSpeakNickname → speak_username', m.speak_username === true);
  check('миграция: старых полей не осталось', !('speechifyApiKey' in m) && !('ttsSpeakNickname' in m));

  // ═══════ 9. Миграция: старые поля площадок → snake_case ═══════
  writeRaw({
    ttsEngine: 'speechify',
    ttsVoice: 'ru-RU',
    ttsApiBase: 'http://localhost:7860',
    ttsPrefixes: ['!g'],
    twitchChannel: 'Streamer',
    twitchClientId: 'CID',
    youtubeChannel: '@chan',
    youtubeApiKey: 'AAA',
    youtubeVideoId: 'VID',
    youtubeAutoReconnect: false,
    voice_id: 'agrippina',
  });
  const m2 = cfg.loadConfig();
  check('миграция: ttsEngine выброшен', !('ttsEngine' in m2));
  check('миграция: ttsApiBase (localhost:7860) выброшен', !('ttsApiBase' in m2));
  check('миграция: twitchClientId выброшен', !('twitchClientId' in m2));
  check('миграция: twitchChannel → twitch_channel', m2.twitch_channel === 'streamer', m2.twitch_channel);
  check('миграция: youtubeChannel → youtube_channel', m2.youtube_channel === '@chan', m2.youtube_channel);
  check('миграция: youtubeApiKey → youtube_api_key', m2.youtube_api_key === 'AAA');
  check('миграция: youtubeVideoId → youtube_video_id', m2.youtube_video_id === 'VID');
  check('миграция: youtubeAutoReconnect → youtube_auto_reconnect', m2.youtube_auto_reconnect === false);
  check('миграция: voice_id сохранён', m2.voice_id === 'agrippina');
  check('миграция: speak_follows включён по умолчанию', m2.speak_follows === true);
  check('миграция: ignored_prefixes дополнен дефолтом', m2.ignored_prefixes.includes('!g'));

  // ═══════ 10. ttsSpeakNickname=false сохраняется как false ═══════
  writeRaw({ ttsSpeakNickname: false });
  check('миграция: speak_username=false', cfg.loadConfig().speak_username === false);

  // ═══════ 11. Битый JSON не роняет приложение ═══════
  writeRaw('{ "speechify_key": "sk_x", ');
  let threw = false;
  let recovered = null;
  try { recovered = cfg.loadConfig(); } catch { threw = true; }
  check('битый JSON: без исключения', threw === false);
  check('битый JSON: возвращены дефолты', recovered && recovered.voice_id === 'geffen_32');

  // ═══════ 12. Пустой массив префиксов → дефолт ═══════
  check('sanitize: пустые префиксы → ["!g"]',
    JSON.stringify(cfg.sanitize({ ignored_prefixes: [] }).ignored_prefixes) === '["!g"]');
  check('sanitize: пробелы вырезаны',
    JSON.stringify(cfg.sanitize({ ignored_prefixes: [' !a ', '', '  !b'] }).ignored_prefixes) === '["!a","!b"]');

  // ═══════ 13. normalizeCommands ═══════
  const norm = cfg.normalizeCommands([
    { trigger: ' !x ', response: ' Ответ ', description: ' Описание ' },
    { trigger: '', response: 'нет триггера' },
    { trigger: '!y', response: '   ' },
    null,
    'строка вместо объекта',
  ]);
  check('команды: нормализация пробелов', norm[0].trigger === '!x' && norm[0].response === 'Ответ');
  check('команды: без триггера выброшены', norm.length === 1, JSON.stringify(norm));

  // ═══════ 14. speak_follows/speak_gifts: только явный false выключает ═══════
  check('sanitize: speak_follows undefined → true', cfg.sanitize({}).speak_follows === true);
  check('sanitize: speak_gifts false → false', cfg.sanitize({ speak_gifts: false }).speak_gifts === false);
  check('sanitize: speak_username undefined → false', cfg.sanitize({}).speak_username === false);

  // ═══════ 15. Пустой voice_id/model/language → дефолты ═══════
  const s = cfg.sanitize({ voice_id: '  ', model: '', language: null });
  check('sanitize: пустой voice_id → дефолт', s.voice_id === 'geffen_32');
  check('sanitize: пустая model → дефолт', s.model === 'simba-3.5');
  check('sanitize: пустой language → дефолт', s.language === 'ru-RU');

  // ═══════ 15b. Sanitize полей площадок ═══════
  const sp = cfg.sanitize({
    twitch_channel: '#StreamerName',
    youtube_channel: '  @chan  ',
    youtube_api_key: '  AIza  ',
    youtube_video_id: ' VID ',
  });
  check('sanitize: twitch_channel → lowercase без #', sp.twitch_channel === 'streamername', sp.twitch_channel);
  check('sanitize: youtube_channel обрезан', sp.youtube_channel === '@chan', sp.youtube_channel);
  check('sanitize: youtube_api_key обрезан', sp.youtube_api_key === 'AIza', sp.youtube_api_key);
  check('sanitize: youtube_video_id обрезан', sp.youtube_video_id === 'VID', sp.youtube_video_id);
  check('sanitize: youtube_auto_reconnect undefined → true', sp.youtube_auto_reconnect === true);
  check('sanitize: youtube_auto_reconnect false → false',
    cfg.sanitize({ youtube_auto_reconnect: false }).youtube_auto_reconnect === false);

  // ═══════ 16. Fallback: каталог только для чтения ═══════
  const RO_DIR = path.join(TMP, 'readonly');
  fs.mkdirSync(RO_DIR, { recursive: true });
  process.env.PORTABLE_EXECUTABLE_DIR = RO_DIR;
  const origMkdir = fs.mkdirSync;
  const origWrite = fs.writeFileSync;
  const origRename = fs.renameSync;
  fs.mkdirSync = function (dir, ...rest) {
    if (String(dir) === RO_DIR) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
    return origMkdir.call(fs, dir, ...rest);
  };
  fs.writeFileSync = function (file, ...rest) {
    if (String(file).startsWith(RO_DIR)) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
    return origWrite.call(fs, file, ...rest);
  };
  const fb = cfg.saveConfig({ ...d, tiktok_username: 'fallback_nick' });
  fs.mkdirSync = origMkdir;
  fs.writeFileSync = origWrite;
  fs.renameSync = origRename;
  check('fallback: сохранение всё равно ok', fb.ok === true, JSON.stringify(fb));
  check('fallback: помечен как запасной', fb.fallback === true);
  check('fallback: файл в userData', fb.file === path.join(USER_DATA, 'config.json'), fb.file);
  check('fallback: данные записаны', fs.existsSync(fb.file)
    && JSON.parse(fs.readFileSync(fb.file, 'utf8')).tiktok_username === 'fallback_nick');
  delete process.env.PORTABLE_EXECUTABLE_DIR;

  // ═══════ 17. DEFAULT_CONFIG не мутируется ═══════
  const before = JSON.stringify(cfg.DEFAULT_CONFIG);
  const c1 = cfg.loadConfig();
  c1.ignored_prefixes.push('!мутация');
  c1.custom_commands.push({ trigger: '!new', response: 'r' });
  check('DEFAULT_CONFIG: массивы не общие', JSON.stringify(cfg.DEFAULT_CONFIG) === before,
    JSON.stringify(cfg.DEFAULT_CONFIG));

  // ═══════ 18. Сохранение создаёт каталог, если его нет ═══════
  const NEW_DIR = path.join(TMP, 'nested', 'deep');
  process.env.PORTABLE_EXECUTABLE_DIR = NEW_DIR;
  const made = cfg.saveConfig({ ...d, voice_id: 'alexei' });
  check('сохранение создаёт каталог', made.ok && fs.existsSync(made.file));
  delete process.env.PORTABLE_EXECUTABLE_DIR;

  // ═══════ 19. Дефолтный конфиг не содержит ключа ═══════
  check('DEFAULT_CONFIG: speechify_key пуст', cfg.DEFAULT_CONFIG.speechify_key === '');
  const raw = fs.readFileSync(path.join(__dirname, 'src/main/tts.js'), 'utf8')
    + fs.readFileSync(path.join(__dirname, 'src/main/config.js'), 'utf8');
  check('исходники: встроенного ключа sk_ нет', !/sk_91vnqmy/.test(raw));
} catch (err) {
  check('исключение в тесте', false, err.stack || err.message);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* не критично */ }
}

const failed = results.filter((r) => !r).length;
console.log(`\n=== ${results.length - failed}/${results.length} проверок пройдено ===`);
process.exit(failed ? 1 : 0);
