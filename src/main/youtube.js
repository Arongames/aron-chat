// ============================================================
// Модуль YouTube-чата с АВТОМАТИЧЕСКИМ поиском актуального стрима.
//
// Проблема, которую решает модуль:
//   При рестарте трансляции YouTube создаёт НОВОЕ видео с НОВЫМ
//   ID, а старый liveChatId умирает. Пользователь не должен
//   вводить ID заново — модуль сам находит актуальный стрим.
//
// Ключевая идея: стабильный идентификатор — это КАНАЛ (@handle),
// а не видео. Видео-ID производная и обновляется на лету.
//
// Стратегия поиска актуального стрима (от дешёвой к резервной):
//   A) uploads-плейлист канала (UU...)  — 1+1 единица квоты
//   B) search?eventType=live&channelId= — бакет Search Queries
//   C) скрейпинг youtube.com/@handle/live — без ключа вообще
//      (даёт только videoId, дальше A/B конвертируют его в chatId)
//
// Автореконнект: watchdog опрашивает состояние, и как только
// стрим меняется/умирает (410 Gone, activeLiveChatId исчез, чат
// молчит слишком долго) — запускается поиск и фоновое
// переподключение с событием 'stream:changed' наружу.
//
// Формат сообщений идентичен twitch.js, чтобы main.js не знал,
// откуда пришло сообщение.
// ============================================================

const { EventEmitter } = require('events');

const API_BASE = 'https://www.googleapis.com/youtube/v3';

// Интервалы (мс)
const WATCHDOG_INTERVAL = 20000;    // проверка «жив ли ещё стрим»
const RECONNECT_DELAY = 15000;      // база паузы между попытками найти новый эфир
const RECONNECT_MAX_DELAY = 120000; // потолок backoff при долгом офлайне
const STALL_TIMEOUT = 180000;       // чат молчит 3 мин -> подозреваем конец стрима
const QUOTA_BACKOFF = 300000;       // после quotaExceeded не долбим API 5 мин

// Ошибки Data API, которые означают «этот стрим закончился»
const DEAD_CHAT_STATUSES = new Set([410]);
const DEAD_CHAT_REASONS = new Set([
  'liveChatNotStarted',
  'liveChatEnded',
  'liveChatDisabled',
  'channelForbidden',
  'notFound',
]);

class YouTubeChat extends EventEmitter {
  constructor() {
    super();
    this.channelRef = null;    // @handle / UC... / youtube.com/... — то, что вводит юзер
    this.channelId = null;     // резолвнутый UC... (внутренний кеш)
    this.uploadsPlaylist = null;
    this.videoId = null;
    this.videoTitle = null;
    this.liveChatId = null;
    this.pageToken = undefined;
    this.apiKey = null;
    this.accessToken = null;
    this.refreshAccessToken = null;
    this.autoReconnect = true;

    this.polling = false;      // основной цикл чтения чата активен
    this.running = false;      // модуль вообще запущен (юзер не жал «отключить»)
    this.reconnecting = false; // идёт поиск нового стрима
    this.watchdogTimer = null;
    this.lastMessageAt = 0;
    this.reconnectDelay = RECONNECT_DELAY;
    this.quotaBlockedUntil = 0;
  }

  isConnected() {
    return this.polling;
  }

  // ============================================================
  // HTTP-слой
  // ============================================================

