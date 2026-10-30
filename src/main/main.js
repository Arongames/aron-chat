// ============================================================
// Главный процесс Electron.
//
//   config.js  — config.json: миграция, атомарная запись, черновик
//   tts.js     — Speechify Cloud (очередь фраз → mp3)
//   tiktok.js  — TikTok LIVE через tiktok-live-connector
//   twitch.js  — Twitch-чат через tmi.js (анонимное чтение)
//   youtube.js — YouTube Live через Data API v3 + авто-поиск эфира
//   viewers.js — счётчики зрителей Twitch / YouTube / TikTok
//   server.js  — HTTP+WebSocket оверлей для OBS (127.0.0.1)
//
// Окно управления получает события по IPC:
//   'chat:message'   — сообщение чата (platform: tiktok|twitch|youtube)
//   'tiktok:event'   — подписка / подарок / лайк / вход
//   'app:log'        — системные строки
//   'tts:play'       — готовый mp3 для воспроизведения
//   'viewers:update' — счётчики зрителей
//   'overlay:info'   — адрес оверлея и состояние сервера
//   '<platform>:status' — состояние подключения
//
// Настройки: правки из окна приходят в 'config:set' и живут в
// памяти (черновик). 'config:save' пишет файл; при закрытии окна
// несохранённое сохраняется автоматически.
// ============================================================

const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  loadConfig,
  saveConfig,
  getConfigPath,
  getConfigDir,
  sanitize,
  SECRET_FIELDS,
  decryptSecrets,
  stripSecrets,
} = require('./config');
const SpeechifyTTS = require('./tts');
const TikTokLive = require('./tiktok');
const TwitchChat = require('./twitch');
const YouTubeChat = require('./youtube');
const ViewersTracker = require('./viewers');
const TwitchAssets = require('./emotes');
const twitchOAuth = require('./twitch_oauth');
const googleOAuth = require('./google_oauth');
const createOverlayServer = require('./server');

let mainWindow = null;

// Текущее состояние настроек (может содержать ещё не сохранённые правки)
let config = loadConfig();
// Снимок последнего сохранения — для индикатора «есть изменения»
let savedSignature = JSON.stringify(config);

const isDirty = () => JSON.stringify(config) !== savedSignature;

const sendToWindow = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
};

const log = (entry) => {
  sendToWindow('app:log', entry);
  try {
    const line = `[${new Date().toISOString()}] ${entry && entry.level || 'info'}: ${entry && entry.text || ''}\n`;
    fs.appendFileSync(path.join(getConfigDir(), 'aron.log'), line, 'utf8');
  } catch {
    // лог не критичен для работы
  }
};

// Сообщаем окну, что настройки изменились «сами» (подключение, эфир YouTube)
function notifyConfig() {
  sendToWindow('config:changed', { config, dirty: isDirty() });
}

// ============================================================
// TTS
// ============================================================
const tts = new SpeechifyTTS(
  () => config,
  (file, url) => sendToWindow('tts:play', { file, url }),
  log
);

// Piper лежит в assets, но в упакованном приложении — в app.asar.unpacked
tts.setPiperRoot(app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'piper')
  : path.join(__dirname, '../../assets/piper'));

// Аватары и эмоуты Twitch
const twitchAssets = new TwitchAssets(log);

// ============================================================
// Оверлей
// ============================================================
function overlaySettings(cfg = config) {
  return {
    chat: {
      position: cfg.overlay_chat_position,
      scale: cfg.overlay_chat_scale,
      maxMessages: cfg.overlay_chat_max_messages,
      ttl: cfg.overlay_chat_ttl,
      showEvents: cfg.overlay_show_events,
      fontSize: cfg.chat_font_size,
      iconSize: cfg.platform_icon_size,
      showIcons: cfg.show_platform_icons !== false,
    },
    viewers: {
      enabled: cfg.overlay_viewers_enabled !== false,
      position: cfg.overlay_viewers_position,
      scale: cfg.overlay_viewers_scale,
    },
  };
}

const overlay = createOverlayServer(
  () => overlaySettings(),
  // Снимок счётчиков для hello: новый оверлей сразу получает цифры
  () => viewers.snapshot(),
  // Эмоуты для hello — чтобы чат-оверлей сразу рисовал картинки
  () => ({ emotes: twitchAssets.getEmotes() }),
  // Пользовательский CSS, который правится в настройках
  (widget) => (widget === 'viewers' ? config.overlay_viewers_css : config.overlay_chat_css)
);

function overlayInfo() {
  const port = overlay.getPort();
  const base = port ? `http://127.0.0.1:${port}` : '';
  return {
    enabled: config.overlay_enabled !== false,
    running: overlay.isRunning(),
    port,
    base,
    // Два независимых Browser Source: чат и счётчики зрителей
    chatUrl: base ? `${base}/overlay/chat` : null,
    viewersUrl: base ? `${base}/overlay/viewers` : null,
    url: base ? `${base}/overlay/chat` : null,
  };
}

function broadcastOverlayInfo() {
  sendToWindow('overlay:info', overlayInfo());
}

// ============================================================
// Эмоуты 7TV / BTTV / FFZ
// ============================================================
async function refreshEmotes(login) {
  if (config.emotes_enabled === false || !login) {
    clearEmotes();
    return {};
  }
  const map = await twitchAssets.loadEmotes(login);
  sendToWindow('emotes:update', map);
  overlay.broadcast({ type: 'emotes', emotes: map });
  return map;
}

