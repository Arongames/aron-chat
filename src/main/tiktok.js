// ============================================================
// TikTok LIVE: подключение к чату трансляции через
// tiktok-live-connector (WebcastPushConnection).
//
// Библиотека v2.x поставляется только как ES-модуль
// ("type": "module"), поэтому в CommonJS-коде Electron её можно
// получить лишь динамическим import() — require() не работает.
//
// Модуль отдаёт наружу плоские события:
//   'message'  → { user, text }                  — сообщения чата
//   'follow'   → { user }                        — подписки
//   'gift'     → { user, giftName, count }       — подарки (без комбо-спама)
//   'like'     → { user, totalLikes }            — лайки (на будущее)
//   'member'   → { user }                        — вход в эфир (на будущее)
//   'status'   → { connected, text }             — состояние соединения
// ============================================================

const { EventEmitter } = require('events');

let connectionClass = null;
let loadError = null;
// Защита от повторов: при подключении TikTok присылает историю чата,
// и часть сообщений приходит дважды.
const seenChatIds = new Set();

// Имя автора в обеих сборках коннектора: legacy — плоские поля,
// основная — вложенный объект user.
function tiktokUser(data) {
  const user = (data && data.user) || {};
  return user.displayId
    || user.uniqueId
    || user.shortId
    || user.nickname
    || user.id
    || (data && (data.uniqueId || data.nickname))
    || 'гость';
}

// Аватар из protobuf-объекта TikTok
function tiktokAvatar(data) {
  const user = (data && data.user) || {};
  const pic = user.avatarThumb || user.avatarMedium || user.avatarLarger;
  const url = (pic && pic.urlList && pic.urlList[0])
    || user.profilePictureUrl
    || (data && data.profilePictureUrl)
    || (data && data.userInfo && data.userInfo.profilePictureUrl)
    || null;
  return url || null;
}

async function loadConnector() {
  if (connectionClass) return connectionClass;
  if (loadError) throw loadError;

  let mod;
  // Основная ESM-сборка: в ней разбор сообщений уже исправлен.
  // Legacy оставляем только как запасной вариант для старых окружений.
  try {
    mod = await import('tiktok-live-connector');
  } catch {
    try {
      mod = await import('tiktok-live-connector/legacy');
    } catch (err) {
      loadError = new Error(
        `не удалось загрузить tiktok-live-connector: ${err.message}. `
        + 'Установите: npm i tiktok-live-connector'
      );
      throw loadError;
    }
  }

  const Klass = mod.WebcastPushConnection || mod.TikTokLiveConnection;
  if (!Klass) {
    loadError = new Error('в модуле нет WebcastPushConnection');
    throw loadError;
  }
  connectionClass = Klass;
  return Klass;
}

