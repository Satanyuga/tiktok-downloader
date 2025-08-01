const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Bot is alive'));
app.listen(PORT, () => console.log(`🧠 Express работает на порту ${PORT}`));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('❌ TELEGRAM_TOKEN не установлен.');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const queue = [];
let isProcessing = false;

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.text || typeof msg.text !== 'string') return bot.sendMessage(chatId, '⚠️ Пришли TikTok ссылку, а не картинку!');
  const url = msg.text.trim();
  if (!url.startsWith('http') || !url.includes('tiktok')) return bot.sendMessage(chatId, '⚠️ Это не похоже на TikTok ссылку.');

  queue.push({ chatId, url });

  if (!isProcessing) processQueue();
});

async function processQueue() {
  isProcessing = true;
  while (queue.length > 0) {
    const { chatId, url } = queue.shift();
    try {
      const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(url)}`;
      const { data } = await axios.get(apiUrl);
      const videoLink = data?.data?.play;
      if (!videoLink) {
        if (chatId !== 'internal_ping') {
          await bot.sendMessage(chatId, '🚫 Видео не найдено.');
        } else {
          console.log('🚫 Видео не найдено (анти-сон).');
        }
        continue;
      }

      const filename = `video_${Date.now()}.mp4`;
      const videoPath = path.resolve(__dirname, filename);
      const videoStream = await axios.get(videoLink, { responseType: 'stream' });
      const writer = fs.createWriteStream(videoPath);
      videoStream.data.pipe(writer);

      await new Promise((res, rej) => {
        writer.on('finish', res);
        writer.on('error', rej);
      });

      if (chatId !== 'internal_ping') {
        await bot.sendVideo(chatId, videoPath, { caption: '🎬 Вот твоё видео' });
      } else {
        console.log(`✅ Я получил ролик. Я всё ещё не сплю. (${filename})`);
      }

      fs.unlinkSync(videoPath);
    } catch (err) {
      if (chatId !== 'internal_ping') {
        await bot.sendMessage(chatId, '🔥 Ошибка: ' + err.message);
      } else {
        console.error('🔥 Ошибка анти-сна:', err.message);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  isProcessing = false;
}

(async () => {
  try {
    const me = await bot.getMe();
    console.log(`🤖 Бот активен: ${me.username}`);
  } catch (err) {
    console.error('❌ Ошибка getMe:', err.message);
  }
})();

// 🚨 Авто-завершение при отключении Render
process.once('SIGINT', () => {
  console.log('🧨 SIGINT пойман. Завершаем...');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('🔪 SIGTERM пойман. Уничтожаем...');
  process.exit(0);
});

// 🚀 Анти-сон пинг Express порта каждые 5 минут
setInterval(() => {
  axios.get(`http://localhost:${PORT}/`)
    .then(() => console.log('📣 Я не сплю. 🐺'))
    .catch((e) => console.error('⚠️ Пинг сбой:', e.message));
}, 5 * 60 * 1000);

// 📦 Автоматический TikTok-запрос каждые 5 минут (реальный)
setInterval(() => {
  const fakeChatId = 'internal_ping';
  const fakeUrl = 'https://www.tiktok.com/@bellapoarch/video/7338180453062479134?is_from_webapp=1&sender_device=pc';

  queue.push({ chatId: fakeChatId, url: fakeUrl });
  console.log('📥 Анти-сон: добавлен авто-запрос на TikTok-видео');

  if (!isProcessing) processQueue();
}, 5 * 60 * 1000);
