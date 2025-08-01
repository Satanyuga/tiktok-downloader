const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Правильный публичный Render-адрес:
const RENDER_URL = 'https://tiktokbot-1100.onrender.com';

app.get('/', (req, res) => res.send('🤖 Bot is alive'));
app.listen(PORT, () => console.log(`🧠 Express слушает порт ${PORT}`));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('❌ TELEGRAM_TOKEN не установлен.');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const queue = [];
let isProcessing = false;

// 📥 Получение сообщений от Telegram
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();
  if (!url?.startsWith('http') || !url.includes('tiktok')) {
    return bot.sendMessage(chatId, '⚠️ Это не похоже на TikTok ссылку. Пришли корректную.');
  }

  queue.push({ chatId, url });
  if (!isProcessing) processQueue();
});

async function processQueue() {
  isProcessing = true;
  while (queue.length > 0) {
    const { chatId, url } = queue.shift();
    try {
      const { data } = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(url)}`);
      const videoLink = data?.data?.play;
      if (!videoLink) {
        chatId !== 'internal_ping'
          ? await bot.sendMessage(chatId, '🚫 Видео не найдено.')
          : console.log('🚫 Видео не найдено (анти-сон)');
        continue;
      }

      const filename = `video_${Date.now()}.mp4`;
      const videoPath = path.resolve(__dirname, filename);
      const stream = await axios.get(videoLink, { responseType: 'stream' });
      const writer = fs.createWriteStream(videoPath);
      stream.data.pipe(writer);

      await new Promise((res, rej) => {
        writer.on('finish', res);
        writer.on('error', rej);
      });

      chatId !== 'internal_ping'
        ? await bot.sendVideo(chatId, videoPath, { caption: '🎬 Вот твоё видео' })
        : console.log(`✅ Видео скачано: ${filename}`);

      fs.unlinkSync(videoPath);
    } catch (err) {
      chatId !== 'internal_ping'
        ? await bot.sendMessage(chatId, `🔥 Ошибка: ${err.message}`)
        : console.error('🔥 Ошибка анти-сна:', err.message);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  isProcessing = false;
}

// 🔍 Проверка Telegram-подключения
(async () => {
  try {
    const me = await bot.getMe();
    console.log(`🤖 Бот активен: @${me.username}`);
  } catch (err) {
    console.error('❌ Ошибка getMe:', err.message);
  }
})();

// 💤 Обработка сигналов завершения
process.once('SIGINT', () => {
  console.log('🧨 SIGINT. Завершаем...');
  process.exit(0);
});
process.once('SIGTERM', () => {
  console.log('🔪 SIGTERM. Уничтожение...');
  process.exit(0);
});

// 🌐 Пинг внешнего Render-адреса каждые 5 минут
setInterval(() => {
  axios.get(RENDER_URL + '/')
    .then(() => console.log('📡 Внешний пинг прошёл. Render проснулся.'))
    .catch((e) => console.error('⚠️ Сбой внешнего пинга:', e.message));
}, 5 * 60 * 1000);

// ⏰ TikTok-запрос для анти-сна каждые 5 минут
setInterval(() => {
  queue.push({
    chatId: 'internal_ping',
    url: 'https://www.tiktok.com/@bellapoarch/video/7338180453062479134?is_from_webapp=1&sender_device=pc'
  });
  console.log('📥 Автоматический запрос на TikTok добавлен');

  if (!isProcessing) processQueue();
}, 5 * 60 * 1000);
