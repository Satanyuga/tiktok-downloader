const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 🔧 Express сервер
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Бот под надзором Адель'));
app.get('/ping', (req, res) => res.send('✅ OK'));
app.listen(PORT, () => console.log(`🧠 Порт: ${PORT}`));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // ghp_jWn5...

// ТВОИ ДАННЫЕ (ВЖИВЛЕНО)
const REPO_OWNER = 'Satanyuga'; 
const REPO_NAME = 'tiktok-downloader';
const ALL_USERS_FILE = 'all_users.txt';
const BLACKLIST_FILE = 'blacklist.txt';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let BANNED_IDS = [];

// Функция синхронизации черного списка
async function updateBlacklist() {
  try {
    const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${BLACKLIST_FILE}?t=${Date.now()}`;
    const res = await axios.get(url);
    BANNED_IDS = res.data.split('\n').map(id => id.trim()).filter(id => id.length > 0);
  } catch (err) { console.log('⚠️ Файл blacklist.txt еще не создан на GitHub'); }
}

// Запись гостя "НА ЛАДОНЬ" в GitHub
async function writeToGithub(userId, userInfo) {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${ALL_USERS_FILE}`;
  try {
    let currentContent = '';
    let sha = null;

    try {
      const getRes = await axios.get(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
      currentContent = Buffer.from(getRes.data.content, 'base64').toString('utf-8');
      sha = getRes.data.sha;
    } catch (e) { console.log('📝 Создаю новый файл пользователей...'); }

    if (currentContent.includes(userId)) return; 

    const newContent = currentContent + userInfo + '\n';
    await axios.put(url, {
      message: `👤 Регистрация: ${userId}`,
      content: Buffer.from(newContent).toString('base64'),
      sha: sha
    }, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });

    console.log(`🚀 ${userId} занесен в список на GitHub`);
  } catch (err) { console.error('❌ Ошибка записи на GitHub:', err.message); }
}

updateBlacklist();
setInterval(updateBlacklist, 300000);

const queue = [];
let isProcessing = false;

// Пинг самого себя
setInterval(() => {
  axios.get("https://tiktokbot-1100.onrender.com/ping").catch(() => {});
}, 300000);

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

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text?.trim();

  // ПРОВЕРКА БАНА
  if (BANNED_IDS.includes(userId)) {
    return bot.sendMessage(chatId, `🚫 Доступ закрыт. Твой ID: ${userId}.`);
  }

  // АВТОРИЗАЦИЯ (Сдача ID владельцу)
  if (text === '/start' || text === '🔐 Авторизоваться') {
    const info = `ID: ${userId} | @${msg.from.username || 'null'} | Name: ${msg.from.first_name}`;
    await writeToGithub(userId, info);
    
    return bot.sendMessage(chatId, `Привет! Чтобы пользоваться ботом, нажми кнопку ниже.\nТвой ID: ${userId}`, {
      reply_markup: { keyboard: [['🔐 Авторизоваться']], resize_keyboard: true }
    });
  }

  // ОБЫЧНАЯ ЛОГИКА (Твоя оригинальная)
  if (text?.startsWith('http')) {
    queue.push({ chatId, url: text });
    if (!isProcessing) processQueue();
  }
});

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
  throw new Error('API Offline');
}

async function processQueue() {
  isProcessing = true;
  while (queue.length > 0) {
    const { chatId, url } = queue.shift();
    try {
      const { videoLink, images } = await tryDownload(url);
      if (Array.isArray(images) && images.length > 0) {
        await bot.sendMessage(chatId, `🖼️ Найдено фото: ${images.length}`);
        for (const imgUrl of images) await bot.sendPhoto(chatId, imgUrl);
      } else if (videoLink) {
        const videoPath = path.resolve(__dirname, `v_${Date.now()}.mp4`);
        const res = await axios.get(videoLink, { responseType: 'stream' });
        const writer = fs.createWriteStream(videoPath);
        res.data.pipe(writer);
        await new Promise(r => writer.on('finish', r));
        await bot.sendVideo(chatId, videoPath, { caption: '🎬 Вот твоё видео' });
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      }
    } catch (err) { bot.sendMessage(chatId, '⚠️ Ошибка загрузки.'); }
    await new Promise(r => setTimeout(r, 2500));
  }
  isProcessing = false;
}

console.log('🔮 Заклинание наложено. Бот под полным контролем.');
