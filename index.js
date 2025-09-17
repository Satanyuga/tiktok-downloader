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

// 🔄 Список резервных API (в порядке приоритета)
const APIs = [
  {
    name: 'tikwm',
    url: (url) => `https://tikwm.com/api/?url=${encodeURIComponent(url)}`,
    parser: (data) => ({
      videoLink: data?.data?.play,
      images: data?.data?.images
    })
  },
  {
    name: 'savetik',
    url: (url) => `https://savetik.co/api/ajaxSearch`,
    method: 'POST',
    data: (url) => ({ q: url, lang: 'en' }),
    parser: (data) => {
      const videoMatch = data?.data?.match(/<a[^>]+href="([^"]+)"[^>]*>Download MP4<\/a>/i);
      return {
        videoLink: videoMatch ? videoMatch[1] : null,
        images: null
      };
    }
  }
];

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

// 🔧 Функция попытки загрузки через разные API
async function tryDownload(url) {
  for (const api of APIs) {
    try {
      console.log(`🔄 Пробуем API: ${api.name}`);
      
      let response;
      if (api.method === 'POST') {
        response = await axios.post(api.url(url), api.data(url), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 15000
        });
      } else {
        response = await axios.get(api.url(url), {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 15000
        });
      }

      const result = api.parser(response.data);
      
      if (result.videoLink || result.images) {
        console.log(`✅ Успешно через ${api.name}`);
        return result;
      }
    } catch (error) {
      console.log(`❌ Ошибка в ${api.name}: ${error.message}`);
      continue;
    }
  }
  
  throw new Error('Все API недоступны');
}

// 🔧 Основной обработчик очереди
async function processQueue() {
  isProcessing = true;

  while (queue.length > 0) {
    const { chatId, url } = queue.shift();

    try {
      // 🔄 Пробуем скачать через доступные API
      const { videoLink, images } = await tryDownload(url);

      // 🖼️ Карусель изображений
      if (Array.isArray(images) && images.length > 0) {
        await bot.sendMessage(chatId, `🖼️ Найдена галерея: ${images.length} изображений`);

        for (let i = 0; i < images.length; i++) {
          const imgUrl = images[i];
          const filename = `img_${Date.now()}_${i}.jpg`;
          const imgPath = path.resolve(__dirname, filename);

          const stream = await axios.get(imgUrl, { 
            responseType: 'stream',
            timeout: 30000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });
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

        const stream = await axios.get(videoLink, { 
          responseType: 'stream',
          timeout: 60000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.tiktok.com/'
          }
        });
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
      console.error(`🔥 Полная ошибка для URL ${url}:`, err.message);
      await bot.sendMessage(chatId, `🔥 Ошибка: Не удалось скачать контент. Попробуйте позже.`);
    }

    // ⏱️ Задержка между запросами
    await new Promise(r => setTimeout(r, 3000));
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
