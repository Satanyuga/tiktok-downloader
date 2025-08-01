const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 🧠 Express-заглушка для Render
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Bot is alive'));
app.listen(PORT, () => console.log(`🧠 Express работает на порту ${PORT}`));

// 🛡️ Токен из переменной окружения
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('❌ TELEGRAM_TOKEN не установлен.');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const queue = [];
const processedLinks = new Set();
let isProcessing = false;

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.text || typeof msg.text !== 'string') return bot.sendMessage(chatId, '⚠️ Пришли TikTok ссылку, а не картинку!');
  const url = msg.text.trim();
  if (!url.startsWith('http') || !url.includes('tiktok')) return bot.sendMessage(chatId, '⚠️ Это не похоже на TikTok ссылку.');
  if (processedLinks.has(url)) return bot.sendMessage(chatId, '🚫 Эта ссылка уже обрабатывалась.');

  queue.push({ chatId, url });
  processedLinks.add(url);
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
        await bot.sendMessage(chatId, '🚫 Видео не найдено.');
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

      await bot.sendVideo(chatId, videoPath, { caption: '🎬 Вот твоё видео' });
      fs.unlinkSync(videoPath);
    } catch (err) {
      await bot.sendMessage(chatId, '🔥 Ошибка: ' + err.message);
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
