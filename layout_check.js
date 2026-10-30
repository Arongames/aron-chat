// Layout-проверки: все нужные элементы существуют и видимы.
//   node layout_check.js [порт]
const { open, collector } = require('./cdp');

(async () => {
  const page = await open(Number(process.argv[2]) || 9222);
  const { check, summary } = collector();

  const dom = await page.evaluate(`(() => {
    const sel = (id) => !!document.getElementById(id);
    const all = (cls) => document.querySelectorAll(cls).length;
    return {
      // Сайдбар
      sidebar: !!document.querySelector('.sidebar'),
      navItems: all('.nav-item'),
      brand: !!document.querySelector('.brand'),
      version: !!document.getElementById('appVersion'),
      // Топбар
      topbar: !!document.querySelector('.topbar'),
      chips: all('.chip'),
      tiktokChip: !!document.querySelector('.chip.tiktok'),
      twitchChip: !!document.querySelector('.chip.twitch'),
      youtubeChip: !!document.querySelector('.chip.youtube'),
      speechifyChip: !!document.querySelector('.chip.speechify'),
      dotTiktok: sel('dotTiktok'), dotKey: sel('dotKey'),
      dotTwitch: sel('dotTwitch'), dotYoutube: sel('dotYoutube'),
      statusTiktok: sel('statusTiktok'), statusKey: sel('statusKey'),
      statusTwitch: sel('statusTwitch'), statusYoutube: sel('statusYoutube'),
      ttsTest: sel('btnTtsTest'),
      // Чат
      chatTab: sel('chat-tab'),
      chatLayout: !!document.querySelector('.chat-layout'),
      chatPanel: !!document.querySelector('.chat-panel'),
      chatLog: sel('chatLog'),
      eventPanel: !!document.querySelector('.events-panel'),
      eventLog: sel('eventLog'),
      chatCount: sel('chatCount'), eventCount: sel('eventCount'),
      // Настройки
      settingsTab: sel('settings-tab'),
      settingsGrid: !!document.querySelector('.settings-grid'),
      configCards: document.querySelectorAll('#settings-tab .config-card').length,
      // Коннект: три площадки
      tiktokUsername: sel('tiktokUsername'),
      btnTiktokConnect: sel('btnTiktokConnect'),
      btnTiktokDisconnect: sel('btnTiktokDisconnect'),
      twitchChannel: sel('twitchChannel'),
      btnTwitchConnect: sel('btnTwitchConnect'),
      btnTwitchDisconnect: sel('btnTwitchDisconnect'),
      youtubeChannel: sel('youtubeChannel'),
      youtubeApiKey: sel('youtubeApiKey'),
      youtubeAutoReconnect: sel('youtubeAutoReconnect'),
      btnYoutubeConnect: sel('btnYoutubeConnect'),
      btnYoutubeDisconnect: sel('btnYoutubeDisconnect'),
      speechifyKey: sel('speechifyKey'),
      btnToggleKey: sel('btnToggleKey'),
      configPath: sel('configPath'),
      btnRevealConfig: sel('btnRevealConfig'),
      // Озвучка
      voiceId: sel('voiceId'), voiceList: sel('voiceList'),
      modelSelect: sel('modelSelect'),
      languageSelect: sel('languageSelect'),
      speakUsername: sel('speakUsername'),
      speakFollows: sel('speakFollows'),
      speakGifts: sel('speakGifts'),
      ignoredPrefixes: sel('ignoredPrefixes'),
      // Команды
      commandsBody: sel('commandsBody'),
      newTrigger: sel('newTrigger'),
      newResponse: sel('newResponse'),
      newDescription: sel('newDescription'),
      btnAddCommand: sel('btnAddCommand'),
      btnSave: sel('btnSave'),
      saveStatus: sel('saveStatus'),
      // О программе
      aboutTab: sel('about-tab'),
      aboutVersion: sel('aboutVersion'),
      // Кода
      kodaFrame: !!document.querySelector('.koda-frame'),
      kodaHero: !!document.querySelector('.koda-frame--hero'),
      kodaSide: !!document.querySelector('.koda-frame--side'),
      // Нижняя панель: выбор площадки иконками
      controlBar: !!document.querySelector('.control-bar'),
      platformPicker: sel('platformPicker'),
      platformTrigger: sel('platformTrigger'),
      platformOptions: document.querySelectorAll('.platform-option').length,
      platformIcon: sel('platformIcon'),
      manualInput: sel('manualInput'),
      btnSend: sel('btnSend'),
      // Удалённые элементы: локальный TTS и OBS (проверка по HTML-строке,
      // в querySelector такие селекторы невалидны)
      noTtsEngine: !document.getElementById('ttsEngine'),
      html: document.documentElement.innerHTML,
    };
  })()`);

  check('сайдбар', dom.sidebar);
  check('навигация: 3 вкладки', dom.navItems === 3, String(dom.navItems));
  check('бренд', dom.brand);
  check('версия в сайдбаре', dom.version);
  check('топбар', dom.topbar);
  check('чипы: 4 (TikTok+Twitch+YouTube+Speechify)', dom.chips === 4, String(dom.chips));
  check('чип TikTok', dom.tiktokChip);
  check('чип Twitch', dom.twitchChip);
  check('чип YouTube', dom.youtubeChip);
  check('чип Speechify', dom.speechifyChip);
  check('dot: TikTok/Twitch/YouTube/Key',
    dom.dotTiktok && dom.dotTwitch && dom.dotYoutube && dom.dotKey);
  check('status: TikTok/Twitch/YouTube/Key',
    dom.statusTiktok && dom.statusTwitch && dom.statusYoutube && dom.statusKey);
  check('кнопка проверки озвучки', dom.ttsTest);
  check('вкладка чата', dom.chatTab);
  check('layout чата', dom.chatLayout);
  check('панель чата', dom.chatPanel);
  check('лента чата', dom.chatLog);
  check('панель событий', dom.eventPanel);
  check('лента событий', dom.eventLog);
  check('счётчики', dom.chatCount && dom.eventCount);
  check('вкладка настроек', dom.settingsTab);
  check('настройки: сетка', dom.settingsGrid);
  check('карточки настроек: 5 (tiktok/twitch/youtube/speechify/commands)',
    dom.configCards === 5, String(dom.configCards));
  check('никнейм TikTok', dom.tiktokUsername);
  check('кнопка подключения TikTok', dom.btnTiktokConnect);
  check('кнопка отключения TikTok', dom.btnTiktokDisconnect);
  check('канал Twitch', dom.twitchChannel);
  check('кнопка подключения Twitch', dom.btnTwitchConnect);
  check('кнопка отключения Twitch', dom.btnTwitchDisconnect);
  check('канал YouTube', dom.youtubeChannel);
  check('API-ключ YouTube', dom.youtubeApiKey);
  check('чекбокс авто-реконнекта YouTube', dom.youtubeAutoReconnect);
  check('кнопка подключения YouTube', dom.btnYoutubeConnect);
  check('кнопка отключения YouTube', dom.btnYoutubeDisconnect);
  check('поле ключа Speechify', dom.speechifyKey);
  check('кнопка показа ключа', dom.btnToggleKey);
  check('путь конфига', dom.configPath);
  check('кнопка открытия конфига', dom.btnRevealConfig);
  check('voice_id', dom.voiceId);
  check('datalist голосов', dom.voiceList);
  check('селектор модели', dom.modelSelect);
  check('селектор языка', dom.languageSelect);
  check('чекбоксы озвучки', dom.speakUsername && dom.speakFollows && dom.speakGifts);
  check('игнорируемые префиксы', dom.ignoredPrefixes);
  check('таблица команд', dom.commandsBody);
  check('поля новой команды', dom.newTrigger && dom.newResponse && dom.newDescription);
  check('кнопка добавить', dom.btnAddCommand);
  check('кнопка сохранить', dom.btnSave);
  check('статус сохранения', dom.saveStatus);
  check('вкладка О программе', dom.aboutTab);
  check('версия в О программе', dom.aboutVersion);
  check('плашка-рамка Koda', dom.kodaFrame);
  check('плашка Koda hero', dom.kodaHero);
  check('плашка Koda side', dom.kodaSide);
  check('нижняя панель', dom.controlBar);
  check('пикер площадки (иконки, без названий)', dom.platformPicker && dom.platformTrigger);
  check('три опции площадки', dom.platformOptions === 3, String(dom.platformOptions));
  check('иконка активной площадки', dom.platformIcon);
  check('поле ввода', dom.manualInput);
  check('кнопка отправки', dom.btnSend);
  check('нет селектора движка TTS', dom.noTtsEngine);
  check('нет XTTS', !/xtts/i.test(dom.html));
  check('нет localhost:7860', !dom.html.includes('localhost:7860'));
  check('нет OBS-оверлея', !/obs-websocket|OBS-оверлей/i.test(dom.html));

  const ok = summary();
  page.close();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
