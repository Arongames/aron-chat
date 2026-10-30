// ============================================================
// Twitch-ассеты: аватары и эмоуты 7TV / BTTV / FFZ.
//
// Аватары берём у ivr.fi (публичный API, не требует ключей),
// эмоуты — из открытых API провайдеров. Всё кэшируется, чтобы
// не дёргать сети на каждое сообщение.
// ============================================================

const UA = { 'User-Agent': 'AronChat/1.10 (+https://arongames.by)' };

async function getJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

function normUrl(url) {
  if (!url) return null;
  return url.startsWith('//') ? `https:${url}` : url;
}

class TwitchAssets {
  constructor(log) {
    this.log = log || (() => {});
    this.profiles = new Map(); // login -> { id, avatar, at }
    this.emotes = {};          // code -> url
    this.emoteLogin = null;
    this.loading = null;
  }

  async profile(login) {
    const key = String(login || '').toLowerCase();
    if (!key) return null;

    const cached = this.profiles.get(key);
    if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached;

    try {
      const data = await getJson(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(key)}`);
      const user = Array.isArray(data) ? data[0] : null;
      if (!user) {
        this.profiles.set(key, { id: null, avatar: null, at: Date.now() });
        return this.profiles.get(key);
      }
      const info = {
        id: user.id || null,
        avatar: user.logo || null,
        at: Date.now(),
      };
      this.profiles.set(key, info);
      return info;
    } catch {
      // Сеть недоступна — не кэшируем надолго, попробуем позже
      return { id: null, avatar: null, at: 0 };
    }
  }

  // 7TV
  async add7tv(map, id) {
    try {
      const sets = [];
      sets.push(await getJson('https://7tv.io/v3/emote-sets/global'));

      if (id) {
        const user = await getJson(`https://7tv.io/v3/users/twitch/${id}`);
        if (user && user.emote_set) sets.push(user.emote_set);
      }

      for (const set of sets) {
        for (const emote of set.emotes || []) {
          if (emote.name && emote.id) {
            map[emote.name] = `https://cdn.7tv.app/emote/${emote.id}/1x.webp`;
          }
        }
      }
    } catch (err) {
      this.log({ level: 'info', text: `7TV: ${err.message}` });
    }
  }

  // BTTV
  async addBttv(map, id) {
    try {
      const global = await getJson('https://api.betterttv.net/3/cached/emotes/global');
      for (const e of global || []) {
        if (e.code && e.id) map[e.code] = `https://cdn.betterttv.net/emote/${e.id}/1x`;
      }

      if (id) {
        const data = await getJson(`https://api.betterttv.net/3/cached/users/twitch/${id}`);
        for (const e of [...(data.channelEmotes || []), ...(data.sharedEmotes || [])]) {
          if (e.code && e.id) map[e.code] = `https://cdn.betterttv.net/emote/${e.id}/1x`;
        }
      }
    } catch (err) {
      this.log({ level: 'info', text: `BTTV: ${err.message}` });
    }
  }

  // FFZ
  async addFfz(map, login) {
    const addSets = (sets) => {
      for (const set of Object.values(sets || {})) {
        for (const e of set.emoticons || []) {
          const url = normUrl(e.urls && (e.urls['1'] || e.urls['2'] || e.urls['4']));
          if (e.name && url) map[e.name] = url;
        }
      }
    };

    try {
      const global = await getJson('https://api.frankerfacez.com/v1/set/global');
      addSets(global.sets);
    } catch (err) {
      this.log({ level: 'info', text: `FFZ global: ${err.message}` });
    }

    if (login) {
      try {
        const room = await getJson(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(login)}`);
        addSets(room.sets);
      } catch (err) {
        this.log({ level: 'info', text: `FFZ: ${err.message}` });
      }
    }
  }

  // Полная загрузка набора эмоутов для канала
  async loadEmotes(login) {
    if (this.loading) return this.loading;

    const key = String(login || '').toLowerCase();
    this.loading = (async () => {
      const info = await this.profile(key);
      const map = {};

      await Promise.all([
        this.add7tv(map, info && info.id),
        this.addBttv(map, info && info.id),
        this.addFfz(map, key),
      ]);

      this.emotes = map;
      this.emoteLogin = key;
      this.log({
        level: 'info',
        text: `Эмоуты загружены: ${Object.keys(map).length} (7TV, BTTV, FFZ)`,
      });
      return map;
    })();

    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  getEmotes() {
    return this.emotes;
  }

  clearEmotes() {
    this.emotes = {};
    this.emoteLogin = null;
  }
}

module.exports = TwitchAssets;
