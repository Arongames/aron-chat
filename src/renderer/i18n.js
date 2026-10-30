// Первый проход локализации: статические подписи основных экранов.
// Динамические статусы и логи пока остаются на русском.

(function () {
  const RU_TO_EN = {
    'Чат трансляции': 'Live chat',
    'Язык интерфейса': 'Interface language',
    'Русский': 'Russian',
    'Сохранить': 'Save',
    'Сбросить': 'Reset',
    'Есть несохранённые изменения': 'Unsaved changes',
    'Все изменения сохранены': 'All changes saved',
    'API-ключ Speechify не задан — озвучка недоступна. Введите ключ на вкладке «Настройки».': 'Speechify API key is not set — voice is unavailable. Enter the key in Settings.',
    'Сообщение отправлено': 'Message sent',
    'Обновлений нет': 'No updates',
    'Вы вышли из Google': 'Signed out of Google',
    'Вы вышли из DonationAlerts': 'Signed out of DonationAlerts',
    'DonationAlerts подключён': 'DonationAlerts connected',
    'Скачивание…': 'Downloading…',
    'Запускаю установщик…': 'Launching installer…',
    'Проверяю…': 'Checking…',
    'Откройте браузер и подтвердите доступ Google': 'Open the browser and confirm Google access',
    'Откройте браузер и подтвердите доступ DonationAlerts': 'Open the browser and confirm DonationAlerts access',
    'Настройки': 'Settings',
    'ключ не задан': 'key not set',
    'Проверить озвучку': 'Test voice',
    'Оверлей': 'Overlay',
    'Чат': 'Chat',
    'Автопрокрутка': 'Auto-scroll',
    'Здесь появятся сообщения TikTok, Twitch и YouTube': 'Messages from TikTok, Twitch and YouTube will appear here',
    'Отправить': 'Send',
    'События': 'Events',
    'Здесь появятся лайки, подписки и подарки': 'Likes, subscriptions and gifts will appear here',
    'Оверлей чата': 'Chat overlay',
    'Browser Source — чат': 'Browser Source — chat',
    'Копировать': 'Copy',
    'Открыть в браузере': 'Open in browser',
    'Позиция': 'Position',
    'Слева снизу': 'Bottom left',
    'Слева сверху': 'Top left',
    'Справа снизу': 'Bottom right',
    'Справа сверху': 'Top right',
    'Масштаб, %': 'Scale, %',
    'Сообщений в ленте': 'Messages in feed',
    'Скрывать через, сек (0 — нет)': 'Hide after, sec (0 — off)',
    'Показывать события': 'Show events',
    'Подписки, подарки, входы': 'Subscriptions, gifts, joins',
    'Пресеты вида': 'Appearance presets',
    'Компактный': 'Compact',
    'Крупный': 'Large',
    'Только донаты': 'Donations only',
    'Свой CSS для чат-оверлея': 'Custom CSS for chat overlay',
    'Применяется после сохранения и обновления превью.': 'Applied after saving and refreshing the preview.',
    'Оверлей выключен': 'Overlay is off',
    'Оверлей зрителей': 'Viewers overlay',
    'Виджет включён': 'Widget enabled',
    'Отдавать счётчики отдельной страницей': 'Serve viewer counters on a separate page',
    'Browser Source — зрители': 'Browser Source — viewers',
    'Мелкий': 'Small',
    'Свой CSS для виджета зрителей': 'Custom CSS for viewers widget',
    'Виджет выключен': 'Widget is off',
    'Сервер оверлеев': 'Overlay server',
    'Оверлей включён': 'Overlay enabled',
    'Поднимать сервер при запуске': 'Start server on launch',
    'Порт': 'Port',
    'Перезапустить сервер': 'Restart server',
    'Обновить превью': 'Refresh preview',
    'Сервер слушает только 127.0.0.1 — доступен лишь на этом компьютере.': 'The server listens on 127.0.0.1 only — available on this computer.',
    'Разделы': 'Sections',
    'Площадки': 'Platforms',
    'Озвучка': 'Voice',
    'Фильтры': 'Filters',
    'Зрители': 'Viewers',
    'Доступ': 'Access',
    'Команды': 'Commands',
    'Данные': 'Data',
    'Чат и оформление': 'Chat & appearance',
    'Размер текста чата, px': 'Chat text size, px',
    'Значки платформ, px': 'Platform icons, px',
    'Значки платформ справа': 'Platform icons on the right',
    'Крупные логотипы площадок у каждого сообщения': 'Large platform logos for every message',
    'Акцентный цвет': 'Accent color',
    'Мята (по умолчанию)': 'Mint (default)',
    'Фиолетовый': 'Violet',
    'Синий': 'Blue',
    'Розовый': 'Pink',
    'Янтарный': 'Amber',
    'Применяется к ленте приложения и к оверлею. Быстро менять размер можно кнопками A−/A+ в шапке чата.': 'Applies to the app feed and overlay. Use A−/A+ in the chat header for quick size changes.',
    'Никнейм трансляции (без @)': 'Live username (without @)',
    'Подключить': 'Connect',
    'Отключить': 'Disconnect',
    'Канал (без #)': 'Channel (without #)',
    'Client ID для счётчика и входа уже встроен — менять не нужно.': 'Client ID for viewer count and login is built in — no need to change.',
    'Канал (@handle, UC… или ссылка)': 'Channel (@handle, UC… or link)',
    'API-ключ Data API v3': 'Data API v3 key',
    'Активный эфир (автоматически)': 'Active stream (automatic)',
    'Авто-переподключение': 'Auto-reconnect',
    'Находить новый эфир сам': 'Find new streams automatically',
    'Движок озвучки': 'Voice engine',
    'Speechify — облако, нужен ключ': 'Speechify — cloud, key required',
    'Piper — офлайн, без ключа': 'Piper — offline, no key',
    'Выключено': 'Disabled',
    'API-ключ Speechify': 'Speechify API key',
    'Ключ хранится только в вашем config.json и не вшивается в приложение.': 'The key is stored only in your config.json and is not embedded in the app.',
    'Голос Speechify': 'Speechify voice',
    'Для русского доступны alexei и agrippina.': 'alexei and agrippina are available for Russian.',
    'Модель': 'Model',
    'Язык': 'Language',
    'Голос Piper': 'Piper voice',
    'Нейроголос вшит в приложение: интернет и ключи не нужны.': 'The neural voice is bundled: no internet or keys required.',
    'Скорость речи:': 'Speech rate:',
    'Громкость:': 'Volume:',
    'Озвучивать имя автора': 'Speak author name',
    '«Ник говорит: текст»': '"Nick says: text"',
    'Озвучивать подписки': 'Speak subscriptions',
    '«Ник подписался!»': '"Nick subscribed!"',
    'Озвучивать подарки': 'Speak gifts',
    'Итог серии, без комбо-спама': 'Series total, no combo spam',
    'Фильтры озвучки': 'Voice filters',
    'Фильтровать сообщения перед озвучкой': 'Filter messages before speaking',
    'В чате и оверлее они остаются видимыми': 'They remain visible in chat and overlay',
    'Игнорируемые префиксы': 'Ignored prefixes',
    'Игнорируемые пользователи (боты)': 'Ignored users (bots)',
    'Игнорируемые слова и фразы': 'Ignored words and phrases',
    'Сравнение без учёта регистра. Команды обрабатываются раньше фильтров.': 'Case-insensitive. Commands are processed before filters.',
    'Полностью скрыть пользователей (нет в ленте и оверлее)': 'Hide users completely (not in feed or overlay)',
    'Показывать эмоуты': 'Show emotes',
    '7TV, BTTV и FFZ вместо текста': '7TV, BTTV and FFZ instead of text',
    'Показывать аватары': 'Show avatars',
    'YouTube, Twitch и TikTok': 'YouTube, Twitch and TikTok',
    'Считать зрителей': 'Count viewers',
    'Опрос раз в 30 секунд': 'Poll every 30 seconds',
    'Нужен Client ID на карточке площадки': 'Client ID required on the platform card',
    'Без OAuth — просмотры эфира': 'No OAuth — stream views',
    'Приблизительно, из данных комнаты': 'Approximate, from room data',
    'Доступ и отправка сообщений': 'Access and message sending',
    'Вход не выполнен': 'Not signed in',
    'Войти через Twitch': 'Sign in with Twitch',
    'Выйти': 'Sign out',
    'Код:': 'Code:',
    '· подтвердите на': '· confirm at',
    'Используется Client ID с карточки площадок. Пароль вводится только на twitch.tv.': 'Uses the Client ID from the platforms card. Password is entered on twitch.tv only.',
    'Ключи приложения уже встроены — достаточно нажать «Войти».': 'App keys are built in — just press "Sign in".',
    'Войти через Google': 'Sign in with Google',
    'Донаты в ленту, окно событий, оверлей и озвучку.': 'Donations to the feed, events window, overlay and voice.',
    'Войти через DonationAlerts': 'Sign in with DonationAlerts',
    'Принимать донаты': 'Accept donations',
    'Показывать в ленте и оверлее': 'Show in feed and overlay',
    'Озвучивать донаты': 'Speak donations',
    'Читать сумму и сообщение': 'Read amount and message',
    'Продвинутые настройки: свои OAuth-ключи': 'Advanced: your own OAuth keys',
    'По умолчанию используются встроенные ключи приложения — трогать эти поля не нужно.': 'Built-in app keys are used by default — no need to touch these fields.',
    'Кастомные команды': 'Custom commands',
    'Добавить': 'Add',
    'Файл настроек': 'Settings file',
    'Открыть папку': 'Open folder',
    'Экспорт настроек': 'Export settings',
    'Импорт настроек': 'Import settings',
    'Версия': 'Version',
    'Разработчик: SGR (StreamRateGame)': 'Developer: SGR (StreamRateGame)',
    'Обновления': 'Updates',
    'Проверка ещё не выполнялась': 'No update check yet',
    'Проверить обновления': 'Check for updates',
    'Скачать': 'Download',
    'Что нового': 'What\'s new',
    'Открыть лог': 'Open log',
    'Проверять при запуске': 'Check on launch',
    'Раз в запуск, без автоматического скачивания': 'Once per launch, no automatic download',
    'Свой адрес проверки': 'Custom check URL',
    'URL latest.json или GitHub API': 'latest.json URL or GitHub API',
    'По умолчанию — последний релиз GitHub Arongames/aron-chat.': 'Default: latest GitHub release Arongames/aron-chat.',
    'Поддержать проект': 'Support the project',
    'Поддержать на DonationAlerts': 'Support on DonationAlerts',
    'Что умеет': 'Features',
    'Скачать и установить': 'Download and install',
    'Позже': 'Later',
    'Доступно обновление': 'Update available',
    'у вас': 'you have',
    'Проверяю…': 'Checking…',
    'Скачивание…': 'Downloading…',
    'Запускаю установщик…': 'Launching installer…',
  };

  const EN_TO_RU = Object.fromEntries(
    Object.entries(RU_TO_EN).map(([ru, en]) => [en, ru])
  );

  // Динамические строки с параметрами: переводятся по шаблонам.
  const DYNAMIC_EN = [
    [/^Вход выполнен: (.+)$/, 'Signed in: $1'],
    [/^Не отправлено: (.+)$/, 'Not sent: $1'],
    [/^Настройки сохранены: (.+)$/, 'Settings saved: $1'],
    [/^Ошибка сохранения: (.+)$/, 'Save error: $1'],
    [/^Пользователь (.+) скрыт$/, 'User $1 hidden'],
    [/^Не удалось скрыть: (.+)$/, 'Could not hide: $1'],
    [/^Код (.+) — подтвердите на (.+)$/, 'Code $1 — confirm at $2'],
    [/^(.+): (.+) подключён$/, '$1: $2 connected'],
    [/^(.+): чат отключён$/, '$1: chat disconnected'],
    [/^Скачивание… (\d+)% \((.+) МБ\)$/, 'Downloading… $1% ($2 MB)'],
    [/^Скачивание… (.+) МБ$/, 'Downloading… $1 MB'],
    [/^У вас последняя версия \((.+)\)$/, 'You are up to date ($1)'],
    [/^Доступно обновление (.+)$/, 'Update available $1'],
    [/^Проверка через (\d+) с \(попытка (\d+)\)$/, 'Checking in $1 s (attempt $2)'],
    [/^Эфира нет\. Проверка через (\d+) с \(попытка (\d+)\)$/, 'No stream. Checking in $1 s (attempt $2)'],
    [/^Подключаю…$/, 'Connecting…'],
    [/^Озвучиваю…$/, 'Speaking…'],
    [/^Озвучка выключена$/, 'Voice is off'],
    [/^Настройки импортированы$/, 'Settings imported'],
    [/^Изменения отменены$/, 'Changes discarded'],
    [/^CSS чат-оверлея сохранён$/, 'Chat overlay CSS saved'],
    [/^CSS виджета зрителей сохранён$/, 'Viewers widget CSS saved'],
    [/^Сервер оверлеев перезапущен: (.+)$/, 'Overlay server restarted: $1'],
    [/^Пресет «(.+)» применён$/, 'Preset "$1" applied'],
    [/^Адрес (.+) скопирован$/, 'Address $1 copied'],
    [/^Настройки экспортированы: (.+)$/, 'Settings exported: $1'],
    [/^Экспорт не удался: (.+)$/, 'Export failed: $1'],
    [/^Импорт не удался: (.+)$/, 'Import failed: $1'],
    [/^Ошибка воспроизведения: (.+)$/, 'Playback error: $1'],
    [/^Сообщение скопировано$/, 'Message copied'],
  ];

  function translateDynamicEn(value) {
    for (const [re, replacement] of DYNAMIC_EN) {
      if (re.test(value)) return value.replace(re, replacement);
    }
    return value;
  }

  const ATTR_RU_TO_EN = {
    'Поиск по настройкам': 'Search settings',
    'Ник и Enter': 'Nick and Enter',
    'Слово или фраза': 'Word or phrase',
    'Префикс': 'Prefix',
    'Сообщение в чат площадки — Enter': 'Message to platform chat — Enter',
    'Куда отправить': 'Where to send',
  };
  const ATTR_EN_TO_RU = Object.fromEntries(
    Object.entries(ATTR_RU_TO_EN).map(([ru, en]) => [en, ru])
  );

  function translateValue(value, map) {
    const lead = value.match(/^\s*/)[0];
    const trail = value.match(/\s*$/)[0];
    const key = value.trim();
    if (!key) return value;
    let translated = map[key] || key;
    if (map === RU_TO_EN) translated = translateDynamicEn(translated);
    return translated === key ? value : `${lead}${translated}${trail}`;
  }

  function applyI18n(lang) {
    const toEn = lang === 'en';
    const textMap = toEn ? RU_TO_EN : EN_TO_RU;
    const attrMap = toEn ? ATTR_RU_TO_EN : ATTR_EN_TO_RU;

    document.documentElement.lang = lang;

    const skip = (node) => {
      const parent = node.parentElement;
      if (!parent) return true;
      if (/^(SCRIPT|STYLE|TEXTAREA|INPUT|CODE|PRE)$/.test(parent.tagName)) return true;
      return !!parent.closest('#chatLog, #eventsLog, .terms-box');
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return skip(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      node.nodeValue = translateValue(node.nodeValue, textMap);
    });

    document.querySelectorAll('[placeholder], [title], [aria-label]').forEach((el) => {
      ['placeholder', 'title', 'aria-label'].forEach((attr) => {
        const value = el.getAttribute(attr);
        if (!value) return;
        const translated = attrMap[value.trim()];
        if (translated) {
          el.setAttribute(attr, value.replace(value.trim(), translated));
        }
      });
    });
  }

  window.applyI18n = applyI18n;
  window.i18nT = (ru) => (document.documentElement.lang === 'en' ? (RU_TO_EN[ru] || ru) : ru);

  // Динамические элементы, добавленные после переключения языка:
  // переводим точные совпадения из словаря (статусы, тосты, подписи).
  let currentLang = 'ru';
  const originalApply = applyI18n;
  window.applyI18n = (lang) => {
    currentLang = lang;
    originalApply(lang);
  };

  const translateAdded = (root) => {
    if (currentLang !== 'en' || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (/^(SCRIPT|STYLE|TEXTAREA|INPUT|CODE|PRE)$/.test(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest('#chatLog, #eventsLog, .terms-box')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      node.nodeValue = translateValue(node.nodeValue, RU_TO_EN);
    });
  };

  const observer = new MutationObserver((mutations) => {
    if (currentLang !== 'en') return;
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          node.nodeValue = translateValue(node.nodeValue, RU_TO_EN);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          translateAdded(node);
        }
      });
    }
  });

  window.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