function describeError(err) {
  if (!err) return 'неизвестная ошибка';
  let raw;
  if (typeof err === 'string') raw = err;
  else if (err.message) raw = err.message;
  else {
    try {
      const json = JSON.stringify(err);
      raw = json && json !== '{}' ? json : String(err);
    } catch {
      raw = String(err);
    }
  }

  // Понятные формулировки для типовых ответов TikTok
  if (/Failed to retrieve Room ID/i.test(raw)) {
    return 'трансляция не найдена. Проверьте никнейм (без @) и что эфир сейчас идёт.';
  }
  if (/User is not live|not live/i.test(raw)) {
    return 'пользователь сейчас не в эфире.';
  }
  if (/reading ['"]map['"]/i.test(raw)) {
    return 'TikTok вернул неожиданные данные. Попробуйте ещё раз или обновите приложение.';
  }
  if (/Error while connecting/i.test(raw)) {
    return 'не удалось подключиться к чату TikTok. Попробуйте ещё раз.';
  }
  return raw;
}

class TikTokLive extends EventEmitter {
  constructor() {
    super();
    this.connection = null;
    this.username = null;
    this.connected = false;
    // Сколько лайков поставил каждый зритель за текущий эфир
    this.likeCounts = new Map();
  }

  isConnected() {
    return this.connected && !!this.connection;
  }

  // Приблизительное число зрителей. Точного «онлайн» Webcast не отдаёт:
  // у TikTok в данных комнаты есть счётчики вроде totalUser (сколько
  // уникальных зрителей зашло за эфир). Берём первое разумное число.
  async fetchViewerCount() {
    if (!this.connection || typeof this.connection.fetchRoomInfo !== 'function') return null;
    try {
      const info = await this.connection.fetchRoomInfo();
      const data = info && (info.data || info);
      const candidates = [
        data && data.stats && data.stats.totalUser,
        data && data.stats && data.stats.userCount,
        data && data.user_count,
        data && data.viewerCount,
        info && info.viewerCount,
      ];
      for (const value of candidates) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return 0;
    } catch {
      return null;
    }
  }

  async connect(username) {
    const WebcastPushConnection = await loadConnector();

    const name = String(username || '').replace(/^@/, '').trim();
    if (!name) throw new Error('не указан никнейм трансляции TikTok');

    if (this.isConnected() && this.username === name) return;
    if (this.connection) this.disconnect();

    this.username = name;
    this.likeCounts.clear();
    this.emit('status', { connected: false, text: `Подключение к TikTok @${name}...` });

    const connection = new WebcastPushConnection(name, {
      processInitialData: true,
      // Стример может быть офлайн — не считаем это фатальной ошибкой
      fetchRoomInfoOnConnect: false,
    });
    this.connection = connection;

    // ---------- Сообщения чата ----------
    connection.on('chat', (data) => {
      // Основная ESM-сборка отдаёт объекты protobuf: текст в content,
      // автор — во вложенном user. Legacy-поля оставляем для совместимости.
      const text = String(data.content ?? data.comment ?? '').trim();
      if (!text) return;

      const msgId = data.common && data.common.msgId;
      if (msgId) {
        if (seenChatIds.has(msgId)) return;
        seenChatIds.add(msgId);
        if (seenChatIds.size > 1000) {
          const first = seenChatIds.values().next().value;
          seenChatIds.delete(first);
        }
      }

      this.emit('message', {
        user: tiktokUser(data),
        text,
        avatar: tiktokAvatar(data),
      });
    });

    // ---------- Подписки ----------
    connection.on('follow', (data) => {
      const user = tiktokUser(data);
      console.log(`[TikTok] ${user} подписался`);
      this.emit('follow', { user });
    });

    // ---------- Подарки ----------
    // Комбо-монетки приходят сериями: повторяющиеся события с
    // repeatEnd === false игнорируем, озвучиваем только итог серии.
    connection.on('gift', (data) => {
      const user = tiktokUser(data);
      const giftName = (data.gift && data.gift.name) || data.giftName || 'подарок';
      const count = data.repeatCount || data.comboCount || data.totalCount || data.count || 1;

      if (data.repeatEnd === false) return;

      console.log(`[TikTok] ${user} подарил ${giftName} × ${count}`);
      this.emit('gift', { user, giftName, count });
    });

    // ---------- Лайки: считаем накопительно по каждому зрителю ----------
    connection.on('like', (data) => {
      const user = tiktokUser(data);
      const batch = Math.max(1, Number(data.count) || 1);
      const key = user.toLowerCase();
      const totalLikes = (this.likeCounts.get(key) || 0) + batch;
      this.likeCounts.set(key, totalLikes);
      console.log(`[TikTok] ${user} лайкнул +${batch} (всего: ${totalLikes})`);
      this.emit('like', { user, count: batch, totalLikes });
    });

    connection.on('member', (data) => {
      const user = tiktokUser(data);
      console.log(`[TikTok] ${user} зашёл в эфир`);
      this.emit('member', { user });
    });

    // ---------- Состояние ----------
    connection.on('connected', () => {
      this.connected = true;
      this.emit('status', { connected: true, text: `TikTok @${this.username} подключён` });
    });

    connection.on('disconnected', () => {
      this.connected = false;
      this.emit('status', { connected: false, text: 'TikTok отключён' });
    });

    connection.on('streamEnd', () => {
      this.connected = false;
      this.emit('status', { connected: false, text: 'Трансляция TikTok завершена' });
    });

    connection.on('error', (err) => {
      const text = describeError(err);
      console.error('[TikTok]', text);
      this.emit('status', { connected: false, text: `Ошибка TikTok: ${text}` });
    });

    try {
      await connection.connect();
    } catch (err) {
      const text = describeError(err);
      this.cleanup();
      throw new Error(text);
    }
  }

  cleanup() {
    if (this.connection) {
      try { this.connection.removeAllListeners(); } catch { /* уже закрыт */ }
      this.connection = null;
    }
    this.connected = false;
  }

  disconnect() {
    const connection = this.connection;
    this.cleanup();
    if (connection && typeof connection.disconnect === 'function') {
      Promise.resolve(connection.disconnect()).catch(() => {});
    }
    this.emit('status', { connected: false, text: 'TikTok LIVE отключён' });
  }
}

module.exports = TikTokLive;

// Хук для тестов: подмена класса подключения (динамический import
// не мокается через Module._load).
module.exports._setConnectorClass = (Klass) => {
  connectionClass = Klass;
  loadError = null;
};
