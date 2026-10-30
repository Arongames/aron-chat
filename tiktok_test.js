// ============================================================
// Проверка модуля TikTok LIVE на фиктивном подключении.
//   node tiktok_test.js
// Реальной сети нет: подставляем класс коннектора через хук
// _setConnectorClass.
// ============================================================

const { EventEmitter } = require('events');

const TikTokLive = require('./src/main/tiktok');

const results = [];
function check(name, ok, extra = '') {
  results.push(ok);
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${extra ? ' — ' + extra : ''}`);
}

// ---------- Фиктивный WebcastPushConnection ----------
class FakeConnection extends EventEmitter {
  constructor(username, options) {
    super();
    FakeConnection.last = this;
    this.username = username;
    this.options = options;
    this.connectCalls = 0;
    this.disconnectCalls = 0;
  }

  async connect() {
    this.connectCalls++;
    // Флаг на классе: конструктор не должен его перетирать
    if (FakeConnection.failConnect) throw { description: 'Live start time not valid' };
    this.emit('connected');
    return { id: 1 };
  }

  async disconnect() {
    this.disconnectCalls++;
    this.emit('disconnected');
  }
}
FakeConnection.failConnect = false;

// Собираем события наружу: все наблюдаемые инстансы пишут в один массив,
// чтобы не зависеть от того, какой из них сейчас «активен».
const NAMES = ['message', 'follow', 'gift', 'like', 'member', 'status'];
const events = [];
function watch(live) {
  for (const n of NAMES) live.on(n, (p) => events.push({ n, p }));
  return live;
}

(async () => {
  TikTokLive._setConnectorClass(FakeConnection);
  const live = watch(new TikTokLive());

  // ═══════ 1. Имена событий наружу ═══════
  check('экспортируется класс', typeof TikTokLive === 'function');
  check('метод connect есть', typeof live.connect === 'function');
  check('метод disconnect есть', typeof live.disconnect === 'function');
  check('isConnected стартом false', live.isConnected() === false);
  check('username стартом пуст', live.username === null);

  // ═══════ 2. Подключение ═══════
  await live.connect('arongames');
  check('connect вызван', FakeConnection.last.connectCalls === 1);
  check('username сохранён', live.username === 'arongames');
  check('isConnected после connect', live.isConnected() === true);
  check('status connected=true отправлен',
    events.some((e) => e.n === 'status' && e.p.connected === true),
    JSON.stringify(events.filter((e) => e.n === 'status').map((e) => e.p)));

  // ═══════ 3. Снятие @ ═══════
  const live2 = watch(new TikTokLive());
  await live2.connect('@nickname_two');
  check('ник без @', live2.username === 'nickname_two', live2.username);

  // ═══════ 4. Опции подключения ═══════
  check('передан ник коннектору', FakeConnection.last.username === 'nickname_two');
  check('processInitialData включён', FakeConnection.last.options.processInitialData === true);
  check('fetchRoomInfoOnConnect выключен', FakeConnection.last.options.fetchRoomInfoOnConnect === false);

  // ═══════ 5. Повторное connect с тем же ником — без нового соединения ═══════
  const before = FakeConnection.last;
  await live2.connect('nickname_two');
  check('повторный connect того же ника — new连接 не создан', FakeConnection.last === before);

  // ═══════ 6. Сообщение чата (плоские поля legacy) ═══════
  events.length = 0;
  FakeConnection.last.emit('chat', { comment: 'Всем привет', uniqueId: 'ivan', nickname: 'Иван' });
  const msg = events.find((e) => e.n === 'message');
  check('message: есть', !!msg);
  check('message.user = uniqueId', msg && msg.p.user === 'ivan', msg && JSON.stringify(msg.p));
  check('message.text = comment', msg && msg.p.text === 'Всем привет');

  // ═══════ 7. Пустой comment игнорируется ═══════
  events.length = 0;
  FakeConnection.last.emit('chat', { comment: '   ', uniqueId: 'ghost' });
  FakeConnection.last.emit('chat', { uniqueId: 'ghost' });
  check('пустое сообщение не уходит в message', events.filter((e) => e.n === 'message').length === 0);

  // ═══════ 8. Нет uniqueId → nickname → «гость» ═══════
  events.length = 0;
  FakeConnection.last.emit('chat', { comment: 'Раз', nickname: 'Ник' });
  check('без uniqueId берётся nickname', events[0].p.user === 'Ник', JSON.stringify(events[0].p));
  events.length = 0;
  FakeConnection.last.emit('chat', { comment: 'Два' });
  check('без ника — «гость»', events[0].p.user === 'гость', JSON.stringify(events[0].p));

  // ═══════ 9. Обрезка текста ═══════
  events.length = 0;
  FakeConnection.last.emit('chat', { comment: '  пробелы  ', uniqueId: 'a' });
  check('текст обрезан', events[0].p.text === 'пробелы', JSON.stringify(events[0].p));

  // ═══════ 10. Подписка ═══════
  events.length = 0;
  FakeConnection.last.emit('follow', { uniqueId: 'peter', nickname: 'Петя' });
  const follow = events.find((e) => e.n === 'follow');
  check('follow: есть', !!follow);
  check('follow.user = uniqueId', follow && follow.p.user === 'peter');

  // ═══════ 11. Подарок: обычная серия ═══════
  events.length = 0;
  FakeConnection.last.emit('gift', {
    uniqueId: 'maria', giftName: 'Роза', repeatCount: 5, repeatEnd: true, totalCount: 5,
  });
  const gift = events.find((e) => e.n === 'gift');
  check('gift: есть', !!gift);
  check('gift.user', gift && gift.p.user === 'maria');
  check('gift.giftName', gift && gift.p.giftName === 'Роза');
  check('gift.count = repeatCount', gift && gift.p.count === 5, gift && JSON.stringify(gift.p));

  // ═══════ 12. Комбо: repeatEnd=false отбрасывается ═══════
  events.length = 0;
  FakeConnection.last.emit('gift', { uniqueId: 'maria', giftName: 'Роза', repeatCount: 1, repeatEnd: false });
  FakeConnection.last.emit('gift', { uniqueId: 'maria', giftName: 'Роза', repeatCount: 2, repeatEnd: false });
  FakeConnection.last.emit('gift', { uniqueId: 'maria', giftName: 'Роза', repeatCount: 3, repeatEnd: false });
  check('комбо-промежуточные не озвучиваются', events.filter((e) => e.n === 'gift').length === 0,
    String(events.length));
  FakeConnection.last.emit('gift', { uniqueId: 'maria', giftName: 'Роза', repeatCount: 4, repeatEnd: true });
  check('итог серии озвучен', events.filter((e) => e.n === 'gift').length === 1);
  check('итог серии с итоговым count', events[0].p.count === 4, JSON.stringify(events[0].p));

  // ═══════ 13. repeatEnd отсутствует (одиночный подарок) — проходим ═══════
  events.length = 0;
  FakeConnection.last.emit('gift', { uniqueId: 'x', giftName: 'Леденец', totalCount: 1 });
  check('подарок без repeatEnd — это событие', events.filter((e) => e.n === 'gift').length === 1);

  // ═══════ 14. count: каскад repeatCount → totalCount → count → 1 ═══════
  events.length = 0;
  FakeConnection.last.emit('gift', { uniqueId: 'x', giftName: 'A', count: 7, repeatEnd: true });
  check('count из count', events[0].p.count === 7, JSON.stringify(events[0].p));
  events.length = 0;
  FakeConnection.last.emit('gift', { uniqueId: 'x', giftName: 'A', repeatEnd: true });
  check('count по умолчанию 1', events[0].p.count === 1, JSON.stringify(events[0].p));

  // ═══════ 15. Имя подарка по умолчанию ═══════
  events.length = 0;
  FakeConnection.last.emit('gift', { uniqueId: 'x', repeatEnd: true });
  check('без giftName — «подарок»', events[0].p.giftName === 'подарок', JSON.stringify(events[0].p));

  // ═══════ 16. Лайк ═══════
  events.length = 0;
  FakeConnection.last.emit('like', { uniqueId: 'l', totalLikes: 42 });
  check('like: есть', events.some((e) => e.n === 'like'));
  check('like.totalLikes', events[0].p.totalLikes === 42, JSON.stringify(events[0].p));

  // ═══════ 17. Вход в эфир ═══════
  events.length = 0;
  FakeConnection.last.emit('member', { uniqueId: 'new', nickname: 'Новый' });
  check('member: есть', events.some((e) => e.n === 'member'));
  check('member.user', events[0].p.user === 'new');

  // ═══════ 18. Ошибки: без [object Object] ═══════
  events.length = 0;
  FakeConnection.last.emit('error', { description: 'invalid user', code: 404 });
  const errStatus = events.find((e) => e.n === 'status' && e.p.connected === false);
  check('error → status connected=false', !!errStatus);
  check('текст ошибки читаемый', errStatus && !/\[object Object\]/.test(errStatus.p.text),
    errStatus && errStatus.p.text);
  check('текст ошибки содержит исходное описание', errStatus && /invalid user/.test(errStatus.p.text),
    errStatus && errStatus.p.text);

  events.length = 0;
  FakeConnection.last.emit('error', new Error('обычная ошибка'));
  check('Error-объект обработан', /обычная ошибка/.test(events[0].p.text), events[0].p.text);

  events.length = 0;
  FakeConnection.last.emit('error', 'строковая ошибка');
  check('строка ошибки обработана', /строковая ошибка/.test(events[0].p.text), events[0].p.text);

  // ═══════ 19. streamEnd ═══════
  events.length = 0;
  FakeConnection.last.emit('streamEnd');
  check('streamEnd → status connected=false',
    events.some((e) => e.n === 'status' && e.p.connected === false && /завершена/i.test(e.p.text)),
    JSON.stringify(events.map((e) => e.p)));
  check('streamEnd: isConnected false', live2.isConnected() === false);

  // ═══════ 20. Отключение ═══════
  const conn = FakeConnection.last;
  await live2.connect('nickname_two');
  live2.disconnect();
  check('disconnect вызван у коннектора', conn.disconnectCalls >= 1);
  check('после disconnect isConnected false', live2.isConnected() === false);
  check('после disconnect connection=null', live2.connection === null);

  // ═══════ 21. Ошибка connect ═══════
  const live3 = watch(new TikTokLive());
  FakeConnection.failConnect = true;
  let thrown = null;
  try { await live3.connect('bad_stream'); } catch (err) { thrown = err; }
  check('connect бросает ошибку', thrown instanceof Error);
  check('ошибка connect читаемая', thrown && /Live start time not valid/.test(thrown.message),
    thrown && thrown.message);
  check('после сбоя isConnected false', live3.isConnected() === false);
  check('после сбоя connection снят', live3.connection === null);
  FakeConnection.failConnect = false;

  // ═══════ 22. Пустой ник ═══════
  const live4 = watch(new TikTokLive());
  let emptyErr = null;
  try { await live4.connect(''); } catch (err) { emptyErr = err; }
  check('пустой ник → ошибка', emptyErr && /никнейм/i.test(emptyErr.message), emptyErr && emptyErr.message);
  try { await live4.connect('@   '); } catch (err) { emptyErr = err; }
  check('ник из одного @ → ошибка', emptyErr && /никнейм/i.test(emptyErr.message));

  // ═══════ 23. Смена ника переподключает ═══════
  const live5 = watch(new TikTokLive());
  await live5.connect('first');
  const c1 = FakeConnection.last;
  await live5.connect('second');
  check('смена ника создаёт новое соединение', FakeConnection.last !== c1);
  check('смена ника: username обновлён', live5.username === 'second');

  // ═══════ 24. disconnect без подключения не падает ═══════
  const live6 = watch(new TikTokLive());
  let ok = true;
  try { live6.disconnect(); } catch { ok = false; }
  check('disconnect без connect не падает', ok);

  const failed = results.filter((r) => !r).length;
  console.log(`\n=== ${results.length - failed}/${results.length} проверок пройдено ===`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('[FAIL] исключение:', err && err.stack ? err.stack : err);
  process.exit(1);
});
