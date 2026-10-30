// ============================================================
// E2E-проверки Aron Chat 1.9.
//
// Запуск: приложение уже открыто с отладкой:
//   npx electron . --remote-debugging-port=9222
//   node e2e_check.js [порт]
//
// Проверяем каркас, настройки, сохранение, фильтры, ленту,
// счётчики и оба оверлея по HTTP.
// ============================================================

const { open, collector } = require('./cdp');

const OVERLAY_CHAT = 'http://127.0.0.1:3000/overlay/chat';
const OVERLAY_VIEWERS = 'http://127.0.0.1:3000/overlay/viewers';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchStatus(url) {
  try {
    const res = await fetch(url);
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: 0, body: String(err.message) };
  }
}

(async () => {
  const page = await open(Number(process.argv[2]) || 9222);
  const { check, summary } = collector();

  const count = (selector) => page.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const text = (selector) => page.evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);

  // ---------- Каркас ----------
  check('окно открылось', (await page.evaluate('document.readyState')) === 'complete');
  check('пять разделов в рейле', (await count('.rail-item')) === 5);
  check('пять страниц', (await count('.page')) === 5);
  check('шрифты Tektur и Exo 2 загружены',
    await page.evaluate("document.fonts.check('12px Tektur') && document.fonts.check('12px \"Exo 2\"')"));
  const pkgVersion = require('./package.json').version;
  check(`версия ${pkgVersion}`, (await text('#aboutVersion')) === pkgVersion);

  // ---------- Оверлеи ----------
  const chatUrl = await page.evaluate("document.getElementById('overlayChatUrl').value");
  const viewersUrl = await page.evaluate("document.getElementById('overlayViewersUrl').value");
  check('адрес чат-оверлея', chatUrl.endsWith('/overlay/chat'), chatUrl);
  check('адрес оверлея зрителей', viewersUrl.endsWith('/overlay/viewers'), viewersUrl);

  const chatPage = await fetchStatus(chatUrl);
  check('чат-оверлей отдаётся', chatPage.status === 200 && /data-widget="chat"/.test(chatPage.body));
  const viewersPage = await fetchStatus(viewersUrl);
  check('оверлей зрителей отдаётся', viewersPage.status === 200 && /data-widget="viewers"/.test(viewersPage.body));
  const overlayBase = chatUrl.replace(/\/overlay\/chat$/, '');
  check('стили оверлея доступны', (await fetchStatus(`${overlayBase}/overlay.css`)).status === 200);
  check('шрифты оверлея доступны', (await fetchStatus(`${overlayBase}/fonts/fonts.css`)).status === 200);

  // ---------- Настройки: разделы не уезжают ----------
  await page.evaluate("showPage('settings')");
  const navTop = await page.evaluate("Math.round(document.querySelector('.setnav').getBoundingClientRect().top)");
  await page.evaluate("document.getElementById('settingsScroll').scrollTop = 1400");
  await sleep(300);
  const navTop2 = await page.evaluate("Math.round(document.querySelector('.setnav').getBoundingClientRect().top)");
  check('разделы настроек закреплены', navTop === navTop2, `${navTop} → ${navTop2}`);

  // ---------- Поля ----------
  const ids = [
    'tiktokUsername', 'twitchChannel', 'twitchClientId', 'youtubeChannel', 'youtubeApiKey',
    'speechifyKey', 'voiceId', 'modelSelect', 'languageSelect',
    'speakUsername', 'speakFollows', 'speakGifts',
    'prefixFilterEnabled', 'prefixBox', 'usersBox', 'phrasesBox',
    'viewersEnabled', 'viewersTwitch', 'viewersYoutube', 'viewersTiktok',
    'overlayEnabled', 'overlayPort', 'overlayChatPosition', 'overlayChatScale',
    'overlayChatMaxMessages', 'overlayChatTtl', 'overlayShowEvents',
    'overlayViewersEnabled', 'overlayViewersPosition', 'overlayViewersScale',
    'commandsBody', 'configPath', 'btnSave', 'btnReset',
  ];
  const missing = await page.evaluate(`(${JSON.stringify(ids)}).filter((id) => !document.getElementById(id))`);
  check('все поля настроек на месте', missing.length === 0, missing.join(', '));

  // ---------- Фильтры: теги ----------
  const before = await count('#usersBox .tag');
  await page.evaluate(`
    (() => {
      const input = document.querySelector('#usersBox input');
      input.value = 'E2Ebot';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `);
  await sleep(400);
  check('бот добавляется в фильтр', (await count('#usersBox .tag')) === before + 1);

  await page.evaluate(`
    (() => {
      const tags = [...document.querySelectorAll('#usersBox .tag')];
      const tag = tags.find((t) => t.textContent.includes('E2Ebot'));
      if (tag) tag.querySelector('b').click();
      return !!tag;
    })()
  `);
  await sleep(400);
  check('бот удаляется из фильтра', (await count('#usersBox .tag')) === before);

  // Возвращаем конфиг к сохранённому состоянию
  await page.evaluate("require('electron').ipcRenderer.invoke('config:reset')");
  await sleep(300);

  // ---------- Черновик и сохранение ----------
  await page.evaluate(`
    (() => {
      const input = document.getElementById('overlayChatScale');
      input.value = '120';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(400);
  check('правка помечает настройки как несохранённые', /несохран/i.test(await text('#saveState')));

  await page.evaluate("document.getElementById('btnReset').click()");
  await sleep(500);
  check('сброс возвращает сохранённое значение',
    (await page.evaluate("document.getElementById('overlayChatScale').value")) === '100');

  // ---------- Лента ----------
  await page.evaluate("showPage('chat')");
  const rowsBefore = await count('#chatLog .row');
  await page.evaluate(`require('electron').ipcRenderer.invoke('dev:chat', {
    platform: 'twitch', user: 'E2EUser', text: 'Проверка ленты', silent: true
  })`);
  await page.evaluate("require('electron').ipcRenderer.invoke('dev:event', { type: 'follow', user: 'E2EFan' })");
  await sleep(400);
  check('сообщение попало в ленту чата', (await count('#chatLog .row')) === rowsBefore + 1);
  check('сообщение Twitch с ником', /E2EUser/.test(await text('#chatLog')));
  check('событие попало в отдельное окно', (await count('#eventsLog .row')) >= 1);
  check('бейдж подписки отрисован', (await count('#eventsLog .badge.follow')) >= 1);

  // ---------- Зрители ----------
  await page.evaluate("require('electron').ipcRenderer.invoke('dev:viewers', { twitch: 111, youtube: 222, tiktok: 333 })");
  await sleep(300);
  const chips = await page.evaluate("[countTwitch.textContent, countYoutube.textContent, countTiktok.textContent]");
  check('счётчики в топбаре', chips.join(',') === '111,222,333', chips.join(','));

  // ---------- Исключения ----------
  check('в странице нет необработанных исключений', page.exceptions.length === 0,
    page.exceptions.join(' | '));

  const ok = summary();
  page.close();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
