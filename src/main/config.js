// ============================================================
// Конфигурация приложения: единый config.json.
//
// ГДЕ ЛЕЖИТ ФАЙЛ (это критично — раньше настройки «не сохранялись»):
//   1. Portable-сборка: electron-builder запускает приложение из
//      временной папки %TEMP%\<hash>\resources\app.asar, и запись в
//      app.getAppPath() туда исчезает после закрытия окна.
//      Поэтому для portable используем PORTABLE_EXECUTABLE_DIR —
//      каталог, в котором реально лежит .exe.
//   2. Режим разработки (npx electron .) — корень проекта.
//   3. Установленная (NSIS) версия — userData, там есть права на запись.
//
// ЗАПИСЬ: атомарная (во временный файл + rename), чтобы обрыв процесса
// или антивирус не оставили битый JSON посередине стрима.
//
// С 1.9.0 окно управления не пишет файл на каждое изменение: правки
// копятся в черновике (stage), а на диск попадают по кнопке
// «Сохранить» или при закрытии приложения.
// ============================================================

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const CONFIG_NAME = 'config.json';

// ============================================================
// Встроенные ключи приложения (OAuth-клиенты, не пользовательские).
//
// Сами ключи лежат в src/main/builtin.js — этот файл не коммитится
// (см. .gitignore). Шаблон: src/main/builtin.example.js.
// Можно переопределить переменными окружения при сборке.
// Пользовательские токены входа хранятся в его config.json, а не здесь.
// ============================================================
let builtins = {};
try {
  // eslint-disable-next-line global-require
  builtins = require('./builtin');
} catch {
  // файла нет — ключи можно ввести вручную в «Продвинутых настройках»
}

const BUILTIN_GOOGLE_CLIENT_ID =
  process.env.ARON_GOOGLE_CLIENT_ID || builtins.googleClientId || '';
const BUILTIN_GOOGLE_CLIENT_SECRET =
  process.env.ARON_GOOGLE_CLIENT_SECRET || builtins.googleClientSecret || '';
const BUILTIN_TWITCH_CLIENT_ID =
  process.env.ARON_TWITCH_CLIENT_ID || builtins.twitchClientId || '';

