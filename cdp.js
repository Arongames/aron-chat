// ============================================================
// Общая обвязка CDP-проверок: подключение к окну Aron Chat
// и выполнение JS в нём. Используется скриптами *_check.js.
//   const cdp = require('./cdp'); const page = await cdp.open(9222);
//   await page.eval('1+1');  page.close();
// ============================================================

const http = require('http');
const WebSocket = require('ws');

function getTargets(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

async function open(port = 9222) {
  const targets = await getTargets(port);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('страница приложения не найдена (порт ' + port + ')');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, (msg) => {
        if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
        resolve(msg.result);
      });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  // eval — обычный вызов, evalAsync — с awaitPromise (для промисов)
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error('исключение в странице: '
        + (result.exceptionDetails.exception && result.exceptionDetails.exception.message
          || result.exceptionDetails.text));
    }
    return result.result.value;
  };

  // Установка размера окна (для проверок узкой раскладки)
  const setViewport = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    await evaluate('new Promise(r => requestAnimationFrame(() => setTimeout(r, 120)))', true);
  };

  const clearViewport = () => send('Emulation.clearDeviceMetricsOverride', {});

  // Собираем необработанные исключения страницы (Runtime.exceptionThrown)
  const exceptions = [];
  await send('Runtime.enable');
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push((d.exception && (d.exception.description || d.exception.message)) || d.text);
    }
  });

  return {
    evaluate,
    setViewport,
    clearViewport,
    exceptions,
    close: () => ws.close(),
  };
}

// Сборщик проверок
function collector() {
  const results = [];
  return {
    check(name, ok, extra = '') {
      results.push(ok);
      console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${extra ? ' — ' + extra : ''}`);
    },
    summary() {
      const failed = results.filter((r) => !r).length;
      console.log(`\n=== ${results.length - failed}/${results.length} проверок пройдено ===`);
      return failed === 0;
    },
  };
}

module.exports = { open, collector };
