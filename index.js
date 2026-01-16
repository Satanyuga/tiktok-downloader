const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Gatekeeper Active'));
app.get('/ping', (req, res) => res.send('✅ OK'));
app.listen(PORT, () => console.log(`🧠 Порт: ${PORT}`));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; 

const REPO_OWNER = 'Satanyuga'; 
const REPO_NAME = 'tiktok-downloader';
const ALL_USERS_FILE = 'all_users.txt';
const BLACKLIST_FILE = 'blacklist.txt';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let BANNED_IDS = new Set();
let ALLOWED_IDS = new Set();

// 🔄 Жесткая синхронизация списков
async function syncGitHubLists() {
  const timestamp = Date.now();
  
  // 1. Обновляем ЧЕРНЫЙ СПИСОК
  try {
    const banUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${BLACKLIST_FILE}?t=${timestamp}`;
    const res = await axios.get(banUrl);
    const rawBans = res.data.split('\n')
      .map(id => id.trim())
      .filter(id => id.length > 5);
    
    BANNED_IDS = new Set(rawBans);
    console.log(`🚫 БАЗА ОБНОВЛЕНА. В БАНЕ: ${BANNED_IDS.size}`);
  } catch (err) { console.log('⚠️ Blacklist пуст или ошибка'); }

  // 2. Обновляем БЕЛЫЙ СПИСОК
  try {
    const usersUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${ALL_USERS_FILE}?t=${timestamp}`;
    const res = await axios.get(usersUrl);
    const ids = res.data.split('\n')
      .map(line => {
        const match = line.match(/ID:\s*(\d+)/);
        return match ? match[1].trim() : null;
      })
      .filter(id => id !== null);
    
    ALLOWED_IDS = new Set(ids);
    console.log(`✅ СВОИХ В БАЗЕ: ${ALLOWED_IDS.size}`);
  } catch (err) { console.log('⚠️ Файл пользователей пуст'); }
}

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
      message: `👤 Регистрация: ${userId}`,
      content: Buffer.from(newContent).toString('base64'),
      sha: sha
    }, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
    
    ALLOWED_IDS.add(userId);
  } catch (err) { console.error('❌ Ошибка записи:', err.message); }
}

syncGitHubLists();
setInterval(syncGitHubLists, 300000);

setInterval(() => {
  axios.get("https://tiktokbot-1100.onrender.com/ping").catch(() => {});
}, 300000);

const queue = [];
let isProcessing = false;

const APIs = [
  {
    name: 'tikwm',
    url: (url) => `https://tikwm.com/api/?url=${encodeURIComponent(url)}`,
    parser: (data) => ({ videoLink: data?.data?.play, images: data?.data?.images })
  }
];

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text?.trim();

  // 🔥 1. ПЕРВООЧЕРЕДНАЯ ПРОВЕРКА БАНА
  if (BANNED_IDS.has(userId)) {
    console.log(`[BAN SYSTEM] Заблокирован вход для: ${userId}`);
    return bot.sendMessage(chatId, `🚫 Доступ к боту заблокирован владельцем.`);
  }

  // 2. АВТОРИЗАЦИЯ
  if (text === '🔐 Я человек') {
    const info = `ID: ${userId} | @${msg.from.username || 'null'} | Name: ${msg.from.first_name}`;
    await writeToGithub(userId, info); 
    return bot.sendMessage(chatId, `✅ Доступ разрешен. Можешь присылать ссылки.`, {
      reply_markup: { remove_keyboard: true }
    });
  }

  // 3. ЕСЛИ НЕ В СПИСКЕ — КНОПКА
  if (!ALLOWED_IDS.has(userId)) {
    return bot.sendMessage(chatId, `Привет. Чтобы на бота не напали другие боты)\nПодтверди авторизацию, чтобы я знал, что ты человек. 👇`, {
      reply_markup: {
        keyboard: [['🔐 Я человек']],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
  }

  // 4. СКАТКА
  if (text?.includes('tiktok.com')) {
    queue.push({ chatId, url: text });
    if (!isProcessing) processQueue();
  } else if (text !== '/start') {
    bot.sendMessage(chatId, '⚠️ Пришли корректную ссылку на TikTok.');
  }
});

async function processQueue() {
  isProcessing = true;
  while (queue.length > 0) {
    const { chatId, url } = queue.shift();
    try {
      const res = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(url)}`);
      const data = res.data.data;
      if (data?.images) {
        for (const imgUrl of data.images) await bot.sendPhoto(chatId, imgUrl);
      } else if (data?.play) {
        const videoPath = path.resolve(__dirname, `v_${Date.now()}.mp4`);
        const vRes = await axios.get(data.play, { responseType: 'stream' });
        const writer = fs.createWriteStream(videoPath);
        vRes.data.pipe(writer);
        await new Promise(r => writer.on('finish', r));
        await bot.sendVideo(chatId, videoPath);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      }
    } catch (err) { console.log('Ошибка скачивания'); }
    await new Promise(r => setTimeout(r, 2000));
  }
  isProcessing = false;
}
