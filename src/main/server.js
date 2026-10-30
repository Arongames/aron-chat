// ============================================================
// Локальный сервер оверлея для OBS.
//
//   HTTP  — раздаёт HTML/CSS/JS оверлея по /overlay
//   WS    — транслирует чат, события и счётчики зрителей
//           в Browser Source OBS (и в живой предпросмотр окна).
//
// Сервер слушает ТОЛЬКО 127.0.0.1: посторонний в локальной сети не
// сможет подключиться к оверлею (в 1.7.0 он был открыт наружу).
// Порт по умолчанию 3000; если занят — пробуем следующие 10.
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const OVERLAY_DIR = path.join(__dirname, '../overlay');
const FONTS_DIR = path.join(__dirname, '../../assets/fonts');
const HOST = '127.0.0.1';
const PORT_RANGE = 10;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

// getSettings — колбэк, возвращающий актуальные настройки оверлея
// (позиция, масштаб, что показывать). Оверлей получает их в hello.
function createOverlayServer(getSettings, getViewers, getExtras, getCustomCss) {
  let httpServer = null;
  let wss = null;
  let currentPort = null;
  let starting = null;

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  function serveStatic(req, res) {
    let urlPath;
    try {
      urlPath = decodeURIComponent(String(req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }

    if (urlPath === '/' || urlPath === '/overlay' || urlPath === '/overlay/chat') {
      urlPath = '/overlay.html';
    } else if (urlPath === '/overlay/viewers') {
      urlPath = '/viewers.html';
    }

    // Пользовательский CSS виджета отдаём отдельным адресом
    if (urlPath === '/custom.css') {
      const widget = /widget=viewers/.test(String(req.url || '')) ? 'viewers' : 'chat';
      const css = typeof getCustomCss === 'function' ? getCustomCss(widget) : '';
      res.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(css || '/* пользовательский CSS не задан */');
      return;
    }

    // Шрифты лежат в assets/fonts — отдаём их оверлею отдельным префиксом
    let root = OVERLAY_DIR;
    if (urlPath.startsWith('/fonts/')) {
      root = FONTS_DIR;
      urlPath = urlPath.slice('/fonts'.length);
    }

    // Нормализуем и не выпускаем за пределы выбранной папки
    const filePath = path.normalize(path.join(root, urlPath));
    if (!filePath.startsWith(root + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404: файл не найден');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        // OBS не должен кэшировать оверлей между перезапусками
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  }

  function broadcast(payload) {
    if (!wss) return;
    const raw = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(raw);
    }
  }

  // Порт фиксированный: ссылки для OBS не должны меняться.
  // Если порт занят — ждём освобождения (перезапуск приложения), затем
  // показываем понятную ошибку вместо тихого переезда на другой порт.
  function listen(server, port, attempt = 0) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempt < 20) {
          setTimeout(() => {
            listen(server, port, attempt + 1).then(resolve, reject);
          }, 250);
          return;
        }
        if (err.code === 'EADDRINUSE') {
          reject(new Error(
            `порт ${port} занят. Закройте другую копию Aron Chat `
            + 'или укажите другой порт в настройках оверлея.'
          ));
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, HOST);
    });
  }

  async function start(preferredPort = 3000) {
    if (currentPort) return { ok: true, port: currentPort, url: getUrl() };
    if (starting) return starting;

    starting = (async () => {
      const server = http.createServer(serveStatic);
      const socketServer = new WebSocketServer({ server });
      socketServer.on('error', () => { /* не роняем процесс из-за WS */ });

      socketServer.on('connection', (socket) => {
        // Сразу отдаём настройки, счётчики и эмоуты, чтобы виджет
        // отрисовался без мигания и без ожидания первого опроса
        try {
          const extras = typeof getExtras === 'function' ? getExtras() : null;
          socket.send(JSON.stringify({
            type: 'hello',
            settings: getSettings(),
            viewers: typeof getViewers === 'function' ? getViewers() : null,
            emotes: (extras && extras.emotes) || null,
          }));
        } catch { /* клиент уже отвалился */ }
      });

      const port = await listen(server, Math.min(65535, Math.max(1024, preferredPort)));
      httpServer = server;
      wss = socketServer;
      currentPort = port;
      return { ok: true, port, url: getUrl() };
    })();

    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  function stop() {
    return new Promise((resolve) => {
      if (wss) {
        for (const client of wss.clients) {
          try { client.terminate(); } catch { /* уже закрыт */ }
        }
        try { wss.close(); } catch { /* уже закрыт */ }
      }
      wss = null;

      if (!httpServer || !currentPort) {
        httpServer = null;
        currentPort = null;
        resolve();
        return;
      }
      const server = httpServer;
      httpServer = null;
      currentPort = null;
      server.close(() => resolve());
      // close() ждёт keep-alive соединения; через секунду добиваем
      setTimeout(resolve, 1000);
    });
  }

  async function restart(preferredPort) {
    await stop();
    return start(preferredPort);
  }

  function getUrl() {
    return currentPort ? `http://${HOST}:${currentPort}/overlay/chat` : null;
  }

  function isRunning() {
    return !!currentPort;
  }

  // Сообщаем подключённым оверлеям об изменении настроек
  function pushSettings(settings) {
    broadcast({ type: 'settings', settings });
  }

  return { start, stop, restart, broadcast, pushSettings, getUrl, getPort: () => currentPort, isRunning };
}

module.exports = createOverlayServer;
