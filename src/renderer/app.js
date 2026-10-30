// ============================================================
// Логика окна управления.
//
// nodeIntegration включён, contextIsolation выключен — работаем с
// ipcRenderer напрямую. Настройки живут в главном процессе:
//   config:set   — черновик правки (файл не трогается);
//   config:save  — запись config.json;
//   config:reset — откат к последнему сохранённому.
// Поэтому «Сохранить» внизу — единственная кнопка, которая пишет
// на диск; при закрытии приложения черновик сохраняется сам.
// ============================================================

const { ipcRenderer } = require('electron');

// Справочники Speechify живут рядом с модулем озвучки — берём оттуда,
// чтобы интерфейс и запросы никогда не расходились по значениям.
const { RU_VOICES, PIPER_VOICES, MODELS, LANGUAGES } = require('../main/tts');

const LANGUAGE_LABELS = {
  'ru-RU': 'Русский (ru-RU)',
  'en-US': 'Английский (en-US)',
};

const PAGE_TITLES = {
  chat: 'Чат трансляции',
  events: 'События',
  widgets: 'Виджеты',
  settings: 'Настройки',
  about: 'О программе',
};

const PLATFORM_LOGOS = {
  tiktok: './tiktok-logo.svg',
  twitch: './twitch-logo.svg',
  youtube: './youtube-logo.svg',
};

const state = {
  config: null,
  dirty: false,
  overlay: null,
  viewers: { tiktok: null, twitch: null, youtube: null },
  connected: { tiktok: false, twitch: false, youtube: false },
  chatCount: 0,
  eventsVisible: true,
  autoScroll: true,
  savedAt: null,
  emotes: {},
  oauth: null,
};

const $ = (id) => document.getElementById(id);

// ============================================================
// Страницы
// ============================================================

let currentPage = 'chat';
let settingsPanel = 'set-chat';

function updateLiveBadge() {
  const anyConnected = Object.values(state.connected).some(Boolean);
  $('liveBadge').classList.toggle('on', currentPage === 'chat' && anyConnected);
}

// Настройки — отдельные разделы-вкладки, без общей прокрутки
const SETTINGS_CARDS = [
  'set-chat',
  'set-platforms',
  'set-tts',
  'set-filters',
  'set-viewers',
  'set-access',
  'set-commands',
  'set-data',
];

function showSettingsPanel(id) {
  if (!SETTINGS_CARDS.includes(id)) id = 'set-chat';
  const search = $('settingsSearch');
  if (search) search.value = '';
  settingsPanel = id;
  SETTINGS_CARDS.forEach((cardId) => {
    const card = $(cardId);
    if (card) card.style.display = cardId === id ? '' : 'none';
  });
  document.querySelectorAll('.setnav button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.scroll === id);
  });
}

function showPage(name) {
  currentPage = name;
  document.querySelectorAll('.page').forEach((page) => {
    page.classList.toggle('active', page.id === `page-${name}`);
  });
  document.querySelectorAll('.rail-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.page === name);
  });
  $('pageTitle').textContent = PAGE_TITLES[name] || '';
  if (name === 'settings') showSettingsPanel(settingsPanel);
  updateLiveBadge();
}

document.querySelectorAll('.rail-item').forEach((item) => {
  item.addEventListener('click', () => showPage(item.dataset.page));
});

document.querySelectorAll('.setnav button').forEach((btn) => {
  btn.addEventListener('click', () => showSettingsPanel(btn.dataset.scroll));
});

// Поиск по настройкам: показывает все разделы, где встречается запрос
$('settingsSearch').addEventListener('input', () => {
  const query = $('settingsSearch').value.trim().toLowerCase();
  if (!query) {
    showSettingsPanel(settingsPanel);
    return;
  }
  SETTINGS_CARDS.forEach((id) => {
    const card = $(id);
    if (!card) return;
    card.style.display = card.innerText.toLowerCase().includes(query) ? '' : 'none';
  });
  document.querySelectorAll('.setnav button').forEach((btn) => btn.classList.remove('active'));
});

// ============================================================
// Лента чата
// ============================================================

const PALETTE = ['#3a2f4d', '#2a3f44', '#332c46', '#2b3a34', '#3d2b33', '#3a3527', '#2a3a44', '#3a2b2b'];

