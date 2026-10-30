// ============================================================
// Счётчик зрителей: Twitch Helix, YouTube Data API и TikTok.
//
// Опрос раз в 30 секунд. Для каждой площадки число может быть null:
//   • Twitch — нужен Client-ID приложения (поле в настройках);
//     без него Helix отвечает 401, и счётчик просто скрыт;
//   • YouTube — с API-ключом берём concurrentViewers, если он есть
//     (доступен владельцу канала), иначе viewCount трансляции;
//   • TikTok — приблизительно, из данных комнаты (точной цифры
//     «онлайн» Webcast не отдаёт).
//
// Наружу отдаём одно событие 'update' со снимком:
//   { twitch: number|null, youtube: number|null, tiktok: number|null }
// ============================================================

const { EventEmitter } = require('events');

const POLL_INTERVAL = 30000;

class ViewersTracker extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    // Параметры текущего опроса. Нужны, чтобы менять канал/эфир,
    // не пересоздавая трекер.
    this.params = {
      enabled: true,
      twitch: true,
      youtube: true,
      tiktok: true,
      twitchChannel: '',
      twitchClientId: '',
      twitchAccessToken: '',
      youtubeVideoId: '',
      youtubeApiKey: '',
      getTikTokCount: null,
    };
    this.counters = { twitch: null, youtube: null, tiktok: null };
    this.lastSent = '';
  }

  // ---------- Twitch ----------
  // Helix требует OAuth Bearer. Если токена нет или он истёк,
  // берём число зрителей через публичный GQL-запрос (как веб-плеер).
  async fetchTwitchGql(login) {
    try {
      const res = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
          'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: 'query($login:String!){user(login:$login){stream{viewersCount}}}',
          variables: { login },
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const stream = data && data.data && data.data.user && data.data.user.stream;
      return stream ? Number(stream.viewersCount) || 0 : 0;
    } catch {
      return null;
    }
  }

  async fetchTwitch() {
    const { twitchChannel, twitchClientId, twitchAccessToken } = this.params;
    if (!twitchChannel) return null;

    const login = twitchChannel.toLowerCase().replace(/^#/, '');

    // 1. Официальный Helix, если есть и Client ID, и токен
    if (twitchClientId && twitchAccessToken) {
      try {
        const headers = {
          'Client-ID': twitchClientId,
          Authorization: `Bearer ${twitchAccessToken}`,
        };

        const usersRes = await fetch(
          `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
          { headers }
        );
        if (usersRes.ok) {
          const usersData = await usersRes.json();
          const userId = usersData.data && usersData.data[0] && usersData.data[0].id;
          if (userId) {
            const streamsRes = await fetch(
              `https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(userId)}`,
              { headers }
            );
            if (streamsRes.ok) {
              const streamsData = await streamsRes.json();
              const stream = streamsData.data && streamsData.data[0];
              return stream ? Number(stream.viewer_count) || 0 : 0;
            }
          }
        }
      } catch {
        // переходим к GQL
      }
    }

    // 2. GQL без авторизации
    return this.fetchTwitchGql(login);
  }

  // ---------- YouTube ----------
  async fetchYouTube() {
    const { youtubeVideoId, youtubeApiKey } = this.params;
    if (!youtubeVideoId || !youtubeApiKey) return null;

    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('key', youtubeApiKey);
    url.searchParams.set('part', 'statistics,liveStreamingDetails');
    url.searchParams.set('id', youtubeVideoId);

    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const video = data.items && data.items[0];
    if (!video) return null;

    const concurrent = video.liveStreamingDetails && video.liveStreamingDetails.concurrentViewers;
    if (concurrent !== undefined && concurrent !== null) {
      return Number.parseInt(concurrent, 10) || 0;
    }
    return Number.parseInt(video.statistics && video.statistics.viewCount, 10) || 0;
  }

  // ---------- TikTok ----------
  async fetchTikTok() {
    if (typeof this.params.getTikTokCount !== 'function') return null;
    try {
      return await this.params.getTikTokCount();
    } catch {
      return null;
    }
  }

  async tick() {
    if (!this.params.enabled) return;

    const jobs = [
      this.params.twitch ? this.fetchTwitch().catch(() => null) : Promise.resolve(null),
      this.params.youtube ? this.fetchYouTube().catch(() => null) : Promise.resolve(null),
      this.params.tiktok ? this.fetchTikTok() : Promise.resolve(null),
    ];
    const [twitch, youtube, tiktok] = await Promise.all(jobs);

    const next = {
      twitch: twitch === null ? null : Number(twitch) || 0,
      youtube: youtube === null ? null : Number(youtube) || 0,
      tiktok: tiktok === null ? null : Number(tiktok) || 0,
    };
    this.counters = next;

    // Не спамим UI одинаковыми значениями
    const signature = JSON.stringify(next);
    if (signature !== this.lastSent) {
      this.lastSent = signature;
      this.emit('update', { ...next });
    }
  }

  // Полный запуск/перезапуск опроса с новыми параметрами
  start(params = {}) {
    this.stop();
    this.params = { ...this.params, ...params };
    if (!this.params.enabled) {
      this.emit('update', { twitch: null, youtube: null, tiktok: null });
      return;
    }

    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL);
  }

  // Точечные изменения без перезапуска (например, сменился эфир YouTube)
  setYouTubeVideo(videoId) {
    if (!videoId || this.params.youtubeVideoId === videoId) return;
    this.params.youtubeVideoId = videoId;
    this.lastSent = '';
    this.tick();
  }

  setTikTokCounter(fn) {
    this.params.getTikTokCount = fn;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.counters = { twitch: null, youtube: null, tiktok: null };
    this.lastSent = '';
  }

  snapshot() {
    return { ...this.counters };
  }

  // Ручная установка значений — для проверок и демонстраций
  setCounters(values = {}) {
    this.counters = { ...this.counters, ...values };
    this.emit('update', { ...this.counters });
  }
}

module.exports = ViewersTracker;
module.exports.POLL_INTERVAL = POLL_INTERVAL;
