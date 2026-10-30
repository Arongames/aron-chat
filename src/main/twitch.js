// ============================================================
// Модуль Twitch-чата на базе tmi.js.
// Подключается анонимно (чтение чата не требует OAuth) к
// указанному каналу и отдаёт каждое сообщение через событие
// 'message' в формате: { platform:'twitch', user, text, color }
// ============================================================

const tmi = require('tmi.js');
const { EventEmitter } = require('events');

class TwitchChat extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.channel = null;
  }

  isConnected() {
    return !!this.client && this.client.readyState() === 'OPEN';
  }

  // Подключение к каналу (имя канала без решётки)
  connect(channel) {
    return new Promise((resolve, reject) => {
      if (this.isConnected()) {
        resolve();
        return;
      }

      this.channel = channel.toLowerCase().replace(/^#/, '');

      this.client = new tmi.Client({
        options: { debug: false },
        connection: { reconnect: true, secure: true },
        // Анонимный вход: читать чат можно без учётной записи
        identity: { username: 'justinfan12345', password: 'schmoopiie' },
        channels: [this.channel],
      });

      const onConnecting = () => this.emit('status', { connected: false, text: `Подключение к #${this.channel}...` });
      this.client.on('connecting', onConnecting);

      this.client.on('connected', () => {
        this.emit('status', { connected: true, text: `Подключено к Twitch-каналу #${this.channel}` });
        resolve();
      });

      this.client.on('message', (_channel, tags, message, self) => {
        if (self) return;
        this.emit('message', {
          platform: 'twitch',
          user: tags['display-name'] || tags.username,
          login: tags.username || null,
          text: message,
          // Цвет ника, который пользователь сам задал на Twitch
          color: tags.color || null,
          // Признаки модератора/подписчика для подсветки в оверлее
          isMod: !!tags.mod,
          isSubscriber: !!tags.subscriber,
        });
      });

      this.client.on('disconnected', (reason) => {
        this.emit('status', { connected: false, text: `Отключено от Twitch: ${reason}` });
      });

      this.client.on('reconnect', () => {
        this.emit('status', { connected: false, text: 'Переподключение к Twitch...' });
      });

      // Ошибки подключения обрабатываются здесь: connect() возвращает Promise
      this.client.connect().catch((err) => {
        this.emit('status', { connected: false, text: `Ошибка Twitch: ${err.message}` });
        reject(err);
      });
    });
  }

  disconnect() {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
      this.emit('status', { connected: false, text: 'Twitch-чат отключён' });
    }
  }
}

module.exports = TwitchChat;