function avatarColor(user) {
  const text = String(user || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function initial(user) {
  const chars = Array.from(String(user || '?').trim());
  return (chars[0] || '?').toUpperCase();
}

const PLATFORM_SHORT = { tiktok: 'tt', twitch: 'tw', youtube: 'yt' };

function makeRow(platform, extraClass = '') {
  const p = PLATFORM_SHORT[platform] || 'tt';
  const row = document.createElement('div');
  row.className = `row ${p} ${extraClass}`.trim();
  row.dataset.platform = platform;

  const av = document.createElement('div');
  av.className = 'av';

  const body = document.createElement('div');
  body.className = 'body';
  const line1 = document.createElement('div');
  line1.className = 'line1';
  const nick = document.createElement('span');
  nick.className = 'nick';
  const time = document.createElement('span');
  time.className = 'time';
  line1.append(nick, time);

  const text = document.createElement('div');
  text.className = 'text';
  body.append(line1, text);

  const meta = document.createElement('div');
  meta.className = 'meta';

  // Крупный значок площадки справа
  const plat = document.createElement('img');
  plat.className = 'plat-big';
  plat.src = PLATFORM_LOGOS[platform] || PLATFORM_LOGOS.tiktok;
  plat.alt = '';
  meta.appendChild(plat);

  // Кнопка блокировки появляется при наведении на сообщение
  const block = document.createElement('button');
  block.type = 'button';
  block.className = 'block-user';
  block.title = 'Скрыть пользователя';
  block.textContent = '×';
  meta.appendChild(block);

  row.append(av, body, meta);
  row.dataset.user = '';
  return { row, av, nick, time, text, meta, plat, block };
}

// Заполняем аватар: картинка, если она есть, иначе первая буква ника
function paintAvatar(av, user, avatarUrl) {
  av.querySelectorAll('img.av-img').forEach((img) => img.remove());
  const old = av.querySelector('span.av-letter');
  if (old) old.remove();

  if (avatarUrl) {
    const img = document.createElement('img');
    img.className = 'av-img';
    img.src = avatarUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { img.remove(); paintAvatar(av, user, null); });
    av.insertBefore(img, av.firstChild);
    av.classList.add('has-img');
    return;
  }

  av.classList.remove('has-img');
  const letter = document.createElement('span');
  letter.className = 'av-letter';
  letter.textContent = initial(user);
  av.insertBefore(letter, av.firstChild);
}

// Текст с эмоутами: слова, совпавшие с кодом эмоута, заменяем картинкой
function renderMessageText(el, text) {
  const source = String(text || '');

  if (!state.config || state.config.emotes_enabled === false
    || !Object.keys(state.emotes).length) {
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
    const url = state.emotes[token];
    if (url) {
      const img = document.createElement('img');
      img.className = 'emote';
      img.src = url;
      img.alt = token;
      img.title = token;
      img.loading = 'lazy';
      el.appendChild(img);
    } else {
      el.appendChild(document.createTextNode(token));
    }
  }
}

function trimFeed() {
  const feed = $('chatLog');
  while (feed.children.length > 300) feed.removeChild(feed.firstChild);
}

function trimEvents() {
  const feed = $('eventsLog');
  while (feed.children.length > 300) feed.removeChild(feed.firstChild);
}

function afterAppend() {
  const feed = $('chatLog');
  if (state.autoScroll) feed.scrollTop = feed.scrollHeight;
  $('chatEmpty').hidden = feed.children.length > 0;
}

function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// Свои отправленные сообщения показываем сразу, не дожидаясь ответа площадки.
// Когда сервер пришлёт это же сообщение в чат, дубль отбрасываем.
const pendingEchoes = [];

function addLocalEcho(msg) {
  pendingEchoes.push({
    platform: msg.platform,
    text: String(msg.text || ''),
    until: Date.now() + 15000,
  });
  while (pendingEchoes.length > 30) pendingEchoes.shift();
  addChatMessage(msg, true);
}

function consumeEcho(platform, text) {
  const now = Date.now();
  const value = String(text || '');
  const index = pendingEchoes.findIndex((item) => item.until > now
    && item.platform === platform
    && item.text === value);
  if (index === -1) return false;
  pendingEchoes.splice(index, 1);
  return true;
}

function addChatMessage(msg, local = false) {
  const platform = msg.platform || 'tiktok';
  if (!local && consumeEcho(platform, msg.text)) return;
  const { row, av, nick, time, text, block } = makeRow(platform, 'chat');

  row.dataset.user = msg.user || '';
  row.dataset.login = msg.login || msg.user || '';
  row.dataset.text = msg.text || '';
  av.style.background = avatarColor(msg.user);
  paintAvatar(av, msg.user, msg.avatar || null);
  nick.textContent = msg.user;
  if (/^#[0-9a-f]{3,8}$/i.test(msg.color || '')) nick.style.color = msg.color;
  time.textContent = formatTime(msg.time);
  renderMessageText(text, msg.text);

  // Клик по тексту — копируем сообщение в буфер
  text.title = 'Нажмите, чтобы скопировать';
  text.addEventListener('click', () => {
    const value = `${msg.user}: ${msg.text}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(() => toast('Сообщение скопировано')).catch(() => {});
    }
  });

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    blockUser(msg.platform, msg.user);
  });

  $('chatLog').appendChild(row);
  trimFeed();
  afterAppend();

  state.chatCount += 1;
  $('chatCount').textContent = state.chatCount.toLocaleString('ru-RU');
}

const EVENT_META = {
  follow: { cls: 'follow-ev', badge: 'follow', label: 'подписался на канал' },
  sub: { cls: 'sub-ev', badge: 'sub', label: 'оформил подписку' },
  gift: { cls: 'gift-ev', badge: 'gift', label: 'подарил подарок' },
  member: { cls: 'member-ev', badge: 'in', label: 'зашёл в эфир' },
  like: { cls: 'member-ev', badge: 'like', label: 'лайкнул' },
};

function addEvent(event) {
  if (!state.eventsVisible) return;
  // Входы в эфир приходят на каждого зрителя — ленту ими не засоряем
  if (event.type === 'member') return;
  const meta = EVENT_META[event.type];
  if (!meta) return;

  const userKey = String(event.user || '').toLowerCase();

  // Лайки TikTok: одна строка на зрителя, счётчик обновляется
  if (event.type === 'like') {
    const existing = [...$('eventsLog').querySelectorAll('.row.like')]
      .find((r) => String(r.dataset.user).toLowerCase() === userKey);
    if (existing) {
      existing.querySelector('.time').textContent = formatTime(event.time);
      existing.querySelector('.text').textContent =
        `${meta.label} ×${event.count || 1} · всего ${Number(event.totalLikes || 0).toLocaleString('ru-RU')}`;
      const oldBadge = existing.querySelector('.badge');
      if (oldBadge) oldBadge.textContent = `like ${Number(event.totalLikes || 0).toLocaleString('ru-RU')}`;
      return;
    }
  }

  const platform = event.platform || 'tiktok';
  const { row, av, nick, time, text, meta: metaEl, block } = makeRow(platform, `ev ${meta.cls} ${event.type}`);

  row.dataset.user = event.user || '';
  av.style.background = avatarColor(event.user);
  paintAvatar(av, event.user, event.avatar || null);
  nick.textContent = event.user;
  time.textContent = formatTime(event.time);

  if (event.type === 'gift') {
    text.textContent = `${meta.label} «${event.giftName || 'подарок'}» ×${event.count || 1}`;
  } else if (event.type === 'like') {
    text.textContent =
      `${meta.label} ×${event.count || 1} · всего ${Number(event.totalLikes || 0).toLocaleString('ru-RU')}`;
  } else {
    text.textContent = meta.label;
  }

  const badge = document.createElement('span');
  badge.className = `badge ${event.type}`;
  badge.textContent = event.type === 'gift'
    ? `gift ×${event.count || 1}`
    : (event.type === 'like' ? `like ${Number(event.totalLikes || 0).toLocaleString('ru-RU')}` : meta.badge);
  metaEl.appendChild(badge);

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    blockUser(event.platform, event.user);
  });

  $('eventsLog').appendChild(row);
  trimEvents();
  $('eventsCount').textContent = $('eventsLog').children.length.toLocaleString('ru-RU');
  $('eventsEmpty').hidden = $('eventsLog').children.length > 0;
  const eventsFeed = $('eventsLog');
  eventsFeed.scrollTop = eventsFeed.scrollHeight;
}

// Скрыть пользователя: сразу убираем его сообщения и сохраняем в фильтр
async function blockUser(platform, user) {
  const name = String(user || '').trim();
  if (!name) return;
  try {
    const res = await ipcRenderer.invoke('user:hide', { platform, user: name });
    if (!res || !res.ok) {
      toast('Не удалось скрыть пользователя');
      return;
    }
    state.config = res.config;
    renderTagsHidden(state.config.hidden_users || []);
    const lower = name.toLowerCase();
    document.querySelectorAll('#chatLog .row, #eventsLog .row').forEach((row) => {
      if (String(row.dataset.user || '').toLowerCase() === lower) row.remove();
    });
    toast(`Пользователь ${name} скрыт`);
  } catch (err) {
    toast(`Не удалось скрыть: ${err.message}`);
  }
}

function clearChat() {
  $('chatLog').innerHTML = '';
  state.chatCount = 0;
  $('chatCount').textContent = '0';
  $('chatEmpty').hidden = false;
}

// ============================================================
// Тумблеры ленты
// ============================================================

$('segScroll').addEventListener('click', (e) => {
  state.autoScroll = !state.autoScroll;
  e.currentTarget.classList.toggle('on', state.autoScroll);
  if (state.autoScroll) {
    const feed = $('chatLog');
    feed.scrollTop = feed.scrollHeight;
  }
});

$('btnClearChat').addEventListener('click', clearChat);
$('btnClearEvents').addEventListener('click', () => {
  $('eventsLog').innerHTML = '';
  $('eventsCount').textContent = '0';
  $('eventsEmpty').hidden = false;
});

// ============================================================
// Настройки: чтение и отрисовка
// ============================================================

function ensureOption(select, value, labels = {}) {
  if (!value) return;
  if (![...select.options].some((o) => o.value === value)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = labels[value] || value;
    select.appendChild(opt);
  }
}

function fillSelects() {
  $('modelSelect').innerHTML = MODELS.map((m) => `<option value="${m}">${m}</option>`).join('');
  $('languageSelect').innerHTML = LANGUAGES
    .map((l) => `<option value="${l}">${LANGUAGE_LABELS[l] || l}</option>`)
    .join('');
  $('voiceList').innerHTML = RU_VOICES
    .map((v) => `<option value="${v.id}">${v.label}</option>`)
    .join('');
  $('voiceHint').textContent =
    `Для русского проверены: ${RU_VOICES.map((v) => v.id).join(', ')}. Неизвестный voice_id Speechify заменит своим.`;
  $('piperVoice').innerHTML = PIPER_VOICES
    .map((v) => `<option value="${v.id}">${v.label}</option>`)
    .join('');
}

// Какой движок выбран — показываем только его настройки
function updateEngineUI() {
  const engine = $('ttsEngine').value;
  $('ttsSpeechify').style.display = engine === 'speechify' ? '' : 'none';
  $('ttsPiper').style.display = engine === 'piper' ? '' : 'none';

  const hints = {
    speechify: 'Облачный Speechify: качественные голоса, но нужен API-ключ и интернет.',
    piper: 'Piper: офлайн-нейроголос, вшит в приложение. Без ключей и интернета.',
    none: 'Озвучка выключена — сообщения видны в ленте и оверлее, но не читаются.',
  };
  $('engineHint').textContent = hints[engine] || '';
  updateTtsStatus();
}

function updateTtsStatus() {
  if (!state.config) return;
  const engine = $('ttsEngine').value;
  if (engine === 'none') {
    $('ttsStatus').textContent = 'Озвучка выключена';
    return;
  }
  const voice = engine === 'piper'
    ? ($('piperVoice').value || state.config.piper_voice)
    : (state.config.voice_id || 'alexei');
  const speed = engine === 'piper' ? ` · ${state.config.tts_speed}%` : '';
  $('ttsStatus').textContent = `${engine === 'piper' ? 'Piper' : 'Speechify'} · ${voice}${speed}`;
}

// ---------- Теги (префиксы, боты, фразы) ----------
function renderTags(box, values, onChange, danger) {
  box.querySelectorAll('.tag').forEach((tag) => tag.remove());
  const input = box.querySelector('input');

  values.forEach((value) => {
    const tag = document.createElement('span');
    tag.className = `tag${danger ? ' red' : ''}`;
    tag.append(document.createTextNode(value));
    const remove = document.createElement('b');
    remove.textContent = '×';
    remove.title = 'Убрать';
    remove.addEventListener('click', () => {
      onChange(values.filter((v) => v !== value));
    });
    tag.appendChild(remove);
    box.insertBefore(tag, input);
  });
}

function tagBoxController(boxId, key, danger) {
  const box = $(boxId);
  const input = box.querySelector('input');

  const emit = (list) => {
    stage({ [key]: list });
    renderTags(box, list, emit, danger);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    const value = input.value.trim().replace(/,+$/, '');
    if (!value) return;
    const current = (state.config[key] || []).slice();
    if (!current.some((v) => v.toLowerCase() === value.toLowerCase())) current.push(value);
    input.value = '';
    emit(current);
  });

  box.addEventListener('click', (e) => {
    if (e.target === box) input.focus();
  });

  return (values) => renderTags(box, values || [], emit, danger);
}

// ---------- Команды ----------
function renderCommands() {
  const list = (state.config && state.config.custom_commands) || [];
  const body = $('commandsBody');
  body.innerHTML = '';

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'cmd-empty';
    empty.textContent = 'Команд пока нет — добавьте первую ниже';
    body.appendChild(empty);
    return;
  }

  list.forEach((cmd, index) => {
    const row = document.createElement('div');
    row.className = 'cmd-row';

    const trigger = document.createElement('span');
    trigger.className = 'cmd-trigger';
    trigger.textContent = cmd.trigger;

    const response = document.createElement('span');
    response.className = 'cmd-response';
    response.textContent = cmd.response;
    response.title = cmd.response;

    const desc = document.createElement('span');
    desc.className = 'cmd-desc';
    desc.textContent = cmd.description || '—';
    desc.title = cmd.description || '';

    const actions = document.createElement('span');
    actions.className = 'cmd-actions';

    const edit = document.createElement('button');
    edit.className = 'btn ghost';
    edit.textContent = 'Изменить';
    edit.addEventListener('click', () => {
      $('newTrigger').value = cmd.trigger;
      $('newResponse').value = cmd.response;
      $('newDescription').value = cmd.description || '';
      stage({ custom_commands: list.filter((_, i) => i !== index) });
      renderCommands();
      $('newTrigger').focus();
    });

    const remove = document.createElement('button');
    remove.className = 'btn ghost';
    remove.textContent = 'Удалить';
    remove.addEventListener('click', () => {
      stage({ custom_commands: list.filter((_, i) => i !== index) });
      renderCommands();
    });

    actions.append(edit, remove);
    row.append(trigger, response, desc, actions);
    body.appendChild(row);
  });
}

function addCommand() {
  const trigger = $('newTrigger').value.trim();
  const response = $('newResponse').value.trim();
  const description = $('newDescription').value.trim();

  if (!trigger || !response) {
    if (!trigger) $('newTrigger').classList.add('invalid');
    if (!response) $('newResponse').classList.add('invalid');
    setTimeout(() => {
      $('newTrigger').classList.remove('invalid');
      $('newResponse').classList.remove('invalid');
    }, 600);
    return;
  }

  const list = (state.config.custom_commands || []).slice();
  const existing = list.findIndex((c) => c.trigger.toLowerCase() === trigger.toLowerCase());
  if (existing >= 0) list.splice(existing, 1);
  list.push({ trigger, response, description });

  stage({ custom_commands: list });
  renderCommands();

  $('newTrigger').value = '';
  $('newResponse').value = '';
  $('newDescription').value = '';
}

// ---------- Применение конфига к форме ----------
let renderTagsPrefixes = null;
let renderTagsUsers = null;
let renderTagsPhrases = null;
let renderTagsHidden = null;

function applyConfigToUI() {
  const c = state.config;

  $('tiktokUsername').value = c.tiktok_username || '';
  $('twitchChannel').value = c.twitch_channel || '';
  $('twitchClientId').value = c.twitch_client_id || '';
  $('twitchClientSecret').value = c.twitch_client_secret || '';
  $('youtubeChannel').value = c.youtube_channel || '';
  $('youtubeApiKey').value = c.youtube_api_key || '';
  $('youtubeVideoId').value = c.youtube_video_id || '';
  $('youtubeAutoReconnect').checked = c.youtube_auto_reconnect !== false;

  $('speechifyKey').value = c.speechify_key || '';
  $('googleClientId').value = c.google_client_id || '';
  $('googleClientSecret').value = c.google_client_secret || '';
  $('ttsEngine').value = c.tts_engine || 'speechify';
  $('piperVoice').value = c.piper_voice || 'dmitri';
  $('ttsSpeed').value = c.tts_speed;
  $('ttsSpeedValue').textContent = `${c.tts_speed}%`;
  $('ttsVolume').value = c.tts_volume;
  $('ttsVolumeValue').textContent = `${c.tts_volume}%`;

  $('voiceId').value = c.voice_id || '';
  ensureOption($('modelSelect'), c.model);
  ensureOption($('languageSelect'), c.language, LANGUAGE_LABELS);
  $('modelSelect').value = c.model || MODELS[0];
  $('languageSelect').value = c.language || LANGUAGES[0];

  $('speakUsername').checked = c.speak_username === true;
  $('speakFollows').checked = c.speak_follows !== false;
  $('speakGifts').checked = c.speak_gifts !== false;

  $('prefixFilterEnabled').checked = c.prefix_filter_enabled !== false;
  renderTagsPrefixes(c.ignored_prefixes);
  renderTagsUsers(c.ignored_users);
  renderTagsPhrases(c.ignored_phrases);
  renderTagsHidden(c.hidden_users);

  $('emotesEnabled').checked = c.emotes_enabled !== false;
  $('avatarsEnabled').checked = c.avatars_enabled !== false;
  $('overlayChatCss').value = c.overlay_chat_css || '';
  $('overlayViewersCss').value = c.overlay_viewers_css || '';

  $('viewersEnabled').checked = c.viewers_enabled !== false;
  $('viewersTwitch').checked = c.viewers_twitch !== false;
  $('viewersYoutube').checked = c.viewers_youtube !== false;
  $('viewersTiktok').checked = c.viewers_tiktok !== false;

  $('overlayEnabled').checked = c.overlay_enabled !== false;
  $('overlayPort').value = c.overlay_port;

  $('overlayChatPosition').value = c.overlay_chat_position;
  $('overlayChatScale').value = c.overlay_chat_scale;
  $('overlayChatMaxMessages').value = c.overlay_chat_max_messages;
  $('overlayChatTtl').value = c.overlay_chat_ttl;
  $('overlayShowEvents').checked = c.overlay_show_events !== false;
  $('chatFontSize').value = c.chat_font_size;
  $('platformIconSize').value = c.platform_icon_size;
  $('showPlatformIcons').checked = c.show_platform_icons !== false;
  $('updateAutoCheck').checked = c.update_check_enabled !== false;
  $('updateManifestUrl').value = c.update_manifest_url || '';
  applyChatAppearance();

  $('overlayViewersEnabled').checked = c.overlay_viewers_enabled !== false;
  $('overlayViewersPosition').value = c.overlay_viewers_position;
  $('overlayViewersScale').value = c.overlay_viewers_scale;

  $('ttsStatus').textContent = `Speechify · ${c.voice_id} · ${c.language}`;
  updateEngineUI();
  updateKeyStatus();
  $('sendPlatform').value = c.send_platform === 'youtube' ? 'youtube' : 'twitch';
  renderCommands();
  updateOverlayUI(state.overlay);
}

// ============================================================
// Черновик и сохранение
// ============================================================

const stageQueue = new Map();
let stageTimer = null;

function stage(partial, immediate = false) {
  Object.assign(stageQueue, partial);
  if (immediate) {
    flushStage();
    return;
  }
  clearTimeout(stageTimer);
  stageTimer = setTimeout(flushStage, 120);
}

function flushStage() {
  if (!Object.keys(stageQueue).length) return;
  const partial = { ...stageQueue };
  stageQueue.clear();

  ipcRenderer.invoke('config:set', partial).then((res) => {
    state.config = res.config;
    state.dirty = res.dirty;
    if (res.overlay) {
      state.overlay = res.overlay;
      updateOverlayUI(res.overlay);
    }
    updateSaveState();
    // Часть полей главный процесс мог нормализовать (trim, lowercase)
    if ('tiktok_username' in partial) $('tiktokUsername').value = state.config.tiktok_username;
    if ('twitch_channel' in partial) $('twitchChannel').value = state.config.twitch_channel;
    if ('youtube_video_id' in partial) $('youtubeVideoId').value = state.config.youtube_video_id;
    if ('speechify_key' in partial) updateKeyStatus();
    if ('voice_id' in partial || 'language' in partial || 'tts_engine' in partial
      || 'piper_voice' in partial || 'tts_speed' in partial) {
      updateTtsStatus();
    }
  });
}

function updateSaveState() {
  const el = $('saveState');
  el.classList.remove('dirty', 'ok', 'error');

  if (state.dirty) {
    el.classList.add('dirty');
    el.innerHTML = '<i></i>Есть несохранённые изменения';
    $('savedAt').textContent = state.savedAt ? `сохранено ${state.savedAt}` : '';
  } else {
    el.classList.add('ok');
    el.innerHTML = '<i></i>Все изменения сохранены';
    $('savedAt').textContent = state.savedAt ? `сохранено ${state.savedAt}` : '';
  }

  $('btnSave').classList.toggle('primary', true);
}

function nowTime() {
  return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

$('btnSave').addEventListener('click', async () => {
  flushStage();
  const res = await ipcRenderer.invoke('config:save');
  if (res.ok) {
    state.dirty = false;
    state.savedAt = nowTime();
    $('configPath').value = res.file;
    updateSaveState();
    toast(`Настройки сохранены: ${res.file}`);
  } else {
    $('saveState').classList.add('error');
    $('saveState').innerHTML = '<i></i>Не удалось сохранить';
    toast(`Ошибка сохранения: ${res.error}`, true);
  }
});

$('btnReset').addEventListener('click', async () => {
  flushStage();
  const res = await ipcRenderer.invoke('config:reset');
  state.config = res.config;
  state.dirty = false;
  state.overlay = res.overlay;
  applyConfigToUI();
  updateOverlayUI(state.overlay);
  updateSaveState();
  toast('Изменения отменены');
});

// ============================================================
// Привязка полей
// ============================================================

function bindText(id, key, normalize) {
  const input = $(id);
  input.addEventListener('change', () => {
    const value = normalize ? normalize(input.value) : input.value.trim();
    stage({ [key]: value }, true);
  });
}

function bindCheck(id, key) {
  $(id).addEventListener('change', () => stage({ [key]: $(id).checked }, true));
}

function bindNumber(id, key, min, max) {
  const input = $(id);
  input.addEventListener('change', () => {
    let value = Number.parseInt(input.value, 10);
    if (!Number.isFinite(value)) value = min;
    value = Math.min(max, Math.max(min, value));
    input.value = value;
    stage({ [key]: value }, true);
  });
}

// Размер текста и значков платформ — применяем сразу, без сохранения
function applyChatAppearance() {
  const font = Math.min(28, Math.max(10, Number.parseInt($('chatFontSize').value, 10) || 13));
  const icon = Math.min(40, Math.max(14, Number.parseInt($('platformIconSize').value, 10) || 22));
  document.documentElement.style.setProperty('--chat-font', `${font}px`);
  document.documentElement.style.setProperty('--plat-icon', `${icon}px`);
  document.body.classList.toggle('hide-plat-icons', !$('showPlatformIcons').checked);
}

['chatFontSize', 'platformIconSize'].forEach((id) => {
  $(id).addEventListener('input', applyChatAppearance);
  $(id).addEventListener('change', applyChatAppearance);
});
$('showPlatformIcons').addEventListener('change', applyChatAppearance);

// Быстрое изменение размера текста из шапки чата
function bumpChatFont(delta) {
  const input = $('chatFontSize');
  let value = (Number.parseInt(input.value, 10) || 13) + delta;
  value = Math.min(28, Math.max(10, value));
  input.value = value;
  applyChatAppearance();
  stage({ chat_font_size: value }, true);
}

$('fontMinus').addEventListener('click', () => bumpChatFont(-1));
$('fontPlus').addEventListener('click', () => bumpChatFont(1));

bindText('tiktokUsername', 'tiktok_username', (v) => v.replace(/^@/, '').trim());
bindText('twitchChannel', 'twitch_channel', (v) => v.replace(/^#/, '').trim().toLowerCase());
bindText('twitchClientId', 'twitch_client_id');
bindText('twitchClientSecret', 'twitch_client_secret');
bindText('youtubeChannel', 'youtube_channel');
bindText('youtubeApiKey', 'youtube_api_key');
bindText('googleClientId', 'google_client_id');
bindText('googleClientSecret', 'google_client_secret');
bindText('speechifyKey', 'speechify_key');
bindText('voiceId', 'voice_id');

$('ttsEngine').addEventListener('change', () => {
  stage({ tts_engine: $('ttsEngine').value }, true);
  updateEngineUI();
});

$('piperVoice').addEventListener('change', () => {
  stage({ piper_voice: $('piperVoice').value }, true);
  updateTtsStatus();
});

$('ttsSpeed').addEventListener('input', () => {
  $('ttsSpeedValue').textContent = `${$('ttsSpeed').value}%`;
});
$('ttsSpeed').addEventListener('change', () => {
  stage({ tts_speed: Number($('ttsSpeed').value) }, true);
});

$('ttsVolume').addEventListener('input', () => {
  $('ttsVolumeValue').textContent = `${$('ttsVolume').value}%`;
});
$('ttsVolume').addEventListener('change', () => {
  stage({ tts_volume: Number($('ttsVolume').value) }, true);
});

$('modelSelect').addEventListener('change', () => stage({ model: $('modelSelect').value }, true));
$('languageSelect').addEventListener('change', () => stage({ language: $('languageSelect').value }, true));

bindCheck('youtubeAutoReconnect', 'youtube_auto_reconnect');
bindCheck('speakUsername', 'speak_username');
bindCheck('speakFollows', 'speak_follows');
bindCheck('speakGifts', 'speak_gifts');
bindCheck('prefixFilterEnabled', 'prefix_filter_enabled');
bindCheck('emotesEnabled', 'emotes_enabled');
bindCheck('avatarsEnabled', 'avatars_enabled');

bindCheck('viewersEnabled', 'viewers_enabled');
bindCheck('viewersTwitch', 'viewers_twitch');
bindCheck('viewersYoutube', 'viewers_youtube');
bindCheck('viewersTiktok', 'viewers_tiktok');

bindCheck('overlayEnabled', 'overlay_enabled');
bindCheck('overlayShowEvents', 'overlay_show_events');
bindCheck('overlayViewersEnabled', 'overlay_viewers_enabled');

$('overlayChatPosition').addEventListener('change', () => stage({ overlay_chat_position: $('overlayChatPosition').value }, true));
$('overlayViewersPosition').addEventListener('change', () => stage({ overlay_viewers_position: $('overlayViewersPosition').value }, true));

bindNumber('overlayPort', 'overlay_port', 1024, 65535);
bindNumber('overlayChatScale', 'overlay_chat_scale', 60, 180);
bindNumber('overlayChatMaxMessages', 'overlay_chat_max_messages', 3, 30);
bindNumber('overlayChatTtl', 'overlay_chat_ttl', 0, 600);
bindNumber('chatFontSize', 'chat_font_size', 10, 28);
bindNumber('platformIconSize', 'platform_icon_size', 14, 40);
bindCheck('showPlatformIcons', 'show_platform_icons');
bindCheck('updateAutoCheck', 'update_check_enabled');
bindText('updateManifestUrl', 'update_manifest_url', (v) => v.trim());
bindNumber('overlayViewersScale', 'overlay_viewers_scale', 60, 200);

// ============================================================
// Ключ и озвучка
// ============================================================

function updateKeyStatus() {
  const key = state.config ? state.config.speechify_key : '';
  const has = !!key;
  $('dotKey').className = `dot ${has ? 'on' : 'off'}`;
  $('statusKey').textContent = has
    ? `${key.slice(0, 6)}…${key.slice(-4)}`
    : 'ключ не задан';
}

$('btnToggleKey').addEventListener('click', () => {
  const input = $('speechifyKey');
  input.type = input.type === 'text' ? 'password' : 'text';
});

$('btnTtsTest').addEventListener('click', async () => {
  const btn = $('btnTtsTest');
  btn.disabled = true;
  const label = btn.innerHTML;
  btn.textContent = 'Озвучиваю…';
  const ok = await ipcRenderer.invoke('tts:test');
  btn.disabled = false;
  btn.innerHTML = label;
  if (!ok) toast('Проверка озвучки не удалась — смотрите события', true);
});

$('btnTestSpeak').addEventListener('click', () => $('btnTtsTest').click());

// Очередь озвучки: следующий файл играет только после окончания предыдущего
const ttsAudioQueue = [];
let ttsAudioPlaying = false;

function playNextTtsAudio() {
  if (ttsAudioPlaying) return;
  const payload = ttsAudioQueue.shift();
  if (!payload) return;

  ttsAudioPlaying = true;
  const src = payload.url || `file:///${String(payload.file).replace(/\\/g, '/')}`;
  const audio = new Audio(src);
  const volume = Number(state.config && state.config.tts_volume);
  audio.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume / 100)) : 1;

  const finish = () => {
    ttsAudioPlaying = false;
    setTimeout(playNextTtsAudio, 80);
  };

  audio.addEventListener('ended', finish, { once: true });
  audio.addEventListener('error', finish, { once: true });
  audio.play().catch((err) => {
    toast(`Ошибка воспроизведения: ${err.message}`, true);
    finish();
  });
}

ipcRenderer.on('tts:play', (_e, payload) => {
  if (!payload || (!payload.url && !payload.file)) return;
  ttsAudioQueue.push(payload);
  playNextTtsAudio();
});

// ============================================================
// Подключение площадок
// ============================================================

function setPlatformState(platform, connected, meta) {
  state.connected[platform] = connected;
  const dot = $(`dot${platform[0].toUpperCase()}${platform.slice(1)}`);
  if (dot) dot.className = `dot ${connected ? 'on' : 'off'}`;

  const chip = $(`chip${platform[0].toUpperCase()}${platform.slice(1)}`);
  if (chip) chip.classList.toggle('connected', connected);

  if (meta !== undefined && chip) chip.title = String(meta);

  updateLiveBadge();
}

const PLATFORM_CONFIG = {
  tiktok: {
    field: 'tiktokUsername',
    connect: 'tiktok:connect',
    disconnect: 'tiktok:disconnect',
    label: (v) => `@${v}`,
    value: () => $('tiktokUsername').value.replace(/^@/, '').trim(),
    error: 'TikTok: укажите никнейм трансляции (без @)',
  },
  twitch: {
    field: 'twitchChannel',
    connect: 'twitch:connect',
    disconnect: 'twitch:disconnect',
    label: (v) => `#${v}`,
    value: () => $('twitchChannel').value.replace(/^#/, '').trim().toLowerCase(),
    error: 'Twitch: укажите канал (без #)',
  },
  youtube: {
    field: 'youtubeChannel',
    connect: 'youtube:connect',
    disconnect: 'youtube:disconnect',
    label: (v) => v,
    value: () => $('youtubeChannel').value.trim(),
    error: 'YouTube: укажите канал и API-ключ',
    extraCheck: () => {
      if (!$('youtubeApiKey').value.trim()) {
        toast('YouTube: нужен API-ключ Data API v3', true);
        $('youtubeApiKey').focus();
        return false;
      }
      return true;
    },
    payload: () => ({
      channel: $('youtubeChannel').value.trim(),
      apiKey: $('youtubeApiKey').value.trim(),
      autoReconnect: $('youtubeAutoReconnect').checked,
    }),
  },
};

async function connectPlatform(name) {
  const p = PLATFORM_CONFIG[name];
  const value = p.value();
  if (!value) {
    toast(p.error, true);
    $(p.field).focus();
    return;
  }
  if (p.extraCheck && !p.extraCheck()) return;

  const btn = $(`btn${name[0].toUpperCase()}${name.slice(1)}Connect`);
  btn.disabled = true;
  btn.textContent = 'Подключаю…';

  const payload = p.payload ? p.payload() : value;
  const res = await ipcRenderer.invoke(p.connect, payload);

  btn.disabled = false;
  btn.textContent = 'Подключить';

  if (res.ok) {
    setPlatformState(name, true, p.label(value));
    toast(`${name}: ${p.label(value)} подключён`);
  } else {
    setPlatformState(name, false, res.error);
    toast(`${name}: ${res.error}`, true);
  }
}

async function disconnectPlatform(name) {
  const p = PLATFORM_CONFIG[name];
  await ipcRenderer.invoke(p.disconnect);
  setPlatformState(name, false, 'отключено');
  toast(`${name}: чат отключён`);
}

$('btnTiktokConnect').addEventListener('click', () => connectPlatform('tiktok'));
$('btnTwitchConnect').addEventListener('click', () => connectPlatform('twitch'));
$('btnYoutubeConnect').addEventListener('click', () => connectPlatform('youtube'));
$('btnTiktokDisconnect').addEventListener('click', () => disconnectPlatform('tiktok'));
$('btnTwitchDisconnect').addEventListener('click', () => disconnectPlatform('twitch'));
$('btnYoutubeDisconnect').addEventListener('click', () => disconnectPlatform('youtube'));

$('tiktokUsername').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectPlatform('tiktok'); });
$('twitchChannel').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectPlatform('twitch'); });
$('youtubeChannel').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectPlatform('youtube'); });

