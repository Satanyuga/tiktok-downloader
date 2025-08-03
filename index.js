// 📦 Импорт модулей
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 🔧 Запускаем Express сервер для Render пинга
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Bot is alive'));
app.listen(PORT, () => console.log(`🧠 Express слушает порт ${PORT}`));

// 🔐 Получаем токен из Render переменной окружения
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('❌ TELEGRAM_TOKEN не указан.');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// 📦 Очередь сообщений
const queue = [];
let isProcessing = false;

// 📥 Обработка входящих сообщений
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();

  if (!url?.startsWith('http') || !url.includes('tiktok')) {
    return bot.sendMessage(chatId, '⚠️ Это не TikTok-ссылка. Пришли корректную.');
  }

  queue.push({ chatId, url });
  if (!isProcessing) processQueue();
});

// 🔧 Основной обработчик очереди
async function processQueue() {
  isProcessing = true;
  while (queue.length > 0) {
    const { chatId, url } = queue.shift();

    try {
      // 🎬 Получаем видео через tikwm API
      const { data } = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(url)}`);
      const videoLink = data?.data?.play;

      if (!videoLink) {
        await bot.sendMessage(chatId, '📭 Видео не найдено.');
        continue;
      }

      // 💾 Скачиваем видео во временный файл
      const filename = `video_${Date.now()}.mp4`;
      const videoPath = path.resolve(__dirname, filename);
      const stream = await axios.get(videoLink, { responseType: 'stream' });
      const writer = fs.createWriteStream(videoPath);
      stream.data.pipe(writer);

      await new Promise((res, rej) => {
        writer.on('finish', res);
        writer.on('error', rej);
      });

      // 🚀 Отправляем видео в Telegram и удаляем файл
      await bot.sendVideo(chatId, videoPath, { caption: '🎬 Вот твоё видео из TikTok' });
      fs.unlinkSync(videoPath);
    } catch (err) {
      await bot.sendMessage(chatId, `🔥 Ошибка: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }
  isProcessing = false;
}

// 🔍 Проверка Telegram подключения
(async () => {
  try {
    const me = await bot.getMe();
    console.log(`🤖 Бот активен: @${me.username}`);
  } catch (err) {
    console.error('❌ Ошибка getMe:', err.message);
  }
})();

// 💤 Обработка завершения
process.once('SIGINT', () => {
  console.log('🧨 SIGINT. Завершаем...');
  process.exit(0);
});
process.once('SIGTERM', () => {
  console.log('🔪 SIGTERM. Уничтожение...');
  process.exit(0);
});
