// 📦 Основные модули
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// 🌐 Публичный адрес на Render для анти-сна
const RENDER_URL = 'https://tiktokbot-1100.onrender.com';

// ✅ Убедимся, что бот онлайн
app.get('/', (req, res) => res.send('🤖 Bot is alive'));
app.listen(PORT, () => console.log(`🧠 Express слушает порт ${PORT}`));

// 🔐 Получаем токен из переменных окружения
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('❌ TELEGRAM_TOKEN не установлен.');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// 📦 Очередь ссылок для обработки
const queue = [];
let isProcessing = false;

// 📥 Telegram-сообщение — проверка ссылки и добавление в очередь
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();
  if (!url?.startsWith('http') || !url.includes('tiktok')) {
    return bot.sendMessage(chatId, '⚠️ Это не похоже на TikTok ссылку. Пришли корректную.');
  }

  queue.push({ chatId, url });
  if (!isProcessing) processQueue();
});

// 🧠 Парсинг картинок из TikTok страницы
async function extractImagesFromPage(pageUrl) {
  try {
    const { data } = await axios.get(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://www.tiktok.com/',
      }
    });

    const $ = cheerio.load(data);
    const imageLinks = [];

    $('img').each((_, el) => {
      const src = $(el).attr('src');
      if (src && src.includes('object') && src.endsWith('.jpg')) {
        imageLinks.push(src);
      }
    });

    return [...new Set(imageLinks)];
  } catch (err) {
    console.error('🧨 Ошибка парсинга TikTok страницы:', err.message);
    return [];
  }
}

// 🚀 Обработка очереди: либо видео (через TikWM), либо картинки (через Cheerio)
async function processQueue() {
  isProcessing = true;

  while (queue.length > 0) {
    const { chatId, url } = queue.shift();
    try {
      // 🧪 Пробуем получить видео через TikWM
      const { data } = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(url)}`);
      const videoLink = data?.data?.play;

      if (videoLink) {
        return bot.sendMessage(chatId, '🎬 Видео найдено, но эта версия бота поддерживает ТОЛЬКО картинки. Картинки ищем…');
      }

      // 🖼️ Парсим картинки, если видео не найдено
      const images = await extractImagesFromPage(url);

      if (images.length > 0) {
        const mediaGroup = images.slice(0, 10).map((src, index) => ({
          type: 'photo',
          media: src,
          caption: index === 0 ? '🖼️ Галерея из TikTok' : undefined,
        }));

        await bot.sendMediaGroup(chatId, mediaGroup);
      } else {
        await bot.sendMessage(chatId, '📭 Картинки не найдены.');
      }
    } catch (err) {
      console.error('🔥 Ошибка обработки:', err.message);
      await bot.sendMessage(chatId, `🔥 Ошибка: ${err.message}`);
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

// 📡 Пинг внешнего Render-адреса каждые 5 минут (анти-сон)
setInterval(() => {
  axios.get(RENDER_URL + '/')
    .then(() => console.log('📡 Внешний пинг прошёл. Render проснулся.'))
    .catch((e) => console.error('⚠️ Сбой внешнего пинга:', e.message));
}, 5 * 60 * 1000);

// ⏰ TikTok-запрос для анти-сна каждые 5 минут
setInterval(() => {
  queue.push({
    chatId: 'internal_ping',
    url: 'https://www.tiktok.com/@bellapoarch/video/7338180453062479134'
  });
  console.log('📥 Автоматический запрос на TikTok добавлен');
  if (!isProcessing) processQueue();
}, 5 * 60 * 1000);