// ============================================================
// Зрители
// ============================================================

function renderViewers(viewers) {
  if (!viewers) return;
  state.viewers = { ...state.viewers, ...viewers };

  const map = { tiktok: 'countTiktok', twitch: 'countTwitch', youtube: 'countYoutube' };
  Object.entries(map).forEach(([platform, id]) => {
    const value = state.viewers[platform];
    const el = $(id);
    if (!el) return;
    el.textContent = Number.isFinite(value) ? Number(value).toLocaleString('ru-RU') : '—';
  });
}

ipcRenderer.on('viewers:update', (_e, viewers) => renderViewers(viewers));

// ============================================================
// Оверлей
// ============================================================

function updateOverlayUI(info) {
  if (!info) return;
  state.overlay = info;

  const chatUrl = info.chatUrl || '';
  const viewersUrl = info.viewersUrl || '';

  $('overlayChatUrl').value = chatUrl || '—';
  $('overlayViewersUrl').value = viewersUrl || '—';

  $('overlayStatus').textContent = info.running
    ? `Оверлеи: ${String(info.base || '').replace(/^http:\/\//, '')}`
    : (info.enabled ? 'Оверлеи: остановлен' : 'Оверлеи: выключен');
  $('overlayHint').textContent = info.running
    ? 'Сервер слушает только 127.0.0.1 — доступен лишь на этом компьютере. У чата и зрителей разные адреса: добавьте в OBS два Browser Source.'
    : 'Сервер не запущен. Включите оверлей в настройках.';

  const chatFrame = $('overlayChatPreview');
  const chatEmpty = $('chatPreviewEmpty');
  if (chatUrl && info.running) {
    if (chatFrame.getAttribute('src') !== chatUrl) chatFrame.setAttribute('src', chatUrl);
    chatEmpty.hidden = true;
  } else {
    chatFrame.removeAttribute('src');
    chatEmpty.hidden = false;
  }

  const viewersFrame = $('overlayViewersPreview');
  const viewersEmpty = $('viewersPreviewEmpty');
  const showViewers = viewersUrl && info.running && state.config && state.config.overlay_viewers_enabled !== false;
  if (showViewers) {
    if (viewersFrame.getAttribute('src') !== viewersUrl) viewersFrame.setAttribute('src', viewersUrl);
    viewersEmpty.hidden = true;
  } else {
    viewersFrame.removeAttribute('src');
    viewersEmpty.hidden = false;
  }

  $('btnOpenChatOverlay').disabled = !info.running;
  $('btnCopyChatOverlay').disabled = !chatUrl;
  $('btnOpenViewersOverlay').disabled = !showViewers;
  $('btnCopyViewersOverlay').disabled = !viewersUrl;
}