// Значения по умолчанию. Ключ Speechify пуст: встраивать рабочий ключ
// в приложение нельзя — стример вводит свой собственный.
const DEFAULT_CONFIG = {
  speechify_key: '',
  // TikTok LIVE
  tiktok_username: '',
  // Twitch (анонимное чтение, без OAuth)
  twitch_channel: '',
  twitch_client_id: BUILTIN_TWITCH_CLIENT_ID,
  // Нужен только для Twitch-приложения типа Confidential
  twitch_client_secret: '',
  // YouTube Live (требуется API-ключ Data API v3)
  youtube_channel: '',
  youtube_api_key: '',
  youtube_video_id: '',
  youtube_auto_reconnect: true,
  // Озвучка
  tts_engine: 'speechify',   // speechify | piper | none
  voice_id: 'alexei',        // голос Speechify
  model: 'simba-3.5',
  language: 'ru-RU',
  piper_voice: 'dmitri',     // офлайн-голос Piper
  tts_speed: 100,            // процент скорости
  tts_volume: 100,           // громкость плеера
  speak_username: false,
  speak_follows: true,
  speak_gifts: true,
  // Фильтры: что не озвучивать (в чате и оверлее сообщения остаются)
  prefix_filter_enabled: true,
  ignored_prefixes: ['!g'],
  ignored_users: [],
  ignored_phrases: [],
  // Полностью скрыть пользователя из ленты и оверлея
  hidden_users: [],
  // Эмоуты 7TV/BTTV/FFZ и аватары пользователей
  emotes_enabled: true,
  avatars_enabled: true,
  // Кастомный CSS виджетов
  overlay_chat_css: '',
  overlay_viewers_css: '',
  // Первый запуск
  onboarding_done: false,
  // Оверлей для OBS: два независимых виджета — чат и счётчики зрителей.
  // У каждого свой адрес, позиция и масштаб, чтобы ставить их в разные
  // углы сцены отдельными Browser Source.
  overlay_enabled: true,
  overlay_port: 3000,
  overlay_chat_position: 'bottom-left',
  overlay_chat_scale: 100,
  overlay_chat_max_messages: 12,
  overlay_chat_ttl: 60,
  overlay_show_events: true,
  // Оформление ленты: размер текста и значков платформ (приложение и оверлей)
  chat_font_size: 13,
  platform_icon_size: 22,
  show_platform_icons: true,
  overlay_viewers_enabled: true,
  overlay_viewers_position: 'top-left',
  overlay_viewers_scale: 100,
  viewers_enabled: true,
  // Проверка обновлений (GitHub Releases или свой latest.json)
  update_check_enabled: true,
  update_manifest_url: 'https://api.github.com/repos/Arongames/aron-chat/releases/latest',
  // Акцентный цвет интерфейса
  theme_accent: 'mint',
  viewers_twitch: true,
  viewers_youtube: true,
  viewers_tiktok: true,
  // OAuth: Twitch (device flow, нужен только Client ID)
  twitch_access_token: '',
  twitch_refresh_token: '',
  twitch_token_expires_at: 0,
  twitch_login: '',
  twitch_user_id: '',
  // OAuth: Google/YouTube (Desktop app: Client ID + Secret)
  google_client_id: BUILTIN_GOOGLE_CLIENT_ID,
  google_client_secret: BUILTIN_GOOGLE_CLIENT_SECRET,
  google_access_token: '',
  google_refresh_token: '',
  google_token_expires_at: 0,
  // DonationAlerts
  donationalerts_client_id: builtins.donationalertsClientId || '',
  donationalerts_client_secret: builtins.donationalertsClientSecret || '',
  donationalerts_enabled: true,
  donationalerts_access_token: '',
  donationalerts_refresh_token: '',
  donationalerts_token_expires_at: 0,
  donationalerts_last_id: 0,
  speak_donations: true,
  // Площадка для отправки сообщений из нижней панели
  send_platform: 'twitch',
  // Кастомные команды
  custom_commands: [
    {
      trigger: '!дискорд',
      response: 'Присоединяйтесь к нашему серверу Дискорд! Ссылка в описании профиля.',
      description: 'Выводит ссылку на Discord',
    },
  ],
};

// Каталог, где должен лежать config.json
function resolveConfigDir() {
  // 1. Portable-EXE: рядом с самим файлом .exe
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }

  // 2. Не упакованное приложение (разработка) — корень проекта
  if (!app.isPackaged) {
    return app.getAppPath();
  }

  // 3. Установленная версия — userData (%APPDATA%)
  return app.getPath('userData');
}

function getConfigPath() {
  return path.join(resolveConfigDir(), CONFIG_NAME);
}

// Миграция старых конфигов (1.7 и раньше — camelCase, другие дефолты)
const LEGACY_MAP = {
  speechifyApiKey: 'speechify_key',
  tiktokNickname: 'tiktok_username',
  speechifyVoice: 'voice_id',
  speechifyModel: 'model',
  speechifyLanguage: 'language',
  ttsSpeakNickname: 'speak_username',
  twitchChannel: 'twitch_channel',
  twitchClientId: 'twitch_client_id',
  youtubeChannel: 'youtube_channel',
  youtubeApiKey: 'youtube_api_key',
  youtubeVideoId: 'youtube_video_id',
  youtubeAutoReconnect: 'youtube_auto_reconnect',
  ttsPrefixes: 'ignored_prefixes',
  ttsIgnoredUsers: 'ignored_users',
  ttsIgnoredPhrases: 'ignored_phrases',
  ttsPrefixFilterEnabled: 'prefix_filter_enabled',
};

