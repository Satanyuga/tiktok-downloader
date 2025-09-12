// 📦 Импорт модулей
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs'); // Оставляем на случай, если что-то пойдёт не так, но в основном не используем
const path = require('path');

// 🔧 Express сервер для Render
const app = express();
const PORT = process.env.PORT || 3000;
const URL = 'https://' + process.env.RENDER_EXTERNAL_HOSTNAME;

app.use(express.json()); // Обработка JSON-тела от Telegram

app.get('/', (req, res) => res.send('🤖 Bot is alive'));
app.get('/ping', (req, res) => res.send('✅ Ping OK'));
app.listen(PORT, () => console.log(`🧠 Express слушает порт ${PORT}`));

// 🔐 Telegram токен из ENV
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('❌ TELEGRAM_TOKEN не указан.');

// ⚙️ Настраиваем Webhook
const bot = new TelegramBot(TELEGRAM_TOKEN);
bot.setWebHook(`${URL}/bot${TELEGRAM_TOKEN}`);

// 📦 Очередь сообщений
const queue = [];
let isProcessing = false;

// ⏰ Пинг самого себя каждые 5 минут + лог
setInterval(() => {
  axios.get(`${URL}/ping`)
    .then(() => console.log(`[${new Date().toLocaleTimeString()}] 🔄 Я не сплю. Пинганул Render.`))
    .catch(() => console.log(`[${new Date().toLocaleTimeString()}] ⚠️ Пинг не прошёл.`));
}, 300000);

// 📥 Обработка входящих сообщений от Webhook
app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200); // Обязательно отвечаем, чтобы Telegram не спамил
});

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
      await bot.sendMessage(chatId, '🔎 Ищу твой контент...');
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
          const stream = await axios.get(imgUrl, { responseType: 'stream' });
          await bot.sendPhoto(chatId, stream.data);
        }

      // 🎥 Обычное видео
      } else if (videoLink) {
        const stream = await axios.get(videoLink, { responseType: 'stream' });
        await bot.sendVideo(chatId, stream.data, { caption: '🎬 Вот твоё видео из TikTok' });

      } else {
        // ❌ Контент не найден
        await bot.sendMessage(chatId, '📭 Контент не найден.');
      }

    } catch (err) {
      // 🔥 Обработка ошибок
      console.error(`Ошибка при обработке: ${err.message}`);
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
