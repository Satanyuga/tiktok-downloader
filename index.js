const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 🔧 Сервер (чтобы Render не убил процесс)
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Gatekeeper Active'));
app.get('/ping', (req, res) => res.send('✅ OK'));
app.listen(PORT, () => console.log(`🧠 Порт: ${PORT}`));

// 🔐 Токены и Настройки
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; 

const REPO_OWNER = 'Satanyuga'; 
const REPO_NAME = 'tiktok-downloader';
const ALL_USERS_FILE = 'all_users.txt';
const BLACKLIST_FILE = 'blacklist.txt';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Локальные списки (Кэш)
let BANNED_IDS = [];
let ALLOWED_IDS = new Set(); // Те, кто уже прошел проверку

// 🔄 Функция обновления списков с GitHub (читаем и друзей, и врагов)
async function syncGitHubLists() {
  const timestamp = Date.now();
  
  // 1. Обновляем Черный список
  try {
    const banUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${BLACKLIST_FILE}?t=${timestamp}`;
    const res = await axios.get(banUrl);
    BANNED_IDS = res.data.split('\n').map(id => id.trim()).filter(id => id.length > 0);
  } catch (err) { /* Файл еще не создан */ }

  // 2. Обновляем Белый список (чтобы не мучить тех, кто уже в базе)
  try {
    const usersUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${ALL_USERS_FILE}?t=${timestamp}`;
    const res = await axios.get(usersUrl);
    const ids = res.data.split('\n')
      .map(line => line.split('|')[0].replace('ID:', '').trim()) // Вытаскиваем только ID
      .filter(id => id.length > 0);
    
    ids.forEach(id => ALLOWED_IDS.add(id));
    console.log(`✅ Базы обновлены. В бане: ${BANNED_IDS.length}, Своих: ${ALLOWED_IDS.size}`);
  } catch (err) { /* Файл еще не создан */ }
}

// 📝 Запись нового человека на GitHub
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
      message: `👤 Новый человек: ${userId}`,
      content: Buffer.from(newContent).toString('base64'),
      sha: sha
    }, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
    
    console.log(`🚀 ${userId} сохранен в базу.`);
  } catch (err) { console.error('❌ Ошибка записи:', err.message); }
}

// Запускаем синхронизацию при старте и каждые 5 минут
syncGitHubLists();
setInterval(syncGitHubLists, 300000);

// Пинг самого себя
setInterval(() => {
  axios.get("https://tiktokbot-1100.onrender.com/ping").catch(() => {});
}, 300000);

const queue = [];
let isProcessing = false;

// 🔄 API для скачивания
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

// 🔥 ГЛАВНЫЙ МОЗГ БОТА
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text?.trim();

  // 1. ЧЕРНЫЙ СПИСОК (Самый строгий фильтр)
  if (BANNED_IDS.includes(userId)) {
    return bot.sendMessage(chatId, `🚫 Доступ закрыт.`);
  }

  // 2. ПРОВЕРКА АВТОРИЗАЦИИ (Нажал ли кнопку?)
  if (text === '🔐 Я человек') {
    const info = `ID: ${userId} | @${msg.from.username || 'no_nick'} | Name: ${msg.from.first_name}`;
    
    // Записываем локально и на GitHub
    ALLOWED_IDS.add(userId);
    await writeToGithub(userId, info); 

    return bot.sendMessage(chatId, `✅ Спасибо! Авторизация успешна. Присылай ссылки.`, {
      reply_markup: { remove_keyboard: true } // Убираем кнопку
    });
  }

  // 3. ЕСЛИ ЧЕЛОВЕК НЕ В СПИСКЕ — ТРЕБУЕМ АВТОРИЗАЦИЮ
  if (!ALLOWED_IDS.has(userId)) {
    return bot.sendMessage(chatId, `Привет. Чтобы на бота не напали другие боты)\nПодтверди авторизацию, чтобы я знал, что ты человек. 👇`, {
      reply_markup: {
        keyboard: [['🔐 Я человек']], // Большая кнопка
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
  }

  // 4. ОБРАБОТКА ССЫЛОК (Только для своих)
  if (text?.includes('tiktok.com')) {
    queue.push({ chatId, url: text });
    if (!isProcessing) processQueue();
  } else {
    // Если прислали просто текст, но авторизация уже пройдена
    bot.sendMessage(chatId, '⚠️ Это не ссылка на TikTok. Пришли ссылку на видео.');
  }
});

// ⚙️ Очередь скачивания
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
  throw new Error('API Fail');
}

async function processQueue() {
  isProcessing = true;
  while (queue.length > 0) {
    const { chatId, url } = queue.shift();
    try {
      const { videoLink, images } = await tryDownload(url);
      
      if (Array.isArray(images) && images.length > 0) {
        await bot.sendMessage(chatId, `🖼️ Фото-карусель: ${images.length} шт.`);
        for (const imgUrl of images) await bot.sendPhoto(chatId, imgUrl);
      } else if (videoLink) {
        const videoPath = path.resolve(__dirname, `v_${Date.now()}.mp4`);
        const res = await axios.get(videoLink, { responseType: 'stream' });
        const writer = fs.createWriteStream(videoPath);
        res.data.pipe(writer);
        await new Promise(r => writer.on('finish', r));
        await bot.sendVideo(chatId, videoPath, { caption: '🎬 Готово' });
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      } else {
        bot.sendMessage(chatId, '📭 Контент не доступен.');
      }
    } catch (err) { bot.sendMessage(chatId, '⚠️ Не удалось скачать.'); }
    await new Promise(r => setTimeout(r, 2000));
  }
  isProcessing = false;
}