  // Запрос к Data API. Бросает Error с полями .status и .reason,
  // чтобы вызывающий мог отличить «стрим умер» от «нет интернета».
  async apiGet(endpoint, params) {
    if (!this.apiKey && !this.accessToken) {
      throw new Error('не задан API-ключ или OAuth-токен YouTube');
    }
    const url = new URL(`${API_BASE}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    if (this.apiKey) url.searchParams.set('key', this.apiKey);

    const headers = {};
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

    let res = await fetch(url, { headers });
    // Токен мог истечь во время эфира — обновляем и повторяем один раз
    if ((res.status === 401 || res.status === 403) && typeof this.refreshAccessToken === 'function') {
      try {
        const fresh = await this.refreshAccessToken();
        if (fresh) {
          this.accessToken = fresh;
          headers.Authorization = `Bearer ${fresh}`;
          res = await fetch(url, { headers });
        }
      } catch {
        /* дальше отдадим исходную ошибку */
      }
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* пустое/не-JSON тело — обрабатывается ниже по статусу */
    }

    if (!res.ok) {
      const err = new Error(
        (data && data.error && data.error.message) || `HTTP ${res.status}`
      );
      err.status = res.status;
      err.reason =
        data && data.error && data.error.errors && data.error.errors[0]
          ? data.error.errors[0].reason
          : null;
      throw err;
    }
    return data;
  }

  // Простой GET за HTML-страницей (резервный путь без ключа)
  async fetchPage(url) {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'ru,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
    return { html: await res.text(), finalUrl: res.url };
  }

  // ============================================================
  // Разбор «кто мы» — канал
  // ============================================================

  // Приводим ввод пользователя к чему-то пригодному: @handle, UC... или логин
  static normalizeChannelRef(raw) {
    if (!raw) return null;
    let s = String(raw).trim();

    // Полная ссылка -> вытаскиваем последнюю значимую часть
    if (/youtube\.com/i.test(s) || /youtu\.be/i.test(s)) {
      try {
        const u = new URL(s.startsWith('http') ? s : `https://${s}`);
        const seg = u.pathname.split('/').filter(Boolean);
        s = seg[0] === 'channel' || seg[0] === 'user' || seg[0] === 'c' ? seg[1] : seg[0];
      } catch {
        /* оставляем как есть */
      }
    }
    s = s.replace(/^\/+/, '');
    if (/^UC[0-9A-Za-z_-]{22}$/.test(s)) return s; // уже channel ID
    if (s.startsWith('@')) return s;               // handle
    return s.includes('/') ? s.split('/').pop() : s;
  }

  // Резолвим канал через API (1 единица квоты)
  async resolveChannelViaApi(ref) {
    const attempts = [];
    if (ref.startsWith('UC')) {
      attempts.push({ id: ref });
    } else {
      attempts.push({ forHandle: ref.startsWith('@') ? ref : `@${ref}` });
      attempts.push({ forUsername: ref.replace(/^@/, '') });
    }
    for (const params of attempts) {
      try {
        const data = await this.apiGet('channels', {
          part: 'snippet,contentDetails',
          ...params,
        });
        const ch = data.items && data.items[0];
        if (ch) {
          return {
            channelId: ch.id,
            title: ch.snippet.title,
            uploads: ch.contentDetails.relatedPlaylists.uploads,
          };
        }
      } catch {
        /* пробуем следующий вариант */
      }
    }
    return null;
  }

  // Резервный резолв канала без ключа: на странице канала есть "channelId":"UC..."
  async resolveChannelViaScrape(ref) {
    const handle = ref.startsWith('@') ? ref : `@${ref}`;
    try {
      const { html } = await this.fetchPage(`https://www.youtube.com/${handle}`);
      const id = (html.match(/"channelId":"(UC[0-9A-Za-z_-]{22})"/) || [])[1];
      if (!id) return null;
      return { channelId: id, title: null, uploads: id.replace(/^UC/, 'UU') };
    } catch {
      return null;
    }
  }

  // Определяем channelId + uploads-плейлист, кешируем
  async ensureChannel() {
    if (this.channelId) return { channelId: this.channelId, uploads: this.uploadsPlaylist };
    if (!this.channelRef) return null;

    let info = null;
    if (this.apiKey || this.accessToken) info = await this.resolveChannelViaApi(this.channelRef);
    if (!info) info = await this.resolveChannelViaScrape(this.channelRef);
    if (!info) return null;

    this.channelId = info.channelId;
    this.uploadsPlaylist = info.uploads;
    this.emit('log', `Канал определён: ${info.title || info.channelId}`);
    return info;
  }

  // ============================================================
  // Поиск актуального прямого эфира
  // ============================================================

  // По ID видео получаем activeLiveChatId (1 единица квоты)
  async chatIdForVideo(videoId) {
    const data = await this.apiGet('videos', {
      part: 'snippet,liveStreamingDetails,status',
      id: videoId,
    });
    const v = data.items && data.items[0];
    if (!v) return null;
    const chatId = v.liveStreamingDetails && v.liveStreamingDetails.activeLiveChatId;
    if (!chatId) return null;
    return { videoId, liveChatId: chatId, title: v.snippet.title };
  }

  // Путь A: самый дешёвый — свежие видео из uploads-плейлиста
  async findByUploads() {
    if (!this.uploadsPlaylist) return null;
    const items = await this.apiGet('playlistItems', {
      part: 'contentDetails',
      playlistId: this.uploadsPlaylist,
      maxResults: 5,
    });
    const ids = (items.items || [])
      .map((i) => i.contentDetails && i.contentDetails.videoId)
      .filter(Boolean);
    if (!ids.length) return null;

    // Одним запросом проверяем все 5 видео на наличие активного чата
    const data = await this.apiGet('videos', {
      part: 'snippet,liveStreamingDetails',
      id: ids.join(','),
    });
    for (const v of data.items || []) {
      const chatId = v.liveStreamingDetails && v.liveStreamingDetails.activeLiveChatId;
      if (chatId) return { videoId: v.id, liveChatId: chatId, title: v.snippet.title };
    }
    return null;
  }

  // Путь B: официальный поиск активных трансляций канала
  async findBySearch() {
    const data = await this.apiGet('search', {
      part: 'snippet',
      type: 'video',
      eventType: 'live',
      channelId: this.channelId,
      maxResults: 5,
    });
    for (const item of data.items || []) {
      const vid = item.id && item.id.videoId;
      if (!vid) continue;
      const found = await this.chatIdForVideo(vid);
      if (found) return found;
    }
    return null;
  }

  // Путь C: скрейпинг страницы /live — YouTube редиректит на актуальный эфир.
  // Работает без API-ключа и отдаёт только videoId.
  async findByScrape() {
    if (!this.channelRef) return null;
    const handle = this.channelRef.startsWith('@') ? this.channelRef : `@${this.channelRef}`;
    try {
      const { html, finalUrl } = await this.fetchPage(`https://www.youtube.com/${handle}/live`);

      // 1) редирект сразу на watch?v=...
      let id = (finalUrl.match(/[?&]v=([0-9A-Za-z_-]{11})/) || [])[1];

      // 2) каноническая ссылка на видео внутри страницы
      if (!id) {
        id = (html.match(/"canonicalBaseUrl":"\/watch\?v=([0-9A-Za-z_-]{11})"/) || [])[1];
      }

      // 3) видео, помеченное как прямой эфир, в JSON страницы
      if (!id) {
        const blocks = html.match(/\{[^{}]*"videoId":"[0-9A-Za-z_-]{11}"[^{}]*\}/g) || [];
        for (const b of blocks) {
          if (/"isLive":true|"isLiveContent":true/.test(b)) {
            id = (b.match(/"videoId":"([0-9A-Za-z_-]{11})"/) || [])[1];
            if (id) break;
          }
        }
      }

      if (!id) return null;
      return { videoId: id, liveChatId: null, title: null, scraped: true };
    } catch {
      return null;
    }
  }

  // Полная цепочка: находит актуальный эфир канала
  async findLiveStream() {
    await this.ensureChannel();
    if (!this.channelId && !this.channelRef) return null;

    const quotaOk = Date.now() > this.quotaBlockedUntil;

    // A и B требуют ключ/токен — пробуем первыми, они дают chatId сразу
    if (quotaOk && (this.apiKey || this.accessToken)) {
      try {
        const viaUploads = await this.findByUploads();
        if (viaUploads) return viaUploads;
      } catch (err) {
        this.noteApiError(err, 'uploads');
      }
      try {
        const viaSearch = await this.findBySearch();
        if (viaSearch) return viaSearch;
      } catch (err) {
        this.noteApiError(err, 'search');
      }
    }

    // C: резервный путь без ключа
    const scraped = await this.findByScrape();
    if (scraped) {
      // Если ID получен скрейпингом, а ключ есть — добираем chatId официально
      if (this.apiKey || this.accessToken) {
        try {
          const resolved = await this.chatIdForVideo(scraped.videoId);
          if (resolved) return resolved;
        } catch (err) {
          this.noteApiError(err, 'videos');
        }
      }
      return scraped;
    }

    // Прямой ID от юзера всё ещё может быть жив — проверяем последним
    if (this.videoId && (this.apiKey || this.accessToken)) {
      try {
        const same = await this.chatIdForVideo(this.videoId);
        if (same) return same;
      } catch {
        /* не живой — значит точно надо ждать новый эфир */
      }
    }
    return null;
  }

  // Логируем ошибки API и бережём квоту при quotaExceeded
  noteApiError(err, where) {
    if (
      err &&
      (err.status === 403 || err.status === 429) &&
      /quota|rate/i.test(String(err.message))
    ) {
      this.quotaBlockedUntil = Date.now() + QUOTA_BACKOFF;
      this.emit('log', `Квота YouTube API исчерпана (${where}), пауза 5 мин`);
      return;
    }
    if (err) this.emit('log', `YouTube API (${where}): ${err.message}`);
  }

  // ============================================================
  // Жизненный цикл
  // ============================================================

  // Вход: channel — стабильный канал; videoId — опциональный «прикол» вручную
  async start({ channel, videoId, apiKey, accessToken, refreshAccessToken, autoReconnect } = {}) {
    this.running = true;
    this.apiKey = (apiKey || '').trim() || null;
    this.accessToken = (accessToken || '').trim() || null;
    this.refreshAccessToken = typeof refreshAccessToken === 'function' ? refreshAccessToken : null;
    this.autoReconnect = autoReconnect !== false;

    const ref = YouTubeChat.normalizeChannelRef(channel);
    // Смена канала — сбрасываем кеш резолва
    if (ref && ref !== this.channelRef) {
      this.channelId = null;
      this.uploadsPlaylist = null;
    }
    if (ref) this.channelRef = ref;
    this.videoId = (videoId || '').trim() || null;

    // 1) Если юзер явно дал ID — пробуем подключиться по нему
    if (this.videoId) {
      try {
        const found = await this.chatIdForVideo(this.videoId);
        if (found) return this.attachTo(found, 'по указанному ID');
      } catch (err) {
        this.emit('status', { connected: false, text: `YouTube: ${err.message}` });
      }
    }

    // 2) Иначе сразу идём искать актуальный эфир
    const found = await this.findLiveStream();
    if (found) return this.attachTo(found, 'авто-поиск');

    // 3) Эфира нет — не падаем, а уходим в режим ожидания с автореконнектом
    if (this.autoReconnect) {
      this.beginReconnect('прямой эфир не найден');
      return { connected: false, waiting: true };
    }
    throw new Error('Активная трансляция канала не найдена');
  }

  // Привязка к найденному эфиру и запуск чтения
  attachTo(stream, how) {
    const changed = this.videoId !== stream.videoId;
    this.videoId = stream.videoId;
    this.liveChatId = stream.liveChatId || this.liveChatId;
    this.videoTitle = stream.title || this.videoTitle;
    this.pageToken = undefined;
    this.reconnectDelay = RECONNECT_DELAY;
    this.lastMessageAt = Date.now();

    // Сообщаем наружу — main.js обновит конфиг, счётчики и UI
    if (changed || stream.title) {
      this.emit('stream:changed', {
        videoId: this.videoId,
        liveChatId: this.liveChatId,
        title: this.videoTitle,
        reason: how,
      });
    }

    if (!this.liveChatId) {
      // ID есть, а чата нет (скрейпинг без ключа) — watchdog добьёт поиск
      this.beginReconnect('не удалось получить ID чата');
      return { connected: false, videoId: this.videoId };
    }

    this.emit('status', { connected: true, text: `YouTube: эфир ${this.videoId} (${how})` });

    if (!this.polling) {
      this.polling = true;
      this.reconnecting = false;
      this.pollLoop();
    }
    this.startWatchdog();
    return { connected: true, videoId: this.videoId, liveChatId: this.liveChatId };
  }

  // ============================================================
  // Основной цикл чтения чата
  // ============================================================
  async pollLoop() {
    while (this.polling && this.running) {
      if (!this.liveChatId) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      let waitMs = 5000;
      try {
        const data = await this.apiGet('liveChatMessages', {
          liveChatId: this.liveChatId,
          part: 'snippet,authorDetails',
          pageToken: this.pageToken,
          maxResults: 200,
        });
        this.pageToken = data.nextPageToken;
        if (data.pollingIntervalMillis) waitMs = data.pollingIntervalMillis;

        for (const item of data.items || []) {
          if (item.snippet.type !== 'textMessageEvent') continue;
          this.lastMessageAt = Date.now();
          this.emit('message', {
            platform: 'youtube',
            user: item.authorDetails.displayName,
            text: item.snippet.displayMessage,
            avatar: item.authorDetails.profileImageUrl || null,
            color: null,
            isMod: !!item.authorDetails.isChatModerator,
            isSubscriber: !!item.authorDetails.isChatSponsor,
          });
        }
      } catch (err) {
        // Стрим завершился или чат закрыт -> ищем новый эфир
        if (this.isDeadChatError(err)) {
          this.emit('log', 'Чат YouTube закрыт — трансляция завершилась');
          if (!this.beginReconnect('эфир завершён')) return;
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        // Протухший pageToken лечится перезапуском токена
        if (err.status === 400 || /pageToken|tokenExpired/i.test(String(err.message))) {
          this.pageToken = undefined;
          waitMs = 2000;
          continue;
        }
        this.noteApiError(err, 'liveChatMessages');
        waitMs = this.quotaBlockedUntil > Date.now() ? QUOTA_BACKOFF / 5 : 10000;
      }
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  isDeadChatError(err) {
    if (!err) return false;
    if (DEAD_CHAT_STATUSES.has(err.status)) return true;
    if (DEAD_CHAT_REASONS.has(err.reason)) return true;
    return /gone|notStarted|ended|closed/i.test(String(err.message));
  }

  // ============================================================
  // Watchdog + автореконнект
  // ============================================================
  startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.checkAlive(), WATCHDOG_INTERVAL);
  }

  stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  // Периодическая проверка: тот ли ещё эфир и жив ли он
  async checkAlive() {
    if (!this.running || this.reconnecting || !this.autoReconnect) return;

    const stalled = Date.now() - this.lastMessageAt > STALL_TIMEOUT;

    if (!stalled) {
      // Дёшево: узнаём activeLiveChatId текущего видео
      if (!this.videoId || (!this.apiKey && !this.accessToken)) return;
      try {
        const live = await this.chatIdForVideo(this.videoId);
        if (!live) return this.beginReconnect('эфир больше не активен');
        if (live.liveChatId !== this.liveChatId) {
          return this.attachTo(live, 'watchdog: чат сменился');
        }
      } catch (err) {
        if (this.isDeadChatError(err)) this.beginReconnect('эфир недоступен');
      }
      return;
    }

    // Чат молчит подозрительно долго — проверяем, не появился ли новый эфир
    try {
      const found = await this.findLiveStream();
      if (found && found.videoId !== this.videoId) {
        this.emit('log', 'Обнаружен новый эфир — переключаемся');
        this.attachTo(found, 'watchdog: новый эфир');
      } else {
        this.pageToken = undefined; // на всякий случай освежаем токен
      }
    } catch {
      /* тихо: следующая проверка через интервал */
    }
  }

  // Запускает цикл попыток найти актуальный эфир
  beginReconnect(reason) {
    if (!this.running || this.reconnecting || !this.autoReconnect) return false;
    this.reconnecting = true;
    this.polling = false;
    this.liveChatId = null;
    this.pageToken = undefined;

    this.emit('status', {
      connected: false,
      text: `YouTube: ${reason} — ищу новый эфир`,
    });
    this.reconnectLoop();
    return true;
  }

  async reconnectLoop() {
    let attempt = 0;
    while (this.running && this.reconnecting) {
      attempt++;
      try {
        const found = await this.findLiveStream();
        if (found && found.liveChatId) {
          this.reconnecting = false;
          this.emit('log', `Найден новый эфир ${found.videoId} (попытка ${attempt})`);
          this.attachTo(found, 'автореконнект');
          return;
        }
      } catch (err) {
        this.noteApiError(err, 'reconnect');
      }

      // Экспоненциальная задержка: 15с, 30с, 60с, 120с ...
      const wait = Math.min(
        this.reconnectDelay * Math.pow(2, Math.min(attempt - 1, 3)),
        RECONNECT_MAX_DELAY
      );
      this.emit('status', {
        connected: false,
        text: `Эфира нет. Проверка через ${Math.round(wait / 1000)} с (попытка ${attempt})`,
      });
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  async stop() {
    this.running = false;
    this.polling = false;
    this.reconnecting = false;
    this.stopWatchdog();
    this.liveChatId = null;
    this.pageToken = undefined;
    this.emit('status', { connected: false, text: 'Чат YouTube отключён' });
  }
}

module.exports = YouTubeChat;
