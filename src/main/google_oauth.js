// ============================================================
// Google OAuth (Desktop app) для YouTube.
//
// Нужны Client ID и Client Secret из Google Cloud Console
// (тип приложения «Desktop app») и включённый YouTube Data API v3.
//
// Схема: локальный сервер на 127.0.0.1 принимает code, затем он
// меняется на access_token и refresh_token. Право:
// youtube.force-ssl — оно нужно и для чтения чата, и для отправки.
// ============================================================

const http = require('http');
const crypto = require('crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/youtube.force-ssl';

function exchange(params) {
  return fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

// Запуск браузера и ожидание кода на локальном порту
function startAuth({ clientId, clientSecret, openUrl, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(12).toString('hex');
    let settled = false;
    let timer = null;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch { /* уже закрыт */ }
      if (err) reject(err);
      else resolve(value);
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404).end('not found');
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');

      const page = (text) => `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
        <title>Aron Chat</title><style>body{background:#0b0d11;color:#e9e9ec;font-family:Segoe UI,sans-serif;
        display:grid;place-items:center;height:100vh;margin:0}div{text-align:center;max-width:420px}</style></head>
        <body><div><h2 style="color:#52e89d">Aron Chat</h2><p>${text}</p></div></body></html>`;

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Доступ отклонён. Закройте окно и попробуйте снова.'));
        finish(new Error(`Google отклонил доступ: ${error}`));
        return;
      }

      if (!code || gotState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Некорректный ответ. Попробуйте снова.'));
        finish(new Error('некорректный ответ Google (state/code)'));
        return;
      }

      try {
        const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
        const tokenRes = await exchange({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        });
        const data = await tokenRes.json();

        if (!tokenRes.ok || !data.access_token) {
          const message = data && (data.error_description || data.error) ? (data.error_description || data.error) : `HTTP ${tokenRes.status}`;
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Не удалось получить токен.'));
          finish(new Error(`Google: ${message}`));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(page('Вход выполнен. Можно закрыть это окно и вернуться в Aron Chat.'));
        finish(null, {
          accessToken: data.access_token,
          refreshToken: data.refresh_token || '',
          expiresIn: data.expires_in || 3600,
        });
      } catch (err) {
        finish(err);
      }
    });

    server.on('error', (err) => finish(new Error(`локальный сервер OAuth: ${err.message}`)));

    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
      const authUrl = `${AUTH_URL}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        state,
      })}`;

      try {
        openUrl(authUrl);
      } catch (err) {
        finish(new Error(`не удалось открыть браузер: ${err.message}`));
        return;
      }

      timer = setTimeout(() => finish(new Error('время ожидания входа истекло')), timeoutMs);
    });
  });
}

function refresh({ clientId, clientSecret, refreshToken }) {
  return exchange({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      throw new Error(`Google: ${data.error_description || data.error || `HTTP ${res.status}`}`);
    }
    return {
      accessToken: data.access_token,
      refreshToken: refreshToken,
      expiresIn: data.expires_in || 3600,
    };
  });
}

async function sendMessage({ accessToken, liveChatId, message }) {
  const res = await fetch('https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      snippet: {
        liveChatId,
        type: 'textMessageEvent',
        textMessageDetails: { messageText: String(message) },
      },
    }),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      detail = data.error && data.error.message ? data.error.message : detail;
    } catch { /* пусто */ }
    throw new Error(`YouTube: ${detail}`);
  }
  return { ok: true };
}

module.exports = { startAuth, refresh, sendMessage, SCOPES };
