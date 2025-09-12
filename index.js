// 📦 Импорт модулей
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 🔧 Express сервер для Render
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Bot is alive'));
app.get('/ping', (req, res) => res.send('✅ Ping OK'));
app.listen(PORT, () => console.log(`🧠 Express слушает порт ${PORT}`));

// 🔐 Telegram токен из ENV
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('❌ TELEGRAM_TOKEN не указан.');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// 📦 Очередь сообщений
const queue = [];
let isProcessing = false;

// ⏰ Пинг самого себя каждые 5 минут + лог
setInterval(() => {
  axios.get("https://tiktokbot-1100.onrender.com/ping")
    .then(() => console.log(`[${new Date().toLocaleTimeString()}] 🔄 Я не сплю. Пинганул Render.`))
    .catch(() => console.log(`[${new Date().toLocaleTimeString()}] ⚠️ Пинг не прошёл.`));
}, 300000);

// 📥 Обработка входящих сообщений
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();

  // ⚠️ Проверка — только TikTok ссылки
  if (!url?.startsWith('http') || !url.includes('tiktok')) {
    return bot.sendMessage(chatId, '⚠️ Это не TikTok-ссылка. Пришли корректную.');
  }

  // 📥 Добавляем в очередь
  queue.push({ chatId, url });
  if (!isProcessing) processQueue();
});

// 🔧 Основной обработчик очереди
async function processQueue() {
  isProcessing = true;

  while (queue.length > 0) {
    const { chatId, url } = queue.shift();

    try {
      // 🎬 Получаем данные с tikwm
      const { data } = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(url)}`);
      const info = data?.data;
      const videoLink = info?.play;
      const images = info?.images;

      // 🖼️ Карусель изображений
      if (Array.isArray(images) && images.length > 0) {
        await bot.sendMessage(chatId, `🖼️ Найдена галерея: ${images.length} изображений`);

        for (let i = 0; i < images.length; i++) {
          const imgUrl = images[i];
          const filename = `img_${Date.now()}_${i}.jpg`;
          const imgPath = path.resolve(__dirname, filename);

          const stream = await axios.get(imgUrl, { responseType: 'stream' });
          const writer = fs.createWriteStream(imgPath);
          stream.data.pipe(writer);

          await new Promise((res, rej) => {
            writer.on('finish', res);
            writer.on('error', rej);
          });

          await bot.sendPhoto(chatId, imgPath);
          fs.unlinkSync(imgPath);
        }

      // 🎥 Обычное видео
      } else if (videoLink) {
        const filename = `video_${Date.now()}.mp4`;
        const videoPath = path.resolve(__dirname, filename);

        const stream = await axios.get(videoLink, { responseType: 'stream' });
        const writer = fs.createWriteStream(videoPath);
        stream.data.pipe(writer);

        await new Promise((res, rej) => {
          writer.on('finish', res);
          writer.on('error', rej);
        });

        await bot.sendVideo(chatId, videoPath, { caption: '🎬 Вот твоё видео из TikTok' });
        fs.unlinkSync(videoPath);

      } else {
        // ❌ Контент не найден
        await bot.sendMessage(chatId, '📭 Контент не найден.');
      }

    } catch (err) {
      // 🔥 Обработка ошибок
      await bot.sendMessage(chatId, `🔥 Ошибка: ${err.message}`);
    }

    // ⏱️ Задержка между запросами
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

// 💤 Завершение при SIGINT/SIGTERM
process.once('SIGINT', () => {
  console.log('🧨 SIGINT. Завершаем...');
  process.exit(0);
});
process.once('SIGTERM', () => {
  console.log('🔪 SIGTERM. Уничтожение...');
  process.exit(0);
});