function clearEmotes() {
  twitchAssets.clearEmotes();
  sendToWindow('emotes:update', {});
  overlay.broadcast({ type: 'emotes', emotes: {} });
}

// ============================================================
// OAuth Twitch / Google и отправка сообщений
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let twitchDeviceSession = null;
let googleLoginInProgress = false;

function oauthStatus() {
  return {
    twitch: {
      clientId: config.twitch_client_id,
      loggedIn: !!config.twitch_access_token,
      login: config.twitch_login,
    },
    google: {
      clientId: config.google_client_id,
      hasSecret: !!config.google_client_secret,
      loggedIn: !!config.google_access_token,
    },
    sendPlatform: config.send_platform,
  };
}

function tokenExpiresSoon(at) {
  return !at || Number(at) - Date.now() < 120000;
}

async function ensureTwitchToken() {
  let token = config.twitch_access_token;
  if (!token) throw new Error('войдите через Twitch на вкладке «Доступ»');
  if (tokenExpiresSoon(config.twitch_token_expires_at)) {
    if (!config.twitch_refresh_token) throw new Error('токен Twitch истёк — войдите заново');
    const fresh = await twitchOAuth.refresh(
      config.twitch_client_id,
      config.twitch_refresh_token,
      config.twitch_client_secret
    );
    config = sanitize({
      ...config,
      twitch_access_token: fresh.accessToken,
      twitch_refresh_token: fresh.refreshToken,
      twitch_token_expires_at: Date.now() + fresh.expiresIn * 1000,
    });
    persistConfig();
    notifyConfig();
    token = fresh.accessToken;
  }
  return token;
}

async function ensureGoogleToken() {
  let token = config.google_access_token;
  if (!token) throw new Error('войдите через Google на вкладке «Доступ»');
  if (tokenExpiresSoon(config.google_token_expires_at)) {
    if (!config.google_refresh_token) throw new Error('токен Google истёк — войдите заново');
    try {
      const fresh = await googleOAuth.refresh({
        clientId: config.google_client_id,
        clientSecret: config.google_client_secret,
        refreshToken: config.google_refresh_token,
      });
      config = sanitize({
        ...config,
        google_access_token: fresh.accessToken,
        google_refresh_token: fresh.refreshToken,
        google_token_expires_at: Date.now() + fresh.expiresIn * 1000,
      });
      persistConfig();
      notifyConfig();
      token = fresh.accessToken;
    } catch (err) {
      // Если Google отозвал refresh token — сбрасываем вход,
      // чтобы пользователь видел «Войти заново», а не пустой чат.
      if (/invalid_grant|invalid_client|unauthorized_client/i.test(err.message)) {
        config = sanitize({
          ...config,
          google_access_token: '',
          google_refresh_token: '',
          google_token_expires_at: 0,
        });
        persistConfig();
        notifyConfig();
        throw new Error('сессия Google истекла — войдите через Google заново');
      }
      throw err;
    }
  }
  return token;
}

// Фоновое ожидание подтверждения кода Twitch
async function awaitTwitchDevice(device, session) {
  const deadline = Date.now() + device.expiresIn * 1000;
  try {
    while (Date.now() < deadline) {
      if (session.cancelled) throw new Error('вход отменён');
      await sleep(Math.max(5, device.interval) * 1000);
      if (session.cancelled) throw new Error('вход отменён');

      const result = await twitchOAuth.pollDevice(config.twitch_client_id, device.deviceCode);
      if (result.pending) continue;

      const info = await twitchOAuth.validate(result.accessToken);
      config = sanitize({
        ...config,
        twitch_access_token: result.accessToken,
        twitch_refresh_token: result.refreshToken,
        twitch_token_expires_at: Date.now() + result.expiresIn * 1000,
        twitch_login: info.login || '',
        twitch_user_id: info.user_id || '',
      });
      persistConfig();
      notifyConfig();
      log({ level: 'info', text: `Twitch: вход выполнен (${info.login})` });
      return;
    }
    throw new Error('время ожидания входа истекло');
  } catch (err) {
    log({ level: 'error', text: `Twitch OAuth: ${err.message}` });
    sendToWindow('oauth:error', { provider: 'twitch', message: err.message });
  } finally {
    if (twitchDeviceSession === session) twitchDeviceSession = null;
    sendToWindow('oauth:update', oauthStatus());
  }
}

async function applyOverlayConfig(prev) {
  const wasEnabled = prev ? prev.overlay_enabled !== false : true;
  const prevPort = prev ? prev.overlay_port : config.overlay_port;

  if (!config.overlay_enabled) {
    if (overlay.isRunning()) {
      await overlay.stop();
      log({ level: 'info', text: 'Оверлей остановлен' });
    }
    broadcastOverlayInfo();
    return;
  }

  if (!overlay.isRunning()) {
    await overlay.start(config.overlay_port);
    const info = overlayInfo();
    log({
      level: 'info',
      text: `Оверлей: чат ${info.chatUrl} · зрители ${info.viewersUrl}`,
    });
  } else if (!wasEnabled || prevPort !== config.overlay_port) {
    await overlay.restart(config.overlay_port);
    const info = overlayInfo();
    log({ level: 'info', text: `Оверлей перезапущен: ${info.chatUrl}` });
  }

  overlay.pushSettings(overlaySettings());
  broadcastOverlayInfo();
}