function migrate(raw) {
  const next = { ...raw };

  for (const [oldKey, newKey] of Object.entries(LEGACY_MAP)) {
    if (oldKey in next && !(newKey in next)) {
      // ttsSpeakNickname имел инвертированную логику по умолчанию
      next[newKey] = oldKey === 'ttsSpeakNickname' ? next[oldKey] === true : next[oldKey];
    }
    delete next[oldKey];
  }

  // Поля локального TTS, OBS-оверлея и лишние токены удалённых движков
  // больше не нужны — выбрасываем молча.
  for (const junk of [
    'ttsApiBase', 'ttsSamplePath', 'ttsEngine', 'ttsVoice',
    'ttsPrefixesRaw', 'youtubeAccessToken', 'obsPort', 'serverPort',
  ]) {
    delete next[junk];
  }

  // Голос geffen_32 в каталоге Speechify отсутствует: если он остался
  // в конфиге с 1.8.0, меняем на реально существующий alexei.
  if (!next.voice_id || next.voice_id === 'geffen_32') next.voice_id = 'alexei';

  // Оверлей был одним виджетом — переносим его поля в «чат», а
  // переключатель зрителей становится отдельным виджетом.
  const overlayLegacy = {
    overlay_position: 'overlay_chat_position',
    overlay_font_scale: 'overlay_chat_scale',
    overlay_max_messages: 'overlay_chat_max_messages',
    overlay_ttl: 'overlay_chat_ttl',
    overlay_show_viewers: 'overlay_viewers_enabled',
  };
  for (const [oldKey, newKey] of Object.entries(overlayLegacy)) {
    if (oldKey in next && !(newKey in next)) next[newKey] = next[oldKey];
    delete next[oldKey];
  }

  if (typeof next.speak_follows !== 'boolean') next.speak_follows = true;
  if (typeof next.speak_gifts !== 'boolean') next.speak_gifts = true;
  if (typeof next.youtube_auto_reconnect !== 'boolean') next.youtube_auto_reconnect = true;

  if (!Array.isArray(next.ignored_prefixes) || !next.ignored_prefixes.length) {
    next.ignored_prefixes = [...DEFAULT_CONFIG.ignored_prefixes];
  }
  if (!Array.isArray(next.custom_commands)) next.custom_commands = [];

  return next;
}

// Проверка формы кастомной команды
function normalizeCommands(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => ({
      trigger: String((c && c.trigger) || '').trim(),
      response: String((c && c.response) || '').trim(),
      description: String((c && c.description) || '').trim(),
    }))
    .filter((c) => c.trigger && c.response);
}

