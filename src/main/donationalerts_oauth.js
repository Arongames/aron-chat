// ============================================================
// DonationAlerts OAuth + API.
//
// Авторизация: authorization code + локальный redirect URI
// http://127.0.0.1:17342/da-callback (должен быть указан в приложении DA).
// ============================================================

const http = require('http');
const crypto = require('crypto');

const AUTH_URL = 'https://www.donationalerts.com/oauth/authorize';
const TOKEN_URL = 'https://www.donationalerts.com/oauth/token';
const API_BASE = 'https://www.donationalerts.com/api/v1';
const SCOPES = 'oauth-user-show oauth-donation-index';
const REDIRECT_PORT = 17342;
const REDIRECT_PATH = '/da-callback';

function redirectUri() {
  return `http://127.0.0.1:${REDIRECT_PORT}${REDIRECT_PATH}`;
}

function formBody(params) {
  return new URLSearchParams(params).toString();
}

async function exchange(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody(params),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) {
    throw new Error(
      (data && (data.message || data.error)) || `DonationAlerts: HTTP ${res.status}`
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresIn: Number(data.expires_in) || 3600,
    scope: data.scope || '',
  };
}

function startAuth({ clientId, clientSecret, timeoutMs = 300000, openUrl }) {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(12).toString('hex');
    let settled = false;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
      if (url.pathname !== REDIRECT_PATH) {
        res.writeHead(404).end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const gotState = url.searchParams.get('state');

      const finish = (html) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="background:#0b0d11;color:#e9e9ec;font-family:sans-serif;padding:40px">
          <h2>${html}</h2><p>Можно закрыть эту вкладку и вернуться в Aron Chat.</p></body></html>`);
      };

      if (settled) return;
      settled = true;

      try {
        if (error) throw new Error(`DonationAlerts: ${error}`);
        if (!code) throw new Error('DonationAlerts: не получен код авторизации');
        if (state && gotState && state !== gotState) {
          throw new Error('DonationAlerts: state не совпал');
        }

        const tokens = await exchange({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri(),
          code,
        });

        finish('Вход через DonationAlerts выполнен');
        resolve(tokens);
      } catch (err) {
        finish('Не удалось войти');
        reject(err);
      } finally {
        server.close();
      }
    });

    server.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error('DonationAlerts: время ожидания входа истекло'));
      }
    }, timeoutMs);
    timer.unref?.();

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const params = new URLSearchParams({
        client_id: String(clientId),
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: SCOPES,
        state,
      });
      const url = `${AUTH_URL}?${params.toString()}`;
      try {
        if (typeof openUrl === 'function') openUrl(url);
      } catch {
        // пользователь может открыть ссылку вручную
      }
    });
  });
}

async function refresh({ clientId, clientSecret, refreshToken }) {
  return exchange({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    scope: SCOPES,
  });
}

async function apiGet(path, accessToken) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data && data.message) || `DonationAlerts: HTTP ${res.status}`);
  }
  return data;
}

async function getUser(accessToken) {
  return apiGet('/user', accessToken);
}

async function getDonations(accessToken) {
  const data = await apiGet('/alerts/donations?page=1', accessToken);
  return Array.isArray(data.data) ? data.data : [];
}

module.exports = { startAuth, refresh, getUser, getDonations, redirectUri, SCOPES };