// ============================================================
// Зрители
// ============================================================
const viewers = new ViewersTracker();

viewers.on('update', (counters) => {
  sendToWindow('viewers:update', counters);
  overlay.broadcast({ type: 'viewers', viewers: counters });
});

let viewersSignature = '';

function syncViewers(force = false) {
  const signature = JSON.stringify([
    config.viewers_enabled, config.viewers_twitch, config.viewers_youtube,
    config.viewers_tiktok, config.twitch_channel, config.twitch_client_id,
    config.twitch_access_token,
    config.youtube_video_id, config.youtube_api_key,
  ]);
  if (!force && signature === viewersSignature) return;
  viewersSignature = signature;

  viewers.start({
    enabled: config.viewers_enabled !== false,
    twitch: config.viewers_twitch !== false,
    youtube: config.viewers_youtube !== false,
    tiktok: config.viewers_tiktok !== false,
    twitchChannel: config.twitch_channel,
    twitchClientId: config.twitch_client_id,
    twitchAccessToken: config.twitch_access_token,
    youtubeVideoId: config.youtube_video_id,
    youtubeApiKey: config.youtube_api_key,
    getTikTokCount: () => tiktok.fetchViewerCount(),
  });
}

// ============================================================
// Фильтры озвучки
// ============================================================

// Причина, по которой сообщение НЕ озвучивается (или null).
// На ленту чата и оверлей фильтры не влияют — они только для TTS.
function filterReason(text, user) {
  const lower = String(text || '').toLowerCase();
  const lowerUser = String(user || '').toLowerCase();

  if (config.prefix_filter_enabled !== false) {
    const hit = (config.ignored_prefixes || []).find(
      (p) => p && lower.startsWith(String(p).trim().toLowerCase())
    );
    if (hit) return `префикс «${hit}»`;
  }

  const byUser = (config.ignored_users || []).find(
    (u) => u && lowerUser === String(u).trim().toLowerCase()
  );
  if (byUser) return `пользователь ${byUser}`;

  const byPhrase = (config.ignored_phrases || []).find(
    (p) => p && lower.includes(String(p).trim().toLowerCase())
  );
  if (byPhrase) return `фраза «${byPhrase}»`;

  return null;
}

// Кастомная команда по первому слову
function findCommand(text) {
  const first = String(text || '').trim().split(/\s+/)[0].toLowerCase();
  if (!first) return null;
  return (config.custom_commands || []).find(
    (c) => c.trigger && c.trigger.toLowerCase() === first
  ) || null;
}

// «Ник говорит: текст» или только текст
function composeMessageText(user, text) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  return config.speak_username ? `${user} говорит: ${clean}` : clean;
}

// ============================================================
// Входящее сообщение из любого чата
// ============================================================
const AVATAR_TTL = 6 * 60 * 60 * 1000;

// Аватар Twitch подтягиваем при первом сообщении и запоминаем
function twitchAvatar(login) {
  if (!login) return null;
  const info = twitchAssets.profiles.get(String(login).toLowerCase());
  if (info && Date.now() - info.at < AVATAR_TTL) return info.avatar;

  twitchAssets.profile(login).then((fresh) => {
    if (!fresh || !fresh.avatar) return;
    sendToWindow('chat:avatar', { platform: 'twitch', login, avatar: fresh.avatar });
    overlay.broadcast({ type: 'avatar', platform: 'twitch', login, avatar: fresh.avatar });
  }).catch(() => {});

  return info ? info.avatar : null;
}

function handleChatMessage({ platform, user, text, color, isMod, isSubscriber, avatar, login, silent }) {
  const clean = String(text || '').trim();
  if (!clean) return;

  // Полностью скрытые пользователи не попадают ни в ленту, ни в оверлей
  const lowerUser = String(user || '').toLowerCase();
  if ((config.hidden_users || []).some((u) => String(u).trim().toLowerCase() === lowerUser)) {
    return;
  }

  const message = {
    platform: platform || 'tiktok',
    user: user || 'гость',
    login: login || null,
    text: clean,
    avatar: config.avatars_enabled === false
      ? null
      : (avatar || (platform === 'twitch' ? twitchAvatar(login) : null)),
    color: color || null,
    isMod: !!isMod,
    isSubscriber: !!isSubscriber,
    time: Date.now(),
  };

  // 1) Всегда в окно управления и в оверлей
  sendToWindow('chat:message', message);
  overlay.broadcast({ type: 'chat', message });

  // silent — только показать (используется проверками, без синтеза речи)
  if (silent) return;

  // 2) Кастомная команда: озвучиваем заготовленный ответ
  const command = findCommand(clean);
  if (command) {
    log({ level: 'info', text: `Команда ${command.trigger} → озвучиваем ответ` });
    tts.speak(command.response);
    return;
  }

  // 3) Фильтры: сообщение видно, но не озвучивается
  const reason = filterReason(clean, message.user);
  if (reason) {
    log({ level: 'info', text: `Не озвучено (${reason}): ${message.user}: ${clean}` });
    return;
  }

  // 4) Обычная озвучка
  tts.speak(composeMessageText(message.user, clean));
}

// ============================================================
// TikTok LIVE
// ============================================================
const tiktok = new TikTokLive();

tiktok.on('message', handleChatMessage);

