// 📦 Импорт модулей
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 🧠 Инициализация Express-сервера для Render
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Bot is alive'));
app.listen(PORT, () => console.log(`🧠 Express слушает порт ${PORT}`));

// 🔐 Получаем токен из ENV-переменной
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('❌ TELEGRAM_TOKEN не указан.');

// 🚀 Создаём Telegram-бота
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// 📦 Очередь сообщений для поочерёдной обработки
const queue = [];
let isProcessing = false;

// 📥 Обработка входящих сообщений
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();

  // ⚠️ Проверка корректности ссылки
  if (!url?.startsWith('http') || !url.includes('tiktok')) {
    return bot.sendMessage(chatId, '⚠️ Это не TikTok-ссылка. Пришли корректную.');
  }

  // 📤 Добавляем в очередь и запускаем обработчик
  queue.push({ chatId, url });
  if (!isProcessing) processQueue();
});

// 🔄 Основной обработчик очереди
async function processQueue() {
  isProcessing = true;

  while (queue.length > 0) {
    const { chatId, url } = queue.shift();

    try {
      // 🔍 Получаем данные через API tikwm
      const { data } = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(url)}`);
      const info = data?.data;
      const videoLink = info?.play;
      const images = info?.images;

      // 🖼️ Если это карусель изображений
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

      // 🎬 Если это обычное видео
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

      // 📭 Контент не определён
      } else {
        await bot.sendMessage(chatId, '📭 Контент не найден.');
      }
    } catch (err) {
      await bot.sendMessage(chatId, `🔥 Ошибка: ${err.message}`);
    }

    // ⏱️ Задержка между сообщениями
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

// 💤 Завершение процесса при SIGINT/SIGTERM
process.once('SIGINT', () => {
  console.log('🧨 SIGINT. Завершаем...');
  process.exit(0);
});
process.once('SIGTERM', () => {
  console.log('🔪 SIGTERM. Уничтожение...');
  process.exit(0);
});
