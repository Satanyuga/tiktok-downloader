const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 🔧 Express для Render (чтобы не падал)
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Бот работает'));
app.get('/ping', (req, res) => res.send('✅ OK'));
app.listen(PORT, () => console.log(`🧠 Порт: ${PORT}`));

// 🔐 Твои токены
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; 

// 📂 Данные твоего GitHub
const REPO_OWNER = 'Satanyuga'; 
const REPO_NAME = 'tiktok-downloader';
const ALL_USERS_FILE = 'all_users.txt';
const BLACKLIST_FILE = 'blacklist.txt';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let BANNED_IDS = [];

// 🛡️ Функция обновления черного списка
async function updateBlacklist() {
  try {
    const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${BLACKLIST_FILE}?t=${Date.now()}`;
    const res = await axios.get(url);
    BANNED_IDS = res.data.split('\n').map(id => id.trim()).filter(id => id.length > 0);
  } catch (err) { console.log('⚠️ Blacklist пока пуст или недоступен.'); }
}

// 📝 Функция записи в "all_users.txt" на GitHub
async function writeToGithub(userId, userInfo) {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${ALL_USERS_FILE}`;
  try {
    let currentContent = '';
    let sha = null;
    try {
      const getRes = await axios.get(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
      currentContent = Buffer.from(getRes.data.content, 'base64').toString('utf-8');
      sha = getRes.data.sha;
    } catch (e) {}

    if (currentContent.includes(userId)) return; 

    const newContent = currentContent + userInfo + '\n';
    await axios.put(url, {
      message: `👤 Авторизация: ${userId}`,
      content: Buffer.from(newContent).toString('base64'),
      sha: sha
    }, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
    console.log(`✅ ID ${userId} записан на GitHub.`);
  } catch (err) { console.error('❌ Ошибка записи на GitHub:', err.message); }
}

// Запускаем обновление списка банов
updateBlacklist();
setInterval(updateBlacklist, 300000); // Каждые 5 минут

const queue = [];
let isProcessing = false;

// ⏰ Пинг Render (чтобы не засыпал)
setInterval(() => {
  axios.get("https://tiktokbot-1100.onrender.com/ping")
    .then(() => console.log(`[${new Date().toLocaleTimeString()}] 🔄 Пинг успешен.`))
    .catch(() => {});
}, 300000);

// 🔄 Твои API для скачивания
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

// 🔥 ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text?.trim();

  // 1. ПРОВЕРКА БАНА (Если в бане — сразу на выход)
  if (BANNED_IDS.includes(userId)) {
    return bot.sendMessage(chatId, `🚫 Доступ закрыт. Твой ID: ${userId}. Передай его владельцу.`);
  }

  // 2. АВТОРИЗАЦИЯ И СТАРТ
  if (text === '/start' || text === '🔐 Авторизоваться') {
    const info = `ID: ${userId} | @${msg.from.username || 'no_nick'} | Name: ${msg.from.first_name}`;
    await writeToGithub(userId, info); // Сдаем ID на Гитхаб
    
    return bot.sendMessage(chatId, `👋 Привет! Твой ID: ${userId}\nНажми кнопку, чтобы я тебя запомнил, и кидай ссылку.`, {
      reply_markup: { keyboard: [['🔐 Авторизоваться']], resize_keyboard: true }
    });
  }

  // 3. ПРОВЕРКА НА ССЫЛКУ (То, что ты просил вернуть!)
  if (!text || !text.includes('tiktok.com')) {
    return bot.sendMessage(chatId, '⚠️ Это не TikTok-ссылка. Пришли корректную ссылку на видео.');
  }

  // 4. ДОБАВЛЕНИЕ В ОЧЕРЕДЬ
  queue.push({ chatId, url: text });
  if (!isProcessing) processQueue();
});

// ⚙️ Обработка очереди скачивания
async function tryDownload(url) {
  for (const api of APIs) {
    try {
      let res = api.method === 'POST' 
        ? await axios.post(api.url(url), api.data(url), { headers: {'Content-Type': 'application/x-www-form-urlencoded'}, timeout: 15000 })
        : await axios.get(api.url(url), { timeout: 15000 });
      const result = api.parser(res.data);
      if (result.videoLink || result.images) return result;
    } catch (e) { continue; }
  }
  throw new Error('Все API недоступны');
}

async function processQueue() {
  isProcessing = true;
  while (queue.length > 0) {
    const { chatId, url } = queue.shift();
    try {
      const { videoLink, images } = await tryDownload(url);
      
      // Если это картинки
      if (Array.isArray(images) && images.length > 0) {
        await bot.sendMessage(chatId, `🖼️ Найдена галерея: ${images.length} фото`);
        for (const imgUrl of images) await bot.sendPhoto(chatId, imgUrl);
      } 
      // Если это видео
      else if (videoLink) {
        const videoPath = path.resolve(__dirname, `v_${Date.now()}.mp4`);
        const res = await axios.get(videoLink, { responseType: 'stream' });
        const writer = fs.createWriteStream(videoPath);
        res.data.pipe(writer);
        await new Promise(r => writer.on('finish', r));
        await bot.sendVideo(chatId, videoPath, { caption: '🎬 Твое видео' });
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      } else {
        bot.sendMessage(chatId, '📭 Контент не найден.');
      }
    } catch (err) { 
      bot.sendMessage(chatId, '🔥 Ошибка: Не удалось скачать контент.'); 
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  isProcessing = false;
}
