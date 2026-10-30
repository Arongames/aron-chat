// ============================================================
// Оверлеи: один скрипт на два виджета.
//   /overlay/chat    — лента сообщений и событий (body[data-widget=chat])
//   /overlay/viewers — только счётчики зрителей (data-widget=viewers)
//
// Принимает от главного процесса:
//   hello/settings — {chat:{...}, viewers:{...}};
//   chat           — сообщение чата;
//   event          — подписка / подарок / вход;
//   viewers        — счётчики зрителей.
// ============================================================

const MODE = document.body.dataset.widget === 'viewers' ? 'viewers' : 'chat';

const feedEl = document.getElementById('feed');
const wrapEl = document.getElementById('wrap');
const viewersEl = document.getElementById('viewers');
const statusEl = document.getElementById('status');

const PALETTE = ['#3a2f4d', '#2a3f44', '#332c46', '#2b3a34', '#3d2b33', '#3a3527', '#2a3a44', '#3a2b2b'];

const chatDefaults = {
  position: 'bottom-left',
  scale: 100,
  maxMessages: 12,
  ttl: 60,
  showEvents: true,
  fontSize: 13,
  iconSize: 22,
  showIcons: true,
};

const viewersDefaults = {
  enabled: true,
  position: 'top-left',
  scale: 100,
};

let chat = { ...chatDefaults };
let viewersCfg = { ...viewersDefaults };
let socket = null;
let reconnectDelay = 1000;
let lastViewers = {};
let emotes = {};

// ---------- Настройки ----------
function applySettings(next) {
  if (!next) return;
  if (next.chat) chat = { ...chatDefaults, ...next.chat };
  if (next.viewers) viewersCfg = { ...viewersDefaults, ...next.viewers };

  if (MODE === 'viewers') {
    wrapEl.className = `wrap pos-${viewersCfg.position}`;
    document.documentElement.style.setProperty('--scale', String(viewersCfg.scale / 100));
    viewersEl.hidden = !viewersCfg.enabled;
  } else {
    wrapEl.className = `wrap pos-${chat.position}`;
    document.documentElement.style.setProperty('--scale', String(chat.scale / 100));
    document.documentElement.style.setProperty('--chat-font', `${chat.fontSize || 13}px`);
    document.documentElement.style.setProperty('--plat-icon', `${chat.iconSize || 22}px`);
    document.body.classList.toggle('hide-plat-icons', chat.showIcons === false);
    trimFeed();
  }
  renderViewers(lastViewers);
}

function trimFeed() {
  while (feedEl.children.length > chat.maxMessages) {
    feedEl.removeChild(feedEl.firstChild);
  }
}

// ---------- Мелочи ----------
function initial(user) {
  const chars = Array.from(String(user || '?').trim());
  return (chars[0] || '?').toUpperCase();
}

function avatarColor(user) {
  const text = String(user || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value);
}

function makeRow(cls) {
  const row = document.createElement('div');
  row.className = cls;

  const av = document.createElement('div');
  av.className = 'av';

  const body = document.createElement('div');
  body.className = 'body';

  const line1 = document.createElement('div');
  line1.className = 'line1';
  const nick = document.createElement('span');
  nick.className = 'nick';
  line1.appendChild(nick);

  const text = document.createElement('div');
  text.className = 'text';

  body.append(line1, text);
  row.append(av, body);
  return { row, av, nick, text };
}

// Аватар: картинка или первая буква
function paintAvatar(av, user, url) {
  av.querySelectorAll('img').forEach((img) => img.remove());
  if (url) {
    const img = document.createElement('img');
    img.className = 'av-img';
    img.src = url;
    img.alt = '';
    img.addEventListener('error', () => { img.remove(); av.textContent = initial(user); });
    av.appendChild(img);
    av.classList.add('has-img');
    return;
  }
  av.classList.remove('has-img');
  av.textContent = initial(user);
}

// Текст с эмоутами 7TV/BTTV/FFZ
function renderText(el, text) {
  const source = String(text || '');
  if (!Object.keys(emotes).length) {
    el.textContent = source;
    return;
  }

  el.textContent = '';
  for (const token of source.split(/(\s+)/)) {
    if (!token) continue;
    if (/^\s+$/.test(token)) {
      el.appendChild(document.createTextNode(token));
      continue;
    }
    const url = emotes[token];
    if (url) {
      const img = document.createElement('img');
      img.className = 'emote';
      img.src = url;
      img.alt = token;
      el.appendChild(img);
    } else {
      el.appendChild(document.createTextNode(token));
    }
  }
}

function scheduleRemoval(row) {
  if (!chat.ttl) return;
  setTimeout(() => {
    row.classList.add('fading');
    setTimeout(() => row.remove(), 450);
  }, chat.ttl * 1000);
}

function pushRow(row) {
  if (MODE !== 'chat') return;
  feedEl.appendChild(row);
  trimFeed();
  scheduleRemoval(row);
}

const PLATFORM_LOGOS = {
  tiktok: '/tiktok-logo.svg',
  twitch: '/twitch-logo.svg',
  youtube: '/youtube-logo.svg',
};

// ---------- Сообщения чата ----------
function renderChat(msg) {
  const platform = msg.platform || 'tiktok';
  const { row, av, nick, text } = makeRow(
    `row ${platform === 'twitch' ? 'tw' : platform === 'youtube' ? 'yt' : 'tt'}`
  );

  av.textContent = '';
  paintAvatar(av, msg.user, msg.avatar || null);
  nick.textContent = msg.user;
  if (isHexColor(msg.color)) nick.style.color = msg.color;
  renderText(text, msg.text);
  row.dataset.user = msg.user || '';
  row.dataset.login = msg.login || msg.user || '';
  row.dataset.platform = platform;

  if (chat.showIcons !== false) {
    const icon = document.createElement('img');
    icon.className = 'plat-big';
    icon.src = PLATFORM_LOGOS[platform] || PLATFORM_LOGOS.tiktok;
    icon.alt = '';
    row.appendChild(icon);
  }

  pushRow(row);
}

