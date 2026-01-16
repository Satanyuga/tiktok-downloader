const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 🔧 Сервер для Render
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Bot is alive'));
app.get('/ping', (req, res) => res.send('✅ Ping OK'));
app.listen(PORT, () => console.log(`🧠 Express на порту ${PORT}`));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// --- 🛡️ СИСТЕМА БАНА ЧЕРЕЗ GITHUB ---
// Замени 'ТВОЙ_ЛОГИН' и 'ТВОЙ_РЕПО' на свои данные
const GITHUB_BLACKLIST_URL = 'https://raw.githubusercontent.com/ТВОЙ_ЛОГИН/ТВОЙ_РЕПО/main/blacklist.txt';
let BANNED_IDS = [];

async function updateBlacklist() {
  try {
    const res = await axios.get(GITHUB_BLACKLIST_URL);
    BANNED_IDS = res.data.split('\n').map(id => id.trim()).filter(id => id.length > 0);
    console.log('✅ Список изгнанных обновлен:', BANNED_IDS);
  } catch (err) {
    console.log('⚠️ Ошибка обновления списка (проверь ссылку)');
  }
}
updateBlacklist();
setInterval(updateBlacklist, 300000); // Обновление каждые 5 минут

// 📦 Очередь и API
const queue = [];
let isProcessing = false;

const APIs = [
  {
    name: 'tikwm',
    url: (url) => `https://tikwm.com/api/?url=${encodeURIComponent(url)}`,
    parser: (data) => ({ videoLink: data?.data?.play, images: data?.data?.images })
  },
  {
    name: 'savetik',
    url: (url) => `https://savetik.co/api/ajaxSearch`,
    method: 'POST',
    data: (url) => ({ q: url, lang: 'en' }),
    parser: (data) => {
      const videoMatch = data?.data?.match(/<a[^>]+href="([^"]+)"[^>]*>Download MP4<\/a>/i);
      return { videoLink: videoMatch ? videoMatch[1] : null, images: null };
    }
  }
];

// 📥 Обработка сообщений
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const url = msg.text?.trim();

  // 📝 ТВОИ ЛОГИ В КОНСОЛЬ (как просила)
  console.log(`[LOG] ID: ${userId} | User: @${msg.from.username || 'none'} | Name: ${msg.from.first_name} | Text: ${url || 'media'}`);

  // 🚫 ПРОВЕРКА БАНА
  if (BANNED_IDS.includes(userId)) {
    return bot.sendMessage(chatId, `❌ Доступ заблокирован. Твой ID: ${userId}.`);
  }

  if (!url?.startsWith('http') || !url.includes('tiktok')) {
    if (url === '/start') bot.sendMessage(chatId, 'Пришли ссылку.');
    return;
  }

  queue.push({ chatId, url });
  if (!isProcessing) processQueue();
});

// 🔧 Загрузчик
async function tryDownload(url) {
  for (const api of APIs) {
    try {
      let res;
      if (api.method === 'POST') {
        res = await axios.post(api.url(url), api.data(url), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15000
        });
      } else {
        res = await axios.get(api.url(url), { timeout: 15000 });
      }
      const result = api.parser(res.data);
      if (result.videoLink || result.images) return result;
    } catch (e) { continue; }
  }
  throw new Error('API down');
}

// 🔧 Обработка очереди
async function processQueue() {
  isProcessing = true;
  while (queue.length > 0) {
    const { chatId, url } = queue.shift();
    try {
      const { videoLink, images } = await tryDownload(url);

      if (Array.isArray(images) && images.length > 0) {
        await bot.sendMessage(chatId, `🖼️ Найдено ${images.length} фото:`);
        for (const imgUrl of images) {
          await bot.sendPhoto(chatId, imgUrl);
        }
      } else if (videoLink) {
        const videoPath = path.resolve(__dirname, `video_${Date.now()}.mp4`);
        const res = await axios.get(videoLink, { responseType: 'stream' });
        const writer = fs.createWriteStream(videoPath);
        res.data.pipe(writer);
        await new Promise(r => writer.on('finish', r));
        await bot.sendVideo(chatId, videoPath, { caption: '🎬 Готово' });
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      }
    } catch (err) {
      bot.sendMessage(chatId, '⚠️ Не удалось скачать.');
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  isProcessing = false;
}

// Пинг Render
setInterval(() => {
  axios.get("https://tiktokbot-1100.onrender.com/ping").catch(() => {});
}, 300000);