function copyOverlayUrl(inputId, label) {
  const input = $(inputId);
  const url = input.value;
  if (!url || url === '—') return;

  const done = () => toast(`Адрес ${label} скопирован`);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => {
      input.select();
      document.execCommand('copy');
      done();
    });
  } else {
    input.select();
    document.execCommand('copy');
    done();
  }
}

$('btnCopyChatOverlay').addEventListener('click', () => copyOverlayUrl('overlayChatUrl', 'чата'));
$('btnCopyViewersOverlay').addEventListener('click', () => copyOverlayUrl('overlayViewersUrl', 'зрителей'));

$('btnOpenOverlay').addEventListener('click', () => {
  if (state.overlay && state.overlay.running) {
    ipcRenderer.invoke('overlay:open', 'chat');
  } else {
    showPage('widgets');
  }
});

$('btnOpenChatOverlay').addEventListener('click', () => ipcRenderer.invoke('overlay:open', 'chat'));
$('btnOpenViewersOverlay').addEventListener('click', () => ipcRenderer.invoke('overlay:open', 'viewers'));

$('btnRestartOverlay').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('overlay:restart');
  if (res.ok) {
    const info = await ipcRenderer.invoke('overlay:info');
    updateOverlayUI(info);
    toast(`Сервер оверлеев перезапущен: ${info.base}`);
  } else {
    toast(`Оверлей: ${res.error}`, true);
  }
});