tiktok.on('follow', ({ user }) => {
  const event = { type: 'follow', platform: 'tiktok', user, time: Date.now() };
  sendToWindow('tiktok:event', event);
  overlay.broadcast({ type: 'event', event });
  if (config.speak_follows) tts.speak(`${user} подписался!`);
});

tiktok.on('gift', ({ user, giftName, count }) => {
  const event = { type: 'gift', platform: 'tiktok', user, giftName, count, time: Date.now() };
  sendToWindow('tiktok:event', event);
  overlay.broadcast({ type: 'event', event });
  if (config.speak_gifts) {
    tts.speak(`${user} подарил ${giftName} в количестве ${count} штук!`);
  }
});

tiktok.on('like', ({ user, count, totalLikes }) => {
  const event = { type: 'like', platform: 'tiktok', user, count, totalLikes, time: Date.now() };
  sendToWindow('tiktok:event', event);
  overlay.broadcast({ type: 'event', event });
});

tiktok.on('member', ({ user }) => {
  const event = { type: 'member', platform: 'tiktok', user, time: Date.now() };
  sendToWindow('tiktok:event', event);
  overlay.broadcast({ type: 'event', event });
});

tiktok.on('status', (s) => {
  sendToWindow('tiktok:status', {
    connected: !!s.connected,
    username: s.connected ? tiktok.username : '',
    text: s.text,
  });
});

async function connectTikTok(username) {
  const name = String(username || '').replace(/^@/, '').trim();
  if (!name) throw new Error('укажите никнейм трансляции TikTok (без @)');

  await tiktok.connect(name);
  config = sanitize({ ...config, tiktok_username: name });
  syncViewers();
  notifyConfig();
}

// ============================================================
// Twitch
// ============================================================
const twitch = new TwitchChat();

twitch.on('message', (msg) => {
  handleChatMessage({
    platform: 'twitch',
    user: msg.user,
    login: msg.login,
    text: msg.text,
    color: msg.color,
    isMod: msg.isMod,
    isSubscriber: msg.isSubscriber,
  });
});

twitch.on('status', (s) => sendToWindow('twitch:status', s));

