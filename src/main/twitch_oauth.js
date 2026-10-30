// ============================================================
// Twitch OAuth (Device Code Grant) и отправка сообщений.
//
// Device flow выбран специально: нужен только Client ID приложения,
// без Client Secret и без локального redirect-сервера. Пользователь
// видит код, подтверждает его на twitch.tv/activate — и всё.
//
// Права: chat:read chat:edit + user:write:chat (новое требование Twitch
// для отправки сообщений через Helix Send Chat Message).
// ============================================================

const SCOPES = 'chat:read chat:edit user:write:chat';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  let data = null;
  try { data = await res.json(); } catch { /* не-JSON */ }
  return { res, data };
}

// Шаг 1: получить код для пользователя
async function startDevice(clientId) {
  const { res, data } = await postForm(DEVICE_URL, { client_id: clientId, scopes: SCOPES });
  if (!res.ok || !data || !data.device_code) {
    throw new Error((data && (data.message || data.error)) || `Twitch ответил HTTP ${res.status}`);
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in || 1800,
    interval: Math.max(5, data.interval || 5),
  };
}

// Шаг 2: опрос токена, пока пользователь подтверждает код
async function pollDevice(clientId, deviceCode) {
  const { res, data } = await postForm(TOKEN_URL, {
    client_id: clientId,
    scopes: SCOPES,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  if (res.status === 400 && data && /pending/i.test(String(data.message || ''))) {
    return { pending: true };
  }
  if (!res.ok || !data || !data.access_token) {
    throw new Error((data && (data.message || data.error)) || `Twitch ответил HTTP ${res.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in || 3600,
    scopes: data.scope,
  };
}

// Кто вошёл и когда истекает токен
async function validate(accessToken) {
  const res = await fetch(VALIDATE_URL, {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!res.ok) throw new Error(`токен Twitch недействителен (HTTP ${res.status})`);
  return res.json(); // { client_id, login, user_id, expires_in, scopes }
}

async function refresh(clientId, refreshToken, clientSecret) {
  const payload = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  };
  // Confidential-приложения Twitch требуют секрет при обновлении токена
  if (clientSecret) payload.client_secret = clientSecret;

  const { res, data } = await postForm(TOKEN_URL, payload);
  if (!res.ok || !data || !data.access_token) {
    const detail = (data && (data.message || data.error)) || `не удалось обновить токен (HTTP ${res.status})`;
    if (/missing client secret/i.test(String(detail))) {
      throw new Error(
        'Twitch: приложение типа Confidential требует Client Secret. '
        + 'Вставьте его в «Доступ → Продвинутые настройки» или создайте Public-приложение.'
      );
    }
    throw new Error(detail);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || 3600,
  };
}

// Отправка сообщения в чат канала
async function sendMessage({ accessToken, clientId, broadcasterId, senderId, message }) {
  const res = await fetch('https://api.twitch.tv/helix/chat/messages', {
    method: 'POST',
    headers: {
      'Client-Id': clientId,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      broadcaster_id: String(broadcasterId),
      sender_id: String(senderId),
      message: String(message),
    }),
  });

  let data = null;
  try { data = await res.json(); } catch { /* пусто */ }

  if (!res.ok) {
    const detail = data && data.message ? data.message : `HTTP ${res.status}`;
    throw new Error(`Twitch: ${detail}`);
  }
  const sent = data && data.data && data.data[0];
  const dropped = sent && sent.is_sent === false;
  if (dropped) {
    throw new Error(`Twitch не отправил сообщение: ${sent.drop_reason && sent.drop_reason.message ? sent.drop_reason.message : 'причина неизвестна'}`);
  }
  return { ok: true };
}

module.exports = { startDevice, pollDevice, validate, refresh, sendMessage, SCOPES };