function reloadPreviews() {
  for (const id of ['overlayChatPreview', 'overlayViewersPreview']) {
    const frame = $(id);
    if (frame.getAttribute('src')) {
      // eslint-disable-next-line no-self-assign
      frame.src = frame.src;
    }
  }
}

$('btnReloadPreview').addEventListener('click', reloadPreviews);

// Свой CSS виджетов
$('overlayChatCss').addEventListener('change', () => {
  stage({ overlay_chat_css: $('overlayChatCss').value }, true);
  reloadPreviews();
  toast('CSS чат-оверлея сохранён');
});
$('overlayViewersCss').addEventListener('change', () => {
  stage({ overlay_viewers_css: $('overlayViewersCss').value }, true);
  reloadPreviews();
  toast('CSS виджета зрителей сохранён');
});

// Пресеты вида
const CHAT_PRESETS = {
  compact: { overlay_chat_scale: 85, overlay_chat_max_messages: 6, overlay_chat_ttl: 30, overlay_show_events: true },
  large: { overlay_chat_scale: 125, overlay_chat_max_messages: 20, overlay_chat_ttl: 90, overlay_show_events: true },
  donate: { overlay_chat_scale: 110, overlay_chat_max_messages: 8, overlay_chat_ttl: 45, overlay_show_events: false },
};