async function connectTwitch(channel) {
  const name = String(channel || '').replace(/^#/, '').trim().toLowerCase();
  if (!name) throw new Error('укажите канал Twitch');
  await twitch.connect(name);
  config = sanitize({ ...config, twitch_channel: name });
  syncViewers();
  refreshEmotes(name).catch(() => {});
  notifyConfig();
}

// ============================================================
// YouTube
// ============================================================
const youtube = new YouTubeChat();

youtube.on('message', (msg) => handleChatMessage(msg));

youtube.on('status', (s) => sendToWindow('youtube:status', s));
youtube.on('log', (text) => log({ level: 'info', text }));

youtube.on('stream:changed', ({ videoId, reason }) => {
  config = sanitize({ ...config, youtube_video_id: videoId });
  // Найденный автоматически эфир — служебное состояние, сохраняем сразу
  persistConfig();
  viewers.setYouTubeVideo(videoId);
  notifyConfig();
  log({ level: 'info', text: `YouTube: новый эфир ${videoId} (${reason})` });
});

async function connectYouTube(params) {
  // liveChatMessages требует OAuth, одного API-ключа недостаточно
  let accessToken = null;
  try {
    accessToken = await ensureGoogleToken();
  } catch (err) {
    log({ level: 'error', text: `YouTube: ${err.message}` });
  }
  const result = await youtube.start({
    ...params,
    accessToken,
    refreshAccessToken: () => ensureGoogleToken(),
  });
  config = sanitize({
    ...config,
    youtube_channel: params.channel || config.youtube_channel,
    youtube_api_key: params.apiKey || config.youtube_api_key,
    youtube_auto_reconnect: params.autoReconnect !== false,
  });
  syncViewers();
  notifyConfig();
  return result;
}

// ============================================================
// Сохранение
// ============================================================
function persistConfig() {
  const res = saveConfig(config);
  if (res.ok) {
    savedSignature = JSON.stringify(config);
    sendToWindow('config:dirty', { dirty: false });
  } else {
    log({ level: 'error', text: `Сохранение не удалось: ${res.error}` });
  }
  return res;
}

// Применение изменённых настроек к работающим службам
async function applyRuntime(prev) {
  if (!prev) return;
  const overlayChanged =
    prev.overlay_enabled !== config.overlay_enabled
    || prev.overlay_port !== config.overlay_port;
  if (overlayChanged) await applyOverlayConfig(prev);
  else overlay.pushSettings(overlaySettings());

  if (prev.emotes_enabled !== config.emotes_enabled) {
    if (config.emotes_enabled !== false && config.twitch_channel) {
      refreshEmotes(config.twitch_channel).catch(() => {});
    } else {
      clearEmotes();
    }
  }

  syncViewers();
}

// ============================================================
// IPC
// ============================================================
function registerIpcHandlers() {
  // --- Настройки ---
  ipcMain.handle('config:get', () => ({
    config,
    dirty: isDirty(),
    path: getConfigPath(),
    dir: getConfigDir(),
    keyMasked: tts.maskedKey(),
    appVersion: app.getVersion(),
    overlay: overlayInfo(),
    viewers: viewers.snapshot(),
    oauth: oauthStatus(),
  }));

  // Черновик: меняем настройки в памяти, файл не трогаем
  ipcMain.handle('config:set', async (_event, partial) => {
    const prev = config;
    config = sanitize({ ...config, ...partial });
    await applyRuntime(prev);
    sendToWindow('config:dirty', { dirty: isDirty() });
    return { config, dirty: isDirty(), overlay: overlayInfo() };
  });

  // Явная кнопка «Сохранить»
  ipcMain.handle('config:save', (_event, partial) => {
    if (partial && Object.keys(partial).length) {
      config = sanitize({ ...config, ...partial });
    }
    const res = persistConfig();
    log({
      level: res.ok ? 'info' : 'error',
      text: res.ok
        ? `Настройки сохранены: ${res.file}`
        : `Не удалось сохранить настройки: ${res.error}`,
    });
    return { ok: res.ok, file: res.file, path: getConfigPath(), error: res.error, dirty: isDirty() };
  });

  // Сброс черновика к последнему сохранённому
  ipcMain.handle('config:reset', async () => {
    const prev = config;
    config = loadConfig();
    savedSignature = JSON.stringify(config);
    await applyRuntime(prev);
    sendToWindow('config:dirty', { dirty: false });
    return { config, dirty: false, overlay: overlayInfo() };
  });

  ipcMain.handle('config:reveal', () => {
    const file = getConfigPath();
    try {
      shell.showItemInFolder(file);
      return { ok: true, file };
    } catch (err) {
      log({ level: 'error', text: `Не удалось открыть папку: ${err.message}` });
      return { ok: false, file, error: err.message };
    }
  });

  // Экспорт настроек в файл (ключи входят в файл — предупреждаем в UI)
  ipcMain.handle('config:export', async () => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Экспорт настроек Aron Chat',
        defaultPath: path.join(getConfigDir(), 'aron-chat-settings.json'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      const payload = {
        ...stripSecrets(sanitize(config)),
        _export: {
          app: 'Aron Chat',
          version: app.getVersion(),
          exportedAt: new Date().toISOString(),
          secretsOmitted: true,
        },
      };
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
      return { ok: true, file: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Импорт настроек: заменяем известные поля и сразу применяем
  ipcMain.handle('config:import', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Импорт настроек Aron Chat',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };

      const raw = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
      // В экспорте секретов нет — не затираем уже введённые ключи
      for (const field of SECRET_FIELDS) {
        if (!raw[field] || String(raw[field]).startsWith('enc:')) raw[field] = config[field];
      }
      const prev = config;
      config = sanitize({ ...config, ...raw });
      await applyRuntime(prev);
      persistConfig();
      notifyConfig();
      return { ok: true, config, file: filePaths[0] };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app:openLogFolder', () => {
    try {
      const file = path.join(getConfigDir(), 'aron.log');
      if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
      shell.showItemInFolder(file);
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Ссылки из «О программе» — во внешний браузер
  ipcMain.handle('app:openExternal', (_event, url) => {
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'разрешены только http(s)-ссылки' };
    shell.openExternal(target);
    return { ok: true };
  });

  ipcMain.handle('update:download', async (_event, payload = {}) => {
    const url = String(payload.url || '');
    const version = String(payload.version || '').replace(/[^\w.-]/g, '') || 'latest';
    if (!/^https:\/\//i.test(url)) return { ok: false, error: 'разрешены только https-ссылки' };

    const file = path.join(os.tmpdir(), `AronChat-Setup-${version}.exe`);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': `AronChat/${app.getVersion()}` },
      });
      if (!res.ok || !res.body) throw new Error(`сервер ответил HTTP ${res.status}`);

      const total = Number(res.headers.get('content-length')) || 0;
      const out = fs.createWriteStream(file);
      const reader = res.body.getReader();
      let received = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        received += chunk.length;
        if (!out.write(chunk)) {
          await new Promise((resolve) => out.once('drain', resolve));
        }
        sendToWindow('update:progress', {
          received,
          total,
          percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
        });
      }

      await new Promise((resolve, reject) => {
        out.end((err) => (err ? reject(err) : resolve()));
      });
      return { ok: true, file, size: received };
    } catch (err) {
      try { fs.unlinkSync(file); } catch { /* нет файла */ }
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('update:install', async (_event, file) => {
    const target = path.resolve(String(file || ''));
    if (!/\.exe$/i.test(target) || !target.startsWith(os.tmpdir())) {
      return { ok: false, error: 'недопустимый файл обновления' };
    }
    if (!fs.existsSync(target)) return { ok: false, error: 'файл обновления не найден' };

    const opened = await shell.openPath(target);
    if (opened) return { ok: false, error: opened };
    setTimeout(() => app.quit(), 1500);
    return { ok: true };
  });

  // --- Проверка обновлений ---
  function compareVersions(a, b) {
    const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
    const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  ipcMain.handle('update:check', async () => {
    const url = String(config.update_manifest_url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'не задан адрес проверки обновлений' };
    }
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': `AronChat/${app.getVersion()}`,
          Accept: 'application/vnd.github+json, application/json',
        },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`сервер ответил HTTP ${res.status}`);
      const data = await res.json();

      let latest = '';
      let notes = '';
      let download = '';
      let publishedAt = '';
      let assetName = '';

      // GitHub Releases API
      if (data && (data.tag_name || (data.name && data.assets))) {
        latest = String(data.tag_name || data.name || '').replace(/^v/i, '').trim();
        notes = String(data.body || '').slice(0, 8000);
        publishedAt = data.published_at || '';
        const assets = Array.isArray(data.assets) ? data.assets : [];
        const setup = assets.find((a) => /Setup.*\.exe$/i.test(a.name || ''))
          || assets.find((a) => /\.exe$/i.test(a.name || ''));
        if (setup) {
          download = setup.browser_download_url || '';
          assetName = setup.name || '';
        }
      } else {
        // Свой latest.json
        latest = String(data.version || data.latest || '').replace(/^v/i, '').trim();
        notes = String(data.notes || '').slice(0, 8000);
        download = String(data.url || data.download || '');
        publishedAt = data.date || data.published_at || '';
      }

      if (!latest) throw new Error('в ответе нет номера версии');
      const current = app.getVersion();
      return {
        ok: true,
        current,
        latest,
        hasUpdate: compareVersions(latest, current) > 0,
        notes,
        url: download,
        assetName,
        publishedAt,
      };
    } catch (err) {
      const message = err.name === 'TimeoutError'
        ? 'сервер проверки обновлений не ответил'
        : err.message;
      return { ok: false, error: message };
    }
  });

  // --- Оверлей ---
  ipcMain.handle('overlay:info', () => overlayInfo());

  // Текущий набор эмоутов (окно могло загрузиться позже их получения)
  ipcMain.handle('emotes:get', () => twitchAssets.getEmotes());

  ipcMain.handle('overlay:open', (_event, widget) => {
    const info = overlayInfo();
    const url = widget === 'viewers' ? info.viewersUrl : info.chatUrl;
    if (!url) return { ok: false, error: 'оверлей выключен или ещё не запущен' };
    shell.openExternal(url);
    return { ok: true, url };
  });

  ipcMain.handle('overlay:restart', async () => {
    if (!config.overlay_enabled) return { ok: false, error: 'оверлей выключен в настройках' };
    const res = await overlay.restart(config.overlay_port);
    broadcastOverlayInfo();
    return { ok: true, ...res };
  });

  // --- OAuth ---
  ipcMain.handle('oauth:status', () => oauthStatus());

  ipcMain.handle('oauth:twitch:start', async () => {
    try {
      if (!config.twitch_client_id) throw new Error('укажите Twitch Client ID');
      if (twitchDeviceSession) throw new Error('вход уже идёт — код показан выше');

      const device = await twitchOAuth.startDevice(config.twitch_client_id);
      const session = { cancelled: false };
      twitchDeviceSession = session;

      shell.openExternal(device.verificationUri);
      log({ level: 'info', text: `Twitch: код ${device.userCode} — подтвердите на ${device.verificationUri}` });
      awaitTwitchDevice(device, session).catch(() => {});

      return {
        ok: true,
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        expiresIn: device.expiresIn,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('oauth:twitch:cancel', () => {
    if (twitchDeviceSession) twitchDeviceSession.cancelled = true;
    return { ok: true };
  });

  ipcMain.handle('oauth:twitch:logout', () => {
    config = sanitize({
      ...config,
      twitch_access_token: '',
      twitch_refresh_token: '',
      twitch_token_expires_at: 0,
      twitch_login: '',
      twitch_user_id: '',
    });
    persistConfig();
    notifyConfig();
    return { ok: true, oauth: oauthStatus() };
  });

  ipcMain.handle('oauth:google:start', async () => {
    try {
      if (!config.google_client_id || !config.google_client_secret) {
        throw new Error('укажите Google Client ID и Client Secret');
      }
      if (googleLoginInProgress) throw new Error('вход уже идёт — завершите его в браузере');

      googleLoginInProgress = true;
      const started = { clientId: config.google_client_id, clientSecret: config.google_client_secret };

      googleOAuth.startAuth({
        clientId: started.clientId,
        clientSecret: started.clientSecret,
        openUrl: (url) => shell.openExternal(url),
      }).then(async (tokens) => {
        config = sanitize({
          ...config,
          google_access_token: tokens.accessToken,
          google_refresh_token: tokens.refreshToken || config.google_refresh_token,
          google_token_expires_at: Date.now() + tokens.expiresIn * 1000,
        });
        persistConfig();
        notifyConfig();
        log({ level: 'info', text: 'Google: вход выполнен' });

        // После входа сразу подключаем YouTube-чат, если канал уже задан
        if (config.youtube_channel && config.youtube_api_key) {
          try {
            await connectYouTube({
              channel: config.youtube_channel,
              apiKey: config.youtube_api_key,
              videoId: config.youtube_video_id,
              autoReconnect: config.youtube_auto_reconnect,
            });
            log({ level: 'info', text: `YouTube ${config.youtube_channel} подключён после входа` });
          } catch (err) {
            log({ level: 'error', text: `YouTube после входа: ${err.message}` });
          }
        }
      }).catch((err) => {
        log({ level: 'error', text: `Google OAuth: ${err.message}` });
        sendToWindow('oauth:error', { provider: 'google', message: err.message });
      }).finally(() => {
        googleLoginInProgress = false;
        sendToWindow('oauth:update', oauthStatus());
      });

      log({ level: 'info', text: 'Google: откройте браузер и подтвердите доступ' });
      return { ok: true, started: true };
    } catch (err) {
      googleLoginInProgress = false;
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('oauth:google:logout', () => {
    config = sanitize({
      ...config,
      google_access_token: '',
      google_refresh_token: '',
      google_token_expires_at: 0,
    });
    persistConfig();
    notifyConfig();
    return { ok: true, oauth: oauthStatus() };
  });

  // Отправка сообщения в чат площадки (Twitch / YouTube)
  ipcMain.handle('chat:send', async (_event, payload = {}) => {
    const text = String(payload.text || '').trim();
    const platform = payload.platform || config.send_platform;
    if (!text) return { ok: false, error: 'пустое сообщение' };

    try {
      if (platform === 'twitch') {
        const token = await ensureTwitchToken();
        const profile = await twitchAssets.profile(config.twitch_channel);
        if (!profile || !profile.id) throw new Error('не удалось определить канал Twitch');
        if (!config.twitch_user_id) throw new Error('нет данных пользователя — войдите заново');

        await twitchOAuth.sendMessage({
          accessToken: token,
          clientId: config.twitch_client_id,
          broadcasterId: profile.id,
          senderId: config.twitch_user_id,
          message: text,
        });
        log({ level: 'info', text: `Отправлено в Twitch: ${text}` });
        return { ok: true };
      }

      if (platform === 'youtube') {
        const token = await ensureGoogleToken();
        if (!youtube.liveChatId) throw new Error('чат YouTube не подключён');
        if (String(youtube.liveChatId).startsWith('innertube:')) {
          throw new Error(
            'YouTube: чат читается в резервном режиме — отправка недоступна, '
            + 'пока не восстановится квота YouTube API'
          );
        }
        await googleOAuth.sendMessage({
          accessToken: token,
          liveChatId: youtube.liveChatId,
          message: text,
        });
        log({ level: 'info', text: `Отправлено в YouTube: ${text}` });
        return { ok: true };
      }

      throw new Error('отправка в эту площадку не поддерживается');
    } catch (err) {
      let message = err.message;
      if (/user:write:chat/i.test(message)) {
        message = 'Twitch: нужно заново войти в аккаунт — Twitch требует новое разрешение '
          + 'user:write:chat. Откройте «Доступ» → «Выйти» и войдите через Twitch снова.';
      }
      return { ok: false, error: message };
    }
  });

  // --- Блокировка пользователя из ленты ---
  ipcMain.handle('user:hide', (_event, payload) => {
    const name = String((payload && payload.user) || '').trim();
    if (!name) return { ok: false, error: 'пустой ник' };
    const lower = name.toLowerCase();
    const exists = (config.hidden_users || []).some(
      (u) => String(u).trim().toLowerCase() === lower
    );
    if (!exists) {
      config = sanitize({ ...config, hidden_users: [...(config.hidden_users || []), name] });
      persistConfig();
      notifyConfig();
    }
    overlay.broadcast({ type: 'hide-user', user: name });
    return { ok: true, config };
  });

  // --- TikTok ---
  ipcMain.handle('tiktok:connect', async (_event, username) => {
    try {
      await connectTikTok(username);
      return { ok: true };
    } catch (err) {
      log({ level: 'error', text: `TikTok: ${err.message}` });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('tiktok:disconnect', () => {
    tiktok.disconnect();
    syncViewers();
    return { ok: true };
  });

  ipcMain.handle('tiktok:status', () => ({
    connected: tiktok.isConnected(),
    username: tiktok.username || '',
  }));

  // --- TTS ---
  ipcMain.handle('tts:test', () => tts.test());
  ipcMain.handle('tts:speak', (_event, text) => tts.speak(text));

  // --- Twitch ---
  ipcMain.handle('twitch:connect', async (_event, channel) => {
    try {
      await connectTwitch(channel);
      return { ok: true };
    } catch (err) {
      log({ level: 'error', text: `Twitch: ${err.message}` });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('twitch:disconnect', () => {
    twitch.disconnect();
    syncViewers();
    return { ok: true };
  });

  ipcMain.handle('twitch:status', () => ({
    connected: twitch.isConnected(),
    channel: twitch.channel || '',
  }));

  // --- YouTube ---
  ipcMain.handle('youtube:connect', async (_event, params) => {
    try {
      const result = await connectYouTube({
        channel: params.channel || config.youtube_channel,
        apiKey: params.apiKey || config.youtube_api_key,
        videoId: params.videoId || config.youtube_video_id,
        autoReconnect: params.autoReconnect ?? config.youtube_auto_reconnect,
      });
      if (!result?.connected) {
        return { ok: false, error: (result && result.error) || 'активная трансляция не найдена' };
      }
      return { ok: true };
    } catch (err) {
      log({ level: 'error', text: `YouTube: ${err.message}` });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('youtube:disconnect', () => {
    youtube.stop();
    syncViewers();
    return { ok: true };
  });

  ipcMain.handle('youtube:status', () => ({
    connected: youtube.isConnected(),
    channel: youtube.channelRef || '',
  }));

  // --- Нижняя панель ---
  // Прямая отправка в чат площадок не поддерживается: Webcast только
  // читается, Twitch анонимный, YouTube требует OAuth. Зато команды
  // работают — это удобный способ проверить озвучку.
  ipcMain.handle('panel:send', (_event, { platform, text } = {}) => {
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, reason: 'empty' };

    const command = findCommand(clean);
    if (command) {
      const message = {
        platform: platform || 'tiktok',
        user: 'Локально',
        text: clean,
        time: Date.now(),
      };
      sendToWindow('chat:message', message);
      overlay.broadcast({ type: 'chat', message });
      log({ level: 'info', text: `Команда ${command.trigger} → озвучиваем ответ` });
      tts.speak(command.response);
      return { ok: true, executed: command.trigger, response: command.response };
    }

    log({ level: 'info', text: 'Команда не найдена — озвучиваем введённый текст' });
    tts.speak(clean);
    return { ok: true, executed: null };
  });

  // --- Окно ---
  ipcMain.on('window:minimize', () => mainWindow.minimize());
  ipcMain.on('window:maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    sendToWindow('window:maximized', { maximized: mainWindow.isMaximized() });
  });
  ipcMain.on('window:close', () => mainWindow.close());

  ipcMain.handle('status:get', () => ({
    appVersion: app.getVersion(),
    tiktok: tiktok.isConnected(),
    tiktokUsername: tiktok.username || '',
    twitch: twitch.isConnected(),
    twitchChannel: twitch.channel || '',
    youtube: youtube.isConnected(),
    youtubeChannel: youtube.channelRef || '',
    configPath: getConfigPath(),
    keyMasked: tts.maskedKey(),
    hasKey: !!tts.apiKey,
    overlay: overlayInfo(),
    viewers: viewers.snapshot(),
    oauth: oauthStatus(),
  }));
  if (!app.isPackaged) {
    ipcMain.handle('dev:chat', (_event, msg = {}) => {
      const payload = {
        platform: msg.platform || 'twitch',
        user: msg.user || 'TestUser',
        login: msg.login,
        text: msg.text || 'Проверка ленты чата',
        avatar: msg.avatar,
        color: msg.color,
        isMod: msg.isMod,
        silent: !!msg.silent,
        time: Date.now(),
      };
      handleChatMessage(payload);
      return true;
    });

    ipcMain.handle('dev:event', (_event, evt = {}) => {
      const event = { ...evt, platform: evt.platform || 'tiktok', time: Date.now() };
      sendToWindow('tiktok:event', event);
      overlay.broadcast({ type: 'event', event });
      return true;
    });

    ipcMain.handle('dev:viewers', (_event, counters = {}) => {
      viewers.setCounters(counters);
      return true;
    });
  }
}

// ============================================================
// Окно
// ============================================================
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 560,
    minHeight: 420,
    resizable: true,
    maximizable: true,
    backgroundColor: '#0b0d11',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    frame: false,
    autoHideMenuBar: true,
    title: 'Aron Chat',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.on('maximize', () => sendToWindow('window:maximized', { maximized: true }));
  mainWindow.on('unmaximize', () => sendToWindow('window:maximized', { maximized: false }));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // Расшифровываем секреты (DPAPI) до запуска сервисов
    config = sanitize(decryptSecrets(config));
    registerIpcHandlers();
    createMainWindow();

    // Оверлей поднимаем до подключения площадок, чтобы OBS сразу видел адрес
    if (config.overlay_enabled) {
      try {
        const res = await overlay.start(config.overlay_port);
        const info = overlayInfo();
        log({
          level: 'info',
          text: `Оверлей: чат ${info.chatUrl} · зрители ${info.viewersUrl}`,
        });
      } catch (err) {
        log({ level: 'error', text: `Оверлей не запустился: ${err.message}` });
      }
    }
    broadcastOverlayInfo();
    syncViewers(true);

    // Эмоуты грузим сразу по сохранённому каналу, не дожидаясь коннекта чата
    if (config.twitch_channel && config.emotes_enabled !== false) {
      refreshEmotes(config.twitch_channel).catch(() => {});
    }

    log({
      level: 'info',
      text: `Aron Chat ${app.getVersion()} · конфиг: ${getConfigPath()}`,
    });
    log({
      level: tts.apiKey ? 'info' : 'error',
      text: tts.apiKey
        ? `Speechify: ключ ${tts.maskedKey()}`
        : 'API-ключ Speechify не задан — озвучка недоступна. Введите ключ на вкладке «Настройки».',
    });

    // Автоподключение сохранённых площадок
    if (config.tiktok_username) {
      connectTikTok(config.tiktok_username)
        .then(() => log({ level: 'info', text: `TikTok @${config.tiktok_username} подключён автоматически` }))
        .catch((err) => log({ level: 'error', text: `TikTok: ${err.message}` }));
    }
    if (config.twitch_channel) {
      connectTwitch(config.twitch_channel)
        .then(() => log({ level: 'info', text: `Twitch #${config.twitch_channel} подключён автоматически` }))
        .catch((err) => log({ level: 'error', text: `Twitch: ${err.message}` }));
    }
    if (config.youtube_channel && config.youtube_api_key) {
      connectYouTube({
        channel: config.youtube_channel,
        apiKey: config.youtube_api_key,
        videoId: config.youtube_video_id,
        autoReconnect: config.youtube_auto_reconnect,
      })
        .then(() => log({ level: 'info', text: `YouTube ${config.youtube_channel} подключён автоматически` }))
        .catch((err) => log({ level: 'error', text: `YouTube: ${err.message}` }));
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  // Автосохранение несохранённых правок при выходе
  app.on('before-quit', () => {
    tiktok.disconnect();
    twitch.disconnect();
    youtube.stop();
    viewers.stop();
    overlay.stop();
    if (isDirty()) {
      const res = saveConfig(config);
      if (!res.ok) console.error('[config] автосохранение при выходе не удалось:', res.error);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