// Аккуратно приводим список строк: обрезаем, убираем пустые и дубли
function stringList(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = String(item || '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const POSITIONS = ['bottom-left', 'top-left', 'bottom-right', 'top-right'];

function sanitize(config) {
  const out = { ...config };

  out.speechify_key = String(out.speechify_key || '').trim();
  out.tiktok_username = String(out.tiktok_username || '').replace(/^@/, '').trim();
  out.twitch_channel = String(out.twitch_channel || '').replace(/^#/, '').trim().toLowerCase();
  out.twitch_client_id = String(out.twitch_client_id || '').trim() || BUILTIN_TWITCH_CLIENT_ID;
  out.twitch_client_secret = String(out.twitch_client_secret || '').trim();
  out.youtube_channel = String(out.youtube_channel || '').trim();
  out.youtube_api_key = String(out.youtube_api_key || '').trim();
  out.youtube_video_id = String(out.youtube_video_id || '').trim();
  out.youtube_auto_reconnect = out.youtube_auto_reconnect !== false;
  out.voice_id = String(out.voice_id || '').trim() || DEFAULT_CONFIG.voice_id;
  out.model = String(out.model || '').trim() || DEFAULT_CONFIG.model;
  out.language = String(out.language || '').trim() || DEFAULT_CONFIG.language;

  out.tts_engine = ['speechify', 'piper', 'none'].includes(out.tts_engine)
    ? out.tts_engine
    : 'speechify';
  out.piper_voice = String(out.piper_voice || '').trim() || DEFAULT_CONFIG.piper_voice;
  out.tts_speed = clampInt(out.tts_speed, 50, 200, 100);
  out.tts_volume = clampInt(out.tts_volume, 0, 100, 100);

  out.speak_username = out.speak_username === true;
  out.speak_follows = out.speak_follows !== false;
  out.speak_gifts = out.speak_gifts !== false;

  out.prefix_filter_enabled = out.prefix_filter_enabled !== false;
  out.ignored_prefixes = stringList(out.ignored_prefixes);
  if (!out.ignored_prefixes.length) out.ignored_prefixes = [...DEFAULT_CONFIG.ignored_prefixes];
  out.ignored_users = stringList(out.ignored_users);
  out.ignored_phrases = stringList(out.ignored_phrases);
  out.hidden_users = stringList(out.hidden_users);
  out.emotes_enabled = out.emotes_enabled !== false;
  out.avatars_enabled = out.avatars_enabled !== false;
  out.overlay_chat_css = String(out.overlay_chat_css || '').slice(0, 20000);
  out.overlay_viewers_css = String(out.overlay_viewers_css || '').slice(0, 20000);
  out.onboarding_done = out.onboarding_done === true;

  out.overlay_enabled = out.overlay_enabled !== false;
  out.overlay_port = clampInt(out.overlay_port, 1024, 65535, DEFAULT_CONFIG.overlay_port);
  out.overlay_chat_position = POSITIONS.includes(out.overlay_chat_position)
    ? out.overlay_chat_position
    : DEFAULT_CONFIG.overlay_chat_position;
  out.overlay_chat_scale = clampInt(out.overlay_chat_scale, 60, 180, 100);
  out.overlay_chat_max_messages = clampInt(out.overlay_chat_max_messages, 3, 30, 12);
  out.overlay_chat_ttl = clampInt(out.overlay_chat_ttl, 0, 600, 60);
  out.overlay_show_events = out.overlay_show_events !== false;
  out.chat_font_size = clampInt(out.chat_font_size, 10, 28, 13);
  out.platform_icon_size = clampInt(out.platform_icon_size, 14, 40, 22);
  out.show_platform_icons = out.show_platform_icons !== false;
  out.overlay_viewers_enabled = out.overlay_viewers_enabled !== false;
  out.overlay_viewers_position = POSITIONS.includes(out.overlay_viewers_position)
    ? out.overlay_viewers_position
    : DEFAULT_CONFIG.overlay_viewers_position;
  out.overlay_viewers_scale = clampInt(out.overlay_viewers_scale, 60, 200, 100);

  out.viewers_enabled = out.viewers_enabled !== false;
  out.viewers_twitch = out.viewers_twitch !== false;
  out.viewers_youtube = out.viewers_youtube !== false;
  out.viewers_tiktok = out.viewers_tiktok !== false;

  // Проверка обновлений
  out.update_check_enabled = out.update_check_enabled !== false;
  out.update_manifest_url = String(out.update_manifest_url || '').trim()
    || DEFAULT_CONFIG.update_manifest_url;
  out.theme_accent = ['mint', 'violet', 'blue', 'pink', 'amber'].includes(out.theme_accent)
    ? out.theme_accent
    : 'mint';

  out.twitch_access_token = String(out.twitch_access_token || '').trim();
  out.twitch_refresh_token = String(out.twitch_refresh_token || '').trim();
  out.twitch_token_expires_at = Number(out.twitch_token_expires_at) || 0;
  out.twitch_login = String(out.twitch_login || '').trim();
  out.twitch_user_id = String(out.twitch_user_id || '').trim();

  out.google_client_id = String(out.google_client_id || '').trim() || BUILTIN_GOOGLE_CLIENT_ID;
  out.google_client_secret = String(out.google_client_secret || '').trim() || BUILTIN_GOOGLE_CLIENT_SECRET;
  out.google_access_token = String(out.google_access_token || '').trim();
  out.google_refresh_token = String(out.google_refresh_token || '').trim();
  out.donationalerts_client_id = String(out.donationalerts_client_id || '').trim();
  out.donationalerts_client_secret = String(out.donationalerts_client_secret || '').trim();
  out.donationalerts_enabled = out.donationalerts_enabled !== false;
  out.donationalerts_access_token = String(out.donationalerts_access_token || '').trim();
  out.donationalerts_refresh_token = String(out.donationalerts_refresh_token || '').trim();
  out.donationalerts_token_expires_at = Number(out.donationalerts_token_expires_at) || 0;
  out.donationalerts_last_id = Number(out.donationalerts_last_id) || 0;
  out.speak_donations = out.speak_donations !== false;
  out.google_token_expires_at = Number(out.google_token_expires_at) || 0;

  out.send_platform = ['twitch', 'youtube'].includes(out.send_platform)
    ? out.send_platform
    : 'twitch';

  out.custom_commands = normalizeCommands(out.custom_commands);

  return out;
}

// Копия значений по умолчанию: spread ({...DEFAULT_CONFIG}) разделял
// ссылки на массивы, и правка ignored_prefixes в рантайме мутировала
// сам DEFAULT_CONFIG.
function defaultConfig() {
  return sanitize({ ...DEFAULT_CONFIG });
}

// Секреты, которые нельзя писать в config.json открытым текстом:
// ключ Speechify, API-ключ YouTube и OAuth-токены.
// На диске они лежат в зашифрованном виде (safeStorage: DPAPI на Windows).
const SECRET_FIELDS = [
  'speechify_key',
  'youtube_api_key',
  'twitch_access_token',
  'twitch_refresh_token',
  'twitch_client_secret',
  'google_client_secret',
  'google_access_token',
  'google_refresh_token',
  'donationalerts_client_secret',
  'donationalerts_access_token',
  'donationalerts_refresh_token',
];
const ENC_PREFIX = 'enc:v1:';

function secretsAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptSecrets(cfg) {
  const out = { ...cfg };
  if (!secretsAvailable()) return out;
  for (const field of SECRET_FIELDS) {
    const value = out[field];
    if (!value || String(value).startsWith(ENC_PREFIX)) continue;
    try {
      out[field] = ENC_PREFIX + safeStorage.encryptString(String(value)).toString('base64');
    } catch {
      // не смогли зашифровать — оставляем как есть, приложение продолжит работать
    }
  }
  return out;
}

function decryptSecrets(cfg) {
  const out = { ...cfg };
  if (!secretsAvailable()) return out;
  for (const field of SECRET_FIELDS) {
    const value = out[field];
    if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) continue;
    try {
      out[field] = safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
    } catch {
      out[field] = '';
    }
  }
  return out;
}

// Копия конфига для экспорта: без ключей и токенов
function stripSecrets(cfg) {
  const out = { ...cfg };
  for (const field of SECRET_FIELDS) out[field] = '';
  return out;
}

function loadConfig() {
  const file = getConfigPath();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return sanitize({ ...defaultConfig(), ...migrate(raw) });
  } catch (err) {
    // Файла нет / он повреждён / права не позволили прочитать.
    // Читаем и показываем причину, чтобы молчаливый сброс настроек
    // не выглядел как «сохранение не работает».
    if (err.code !== 'ENOENT') {
      console.error('[config] не удалось прочитать ' + file + ':', err.message);
    }
    return defaultConfig();
  }
}

// Атомарная запись. Возвращает путь, куда реально записали файл.
function saveConfig(config) {
  const file = getConfigPath();
  const tmp = file + '.tmp';
  // Секреты на диск — только в зашифрованном виде
  const data = JSON.stringify(encryptSecrets(sanitize(config)), null, 2);

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Резервная копия предыдущей версии — на случай сбоя или отката
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    } catch { /* копия не критична */ }
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (err) {
    // Запасной вариант: если рядом с .exe писать нельзя (например
    // установил в Program Files без прав) — уходим в userData.
    try {
      const fallback = path.join(app.getPath('userData'), CONFIG_NAME);
      fs.writeFileSync(fallback + '.tmp', data, 'utf8');
      fs.renameSync(fallback + '.tmp', fallback);
      console.error(`[config] ${file} недоступен (${err.code}), пишу ${fallback}`);
      return { ok: true, file: fallback, fallback: true, error: err.message };
    } catch (err2) {
      console.error('[config] сохранение не удалось:', err2.message);
      return { ok: false, file, error: err.message };
    }
  }
}

module.exports = {
  DEFAULT_CONFIG,
  POSITIONS,
  getConfigPath,
  getConfigDir: resolveConfigDir,
  loadConfig,
  saveConfig,
  sanitize,
  normalizeCommands,
  SECRET_FIELDS,
  decryptSecrets,
  stripSecrets,
};