document.querySelectorAll('[data-chat-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = CHAT_PRESETS[btn.dataset.chatPreset];
    if (!preset) return;
    stage(preset, true);
    $('overlayChatScale').value = preset.overlay_chat_scale;
    $('overlayChatMaxMessages').value = preset.overlay_chat_max_messages;
    $('overlayChatTtl').value = preset.overlay_chat_ttl;
    $('overlayShowEvents').checked = preset.overlay_show_events;
    reloadPreviews();
    toast(`Пресет «${btn.textContent.trim()}» применён`);
  });
});

const VIEWERS_PRESETS = {
  small: { overlay_viewers_scale: 80 },
  large: { overlay_viewers_scale: 135 },
};

document.querySelectorAll('[data-viewers-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = VIEWERS_PRESETS[btn.dataset.viewersPreset];
    if (!preset) return;
    stage(preset, true);
    $('overlayViewersScale').value = preset.overlay_viewers_scale;
    reloadPreviews();
    toast(`Пресет «${btn.textContent.trim()}» применён`);
  });
});

// ============================================================
// Уведомления
// ============================================================

let toastTimer = null;

function toast(text, isError = false) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3200);
}

// ============================================================
// События главного процесса
// ============================================================

ipcRenderer.on('chat:message', (_e, msg) => addChatMessage(msg));
ipcRenderer.on('tiktok:event', (_e, evt) => addEvent(evt));