// ---------- События ----------
const EVENT_LABELS = {
  follow: { badge: 'follow', verb: 'подписался на канал', cls: 'follow' },
  sub: { badge: 'sub', verb: 'оформил подписку', cls: 'sub' },
  gift: { badge: 'gift', verb: 'подарил подарок', cls: 'gift' },
  member: { badge: 'in', verb: 'зашёл в эфир', cls: 'follow' },
  like: { badge: 'like', verb: 'лайкнул', cls: 'like' },
};

function renderEvent(evt) {
  if (!chat.showEvents) return;
  // Входы в эфир слишком частые — в оверлее не показываем
  if (evt.type === 'member') return;
  const meta = EVENT_LABELS[evt.type];
  if (!meta) return;

  // Лайки TikTok: одна строка на зрителя, счётчик обновляется
  if (evt.type === 'like') {
    const key = String(evt.user || '').toLowerCase();
    const existing = [...feedEl.querySelectorAll('.row.like')]
      .find((r) => String(r.dataset.user).toLowerCase() === key);
    if (existing) {
      const txt = existing.querySelector('.text');
      if (txt) txt.textContent = `${meta.verb} ×${evt.count || 1} · всего ${Number(evt.totalLikes || 0).toLocaleString('ru-RU')}`;
      const b = existing.querySelector('.badge');
      if (b) b.textContent = `like ${Number(evt.totalLikes || 0).toLocaleString('ru-RU')}`;
      return;
    }
  }

  const platform = evt.platform || 'tiktok';
  const { row, av, nick, text } = makeRow(
    `row ev ${meta.cls} ${evt.type} ${platform === 'twitch' ? 'tw' : platform === 'youtube' ? 'yt' : 'tt'}`
  );

  av.textContent = '';
  paintAvatar(av, evt.user, evt.avatar || null);
  nick.textContent = evt.user;

  if (evt.type === 'gift') {
    text.textContent = `${meta.verb} «${evt.giftName || 'подарок'}» ×${evt.count || 1}`;
  } else if (evt.type === 'like') {
    text.textContent = `${meta.verb} ×${evt.count || 1} · всего ${Number(evt.totalLikes || 0).toLocaleString('ru-RU')}`;
  } else {
    text.textContent = meta.verb;
  }
  row.dataset.user = evt.user || '';

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = evt.type === 'gift'
    ? `gift ×${evt.count || 1}`
    : (evt.type === 'like' ? `like ${Number(evt.totalLikes || 0).toLocaleString('ru-RU')}` : meta.badge);
  row.appendChild(badge);

  pushRow(row);
}

// ---------- Зрители ----------
function renderViewers(viewers) {
  lastViewers = viewers || {};
  if (MODE !== 'viewers') return;

  let visible = 0;
  for (const platform of ['youtube', 'twitch', 'tiktok']) {
    const el = viewersEl.querySelector(`[data-v="${platform}"]`);
    if (!el) continue;
    const value = lastViewers[platform];
    // null — площадка не подключена, 0 — эфира нет (Twitch отдаёт 0 офлайн)
    const hasStream = Number.isFinite(value) && Number(value) > 0;
    // Если эфира на площадке нет — строку не показываем
    const item = el.closest('.v-item');
    if (item) item.hidden = !hasStream;
    if (hasStream) {
      el.textContent = Number(value).toLocaleString('ru-RU');
      visible += 1;
    } else {
      el.textContent = '—';
    }
  }

  // Ни одной активной площадки — скрываем весь блок счётчиков
  viewersEl.hidden = visible === 0;
  const bar = document.getElementById('bar');
  if (bar) bar.hidden = visible === 0;
}

// ---------- Соединение ----------
function showStatus(visible) {
  statusEl.classList.toggle('visible', visible);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = location.host || '127.0.0.1:3000';
  socket = new WebSocket(`${proto}://${host}`);

  socket.onopen = () => {
    reconnectDelay = 1000;
    showStatus(false);
  };

  socket.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.type === 'hello' || data.type === 'settings') {
      applySettings(data.settings);
      if (data.viewers) renderViewers(data.viewers);
      if (data.emotes) emotes = data.emotes;
      if (data.type === 'hello') showStatus(false);
      return;
    }
    if (data.type === 'emotes') {
      emotes = data.emotes || {};
      return;
    }
    if (data.type === 'avatar') {
      document.querySelectorAll(`.row[data-platform="${data.platform}"]`).forEach((row) => {
        if (String(row.dataset.login).toLowerCase() !== String(data.login || '').toLowerCase()) return;
        const av = row.querySelector('.av');
        if (av) paintAvatar(av, row.dataset.user, data.avatar);
      });
      return;
    }
    if (data.type === 'chat') renderChat(data.message);
    if (data.type === 'event') renderEvent(data.event);
    if (data.type === 'viewers') renderViewers(data.viewers);
    if (data.type === 'hide-user') {
      const lower = String(data.user || '').toLowerCase();
      feedEl.querySelectorAll('.row').forEach((row) => {
        if (String(row.dataset.user || '').toLowerCase() === lower) row.remove();
      });
    }
  };

  socket.onclose = () => {
    showStatus(true);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };

  socket.onerror = () => {
    try { socket.close(); } catch { /* уже закрыт */ }
  };
}

applySettings({ chat, viewers: viewersCfg });
connect();