// Эмоуты и аватары, которые подгружает главный процесс
function applyEmotesMap(map) {
  state.emotes = map || {};
  if (!Object.keys(state.emotes).length) return;
  document.querySelectorAll('#chatLog .row.chat').forEach((row) => {
    const text = row.querySelector('.text');
    if (text && row.dataset.text) renderMessageText(text, row.dataset.text);
  });
}

ipcRenderer.on('emotes:update', (_e, emotes) => applyEmotesMap(emotes));

ipcRenderer.on('chat:avatar', (_e, payload) => {
  if (!payload || !payload.avatar) return;
  document.querySelectorAll(`#chatLog .row[data-platform="${payload.platform}"]`).forEach((row) => {
    if (String(row.dataset.login).toLowerCase() !== String(payload.login || '').toLowerCase()) return;
    const av = row.querySelector('.av');
    if (av) paintAvatar(av, row.dataset.user, payload.avatar);
  });
});

ipcRenderer.on('app:log', (_e, entry) => {
  console.log(`[app] ${entry.level}: ${entry.text}`);
  if (entry.level === 'error') toast(entry.text, true);
});

ipcRenderer.on('config:dirty', (_e, payload) => {
  state.dirty = !!payload.dirty;
  updateSaveState();
});

ipcRenderer.on('config:changed', (_e, payload) => {
  if (!payload || !payload.config) return;
  state.config = payload.config;
  state.dirty = !!payload.dirty;
  $('youtubeVideoId').value = state.config.youtube_video_id || '';
  updateKeyStatus();
  updateTtsStatus();
  updateSaveState();
});

ipcRenderer.on('tiktok:status', (_e, s) => {
  setPlatformState('tiktok', !!s.connected, s.username ? `@${s.username}` : (s.text || ''));
  if (!s.connected && s.text) console.log('[tiktok]', s.text);
});

ipcRenderer.on('twitch:status', (_e, s) => {
  setPlatformState('twitch', !!s.connected, s.text || '');
  if (!s.connected && s.text) console.log('[twitch]', s.text);
});

ipcRenderer.on('youtube:status', (_e, s) => {
  setPlatformState('youtube', !!s.connected, s.text || '');
  if (!s.connected && s.text) console.log('[youtube]', s.text);
});

ipcRenderer.on('overlay:info', (_e, info) => updateOverlayUI(info));

ipcRenderer.on('window:maximized', () => { /* иконка не меняется — окно системное */ });

// ============================================================
// Кнопки окна
// ============================================================

$('winMinimize').addEventListener('click', () => ipcRenderer.send('window:minimize'));
$('winMaximize').addEventListener('click', () => ipcRenderer.send('window:maximize'));
$('winClose').addEventListener('click', () => ipcRenderer.send('window:close'));

// ============================================================
// Прочее
// ============================================================

$('btnRevealConfig').addEventListener('click', () => ipcRenderer.invoke('config:reveal'));

$('btnExportConfig').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('config:export');
  if (res.ok) toast(`Настройки экспортированы: ${res.file}`);
  else if (!res.canceled) toast(`Экспорт не удался: ${res.error}`, true);
});

$('btnImportConfig').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('config:import');
  if (!res.ok) {
    if (!res.canceled) toast(`Импорт не удался: ${res.error}`, true);
    return;
  }
  state.config = res.config;
  state.dirty = false;
  applyConfigToUI();
  updateSaveState();
  toast('Настройки импортированы');
});

// Внешние ссылки («О программе») открываем в браузере, а не в окне приложения
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-external]');
  if (!link) return;
  e.preventDefault();
  ipcRenderer.invoke('app:openExternal', link.href);
});

$('btnAddCommand').addEventListener('click', addCommand);
$('newResponse').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCommand(); });

// Нижняя панель ввода из 1.8 заменена настройками; сохраняем
// команду «проверить озвучку» на кнопке в «Данных».

// ============================================================
// OAuth: статусы, вход, отправка сообщений
// ============================================================

function renderOAuth(oauth) {
  state.oauth = oauth || {};
  const t = (oauth && oauth.twitch) || {};
  const g = (oauth && oauth.google) || {};

  const tw = $('oauthTwitchStatus');
  tw.textContent = t.loggedIn
    ? `Вход выполнен: ${t.login || 'Twitch'}`
    : (t.clientId ? 'Вход не выполнен' : 'Сначала укажите Twitch Client ID на карточке площадок');
  tw.classList.toggle('oauth-status-on', !!t.loggedIn);
  tw.classList.toggle('oauth-status-off', !t.loggedIn);

  $('btnTwitchLogin').disabled = !t.clientId || !!t.loggedIn;
  $('btnTwitchLogout').disabled = !t.loggedIn;

  const gg = $('oauthGoogleStatus');
  gg.textContent = g.loggedIn ? 'Вход выполнен: сообщения можно отправлять' : 'Вход не выполнен';
  gg.classList.toggle('oauth-status-on', !!g.loggedIn);
  gg.classList.toggle('oauth-status-off', !g.loggedIn);
  $('btnGoogleLogin').disabled = !g.clientId || !g.hasSecret || !!g.loggedIn;
  $('btnGoogleLogout').disabled = !g.loggedIn;
}

$('btnTwitchLogin').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('oauth:twitch:start');
  if (!res.ok) {
    toast(res.error, true);
    return;
  }
  $('twitchDeviceCode').textContent = res.userCode;
  $('twitchDeviceBox').hidden = false;
  toast(`Код ${res.userCode} — подтвердите на twitch.tv/activate`);
});

$('btnTwitchLogout').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('oauth:twitch:logout');
  $('twitchDeviceBox').hidden = true;
  renderOAuth(res.oauth);
  toast('Вы вышли из Twitch');
});

$('btnGoogleLogin').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('oauth:google:start');
  if (!res.ok) {
    toast(res.error, true);
    return;
  }
  toast('Откройте браузер и подтвердите доступ Google');
});

$('btnGoogleLogout').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('oauth:google:logout');
  renderOAuth(res.oauth);
  toast('Вы вышли из Google');
});

ipcRenderer.on('oauth:update', (_e, oauth) => renderOAuth(oauth));
ipcRenderer.on('oauth:error', (_e, payload) => {
  toast(`Вход ${payload.provider}: ${payload.message}`, true);
});

async function sendChatMessage() {
  const input = $('sendInput');
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }

  const btn = $('btnSendMessage');
  const platform = $('sendPlatform').value;
  btn.disabled = true;
  const res = await ipcRenderer.invoke('chat:send', {
    platform,
    text,
  });
  btn.disabled = false;

  if (res.ok) {
    const ownName = platform === 'youtube'
      ? (state.config ? state.config.youtube_channel : '')
      : (state.config && (state.config.twitch_login || state.config.twitch_channel)) || '';
    addLocalEcho({
      platform,
      user: ownName || 'Вы',
      text,
      time: Date.now(),
    });
    input.value = '';
    toast('Сообщение отправлено');
  } else {
    toast(`Не отправлено: ${res.error}`, true);
  }
}

$('btnSendMessage').addEventListener('click', sendChatMessage);
$('sendInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendChatMessage();
  }
});
$('sendPlatform').addEventListener('change', () => {
  stage({ send_platform: $('sendPlatform').value }, true);
});

// ============================================================
// Мастер первого запуска
// ============================================================
let wizardStep = 1;
const WIZARD_STEPS = 3;

function applyWizardStep() {
  document.querySelectorAll('.wizard-step').forEach((step) => {
    step.hidden = Number(step.dataset.step) !== wizardStep;
  });
  $('wizardStepLabel').textContent = `Шаг ${wizardStep} из ${WIZARD_STEPS}`;
  $('wizardNext').textContent = wizardStep === WIZARD_STEPS ? 'Готово' : 'Далее';
}

function openWizard() {
  const c = state.config || {};
  const engine = ['speechify', 'piper', 'none'].includes(c.tts_engine) ? c.tts_engine : 'piper';
  const radio = document.querySelector(`input[name="wizEngine"][value="${engine}"]`);
  if (radio) radio.checked = true;

  $('wizTiktok').value = c.tiktok_username || '';
  $('wizTwitch').value = c.twitch_channel || '';
  $('wizYoutube').value = c.youtube_channel || '';
  $('wizChatUrl').value = (state.overlay && state.overlay.chatUrl) || '—';
  $('wizViewersUrl').value = (state.overlay && state.overlay.viewersUrl) || '—';

  wizardStep = 1;
  applyWizardStep();
  $('wizard').hidden = false;
}

async function closeWizard(applyFields) {
  const patch = { onboarding_done: true };

  if (applyFields) {
    const engineRadio = document.querySelector('input[name="wizEngine"]:checked');
    patch.tts_engine = engineRadio ? engineRadio.value : 'piper';
    patch.tiktok_username = $('wizTiktok').value.replace(/^@/, '').trim();
    patch.twitch_channel = $('wizTwitch').value.replace(/^#/, '').trim().toLowerCase();
    patch.youtube_channel = $('wizYoutube').value.trim();
  }

  stage(patch, true);
  await new Promise((r) => setTimeout(r, 300));
  await ipcRenderer.invoke('config:save');
  state.dirty = false;
  applyConfigToUI();
  updateSaveState();
  $('wizard').hidden = true;
  toast(applyFields ? 'Настройки первого запуска сохранены' : 'Мастер пропущен — его можно вызвать позже');
}

$('wizardNext').addEventListener('click', () => {
  if (wizardStep < WIZARD_STEPS) {
    wizardStep += 1;
    applyWizardStep();
    return;
  }
  closeWizard(true);
});
$('wizardSkip').addEventListener('click', () => closeWizard(false));

// ============================================================
// Старт
// ============================================================

renderTagsPrefixes = tagBoxController('prefixBox', 'ignored_prefixes', false);
renderTagsUsers = tagBoxController('usersBox', 'ignored_users', true);
renderTagsPhrases = tagBoxController('phrasesBox', 'ignored_phrases', true);
renderTagsHidden = tagBoxController('hiddenBox', 'hidden_users', true);

// ============================================================
// Проверка обновлений
// ============================================================
let updateInfo = null;
let updateAutoChecked = false;
let updateDismissedVersion = '';

function showUpdateModal(info) {
  if (!info) return;
  $('updateModalVersion').textContent = info.latest || '';
  $('updateModalCurrent').textContent = `у вас ${info.current || ''}`;
  $('updateModalNotes').textContent = info.notes || 'Описание изменений не приложено.';
  $('updateModal').hidden = false;
}

function closeUpdateModal() {
  $('updateModal').hidden = true;
}

async function checkUpdates(manual = false) {
  const status = $('updateStatus');
  const button = $('btnCheckUpdates');
  if (!status) return;

  status.textContent = 'Проверяю…';
  button.disabled = true;
  try {
    const res = await ipcRenderer.invoke('update:check');
    if (!res || !res.ok) {
      status.textContent = `Не удалось проверить: ${res ? res.error : 'неизвестная ошибка'}`;
      $('btnDownloadUpdate').hidden = true;
      $('btnShowUpdateNotes').hidden = true;
      if (manual) toast('Не удалось проверить обновления');
      return;
    }
    if (res.hasUpdate) {
      updateInfo = res;
      status.textContent = `Доступна версия ${res.latest} (у вас ${res.current})`;
      const download = $('btnDownloadUpdate');
      download.hidden = !res.url;
      download.textContent = `Скачать ${res.latest}`;
      $('btnShowUpdateNotes').hidden = !res.notes;
      toast(`Доступно обновление ${res.latest}`);
      if (manual || updateDismissedVersion !== res.latest) showUpdateModal(res);
    } else {
      updateInfo = null;
      status.textContent = `У вас последняя версия (${res.current})`;
      $('btnDownloadUpdate').hidden = true;
      $('btnShowUpdateNotes').hidden = true;
      if (manual) toast('Обновлений нет');
    }
  } finally {
    button.disabled = false;
  }
}

function maybeAutoCheckUpdates() {
  if (updateAutoChecked) return;
  updateAutoChecked = true;
  if (!state.config || state.config.update_check_enabled === false) return;
  setTimeout(() => {
    if (state.config && state.config.update_check_enabled !== false) checkUpdates(false);
  }, 4000);
}

$('btnCheckUpdates').addEventListener('click', () => checkUpdates(true));
$('btnDownloadUpdate').addEventListener('click', () => {
  if (updateInfo && updateInfo.url) {
    ipcRenderer.invoke('app:openExternal', updateInfo.url);
    closeUpdateModal();
  }
});
$('btnUpdateDownload').addEventListener('click', () => {
  if (updateInfo && updateInfo.url) {
    ipcRenderer.invoke('app:openExternal', updateInfo.url);
    closeUpdateModal();
  }
});
$('btnUpdateLater').addEventListener('click', () => {
  updateDismissedVersion = updateInfo ? updateInfo.latest : '';
  closeUpdateModal();
});
$('btnShowUpdateNotes').addEventListener('click', () => showUpdateModal(updateInfo));
$('btnOpenLog').addEventListener('click', () => ipcRenderer.invoke('app:openLogFolder'));

fillSelects();

ipcRenderer.invoke('config:get').then((payload) => {
  state.config = payload.config;
  state.dirty = payload.dirty;
  state.overlay = payload.overlay;
  state.viewers = payload.viewers || state.viewers;

  const version = String(payload.appVersion || '').split('+')[0];
  $('aboutVersion').textContent = version;
  $('statusVersion').textContent = version;
  $('railVersion').textContent = version;
  $('titlebarVersion').textContent = `v${version}`;
  $('configPath').value = payload.path;

  fillSelects();
  applyConfigToUI();
  updateOverlayUI(payload.overlay);
  renderViewers(state.viewers);
  renderOAuth(payload.oauth);
  updateSaveState();
  maybeAutoCheckUpdates();

  if (!payload.config.onboarding_done) openWizard();

  if (payload.keyMasked) {
    $('statusKey').textContent = payload.keyMasked === 'не задан' ? 'ключ не задан' : payload.keyMasked;
    $('dotKey').className = `dot ${payload.keyMasked === 'не задан' ? 'off' : 'on'}`;
  }
});

// Эмоуты могли загрузиться до готовности окна — забираем текущий набор,
// повторяя запрос, пока главный процесс не догрузит их из сети
let emotesAttempts = 0;
function fetchEmotes() {
  ipcRenderer.invoke('emotes:get').then((map) => {
    if (map && Object.keys(map).length) {
      applyEmotesMap(map);
      return;
    }
    emotesAttempts += 1;
    if (emotesAttempts < 8) setTimeout(fetchEmotes, 1500);
  }).catch(() => {});
}
fetchEmotes();

ipcRenderer.invoke('status:get').then((s) => {
  if (s.oauth) renderOAuth(s.oauth);  if (s.tiktok) setPlatformState('tiktok', true, s.tiktokUsername ? `@${s.tiktokUsername}` : 'подключено');
  if (s.twitch) setPlatformState('twitch', true, s.twitchChannel ? `#${s.twitchChannel}` : 'подключено');
  if (s.youtube) setPlatformState('youtube', true, s.youtubeChannel || 'подключено');
  if (s.overlay) updateOverlayUI(s.overlay);
  if (s.viewers) renderViewers(s.viewers);
});
