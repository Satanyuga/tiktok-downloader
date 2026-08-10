const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Охрана Адель активна'));
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

// 🛡️ Синхронизация через API (чтобы не было задержек кэша)
async function syncGitHubLists() {
  const headers = { Authorization: `token ${GITHUB_TOKEN}` };
  
  // 1. Читаем ЧЕРНЫЙ СПИСОК через API
  try {
    const banUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${BLACKLIST_FILE}`;
    const res = await axios.get(banUrl, { headers });
    const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
    
    const rawBans = content.split('\n')
      .map(id => id.trim())
      .filter(id => /^\d+$/.test(id)); // Берем только строки из цифр
    
    BANNED_IDS = new Set(rawBans);
    console.log(`🚫 ЧЕРНЫЙ СПИСОК: ${BANNED_IDS.size} чел. (ID: ${Array.from(BANNED_IDS).join(', ')})`);
  } catch (err) { console.log('⚠️ blacklist.txt не найден или пуст'); }

  // 2. Читаем БЕЛЫЙ СПИСОК через API
  try {
    const usersUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${ALL_USERS_FILE}`;
    const res = await axios.get(usersUrl, { headers });
    const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
    
    const ids = content.split('\n')
      .map(line => {
        const match = line.match(/ID:\s*(\d+)/);
        return match ? match[1].trim() : null;
      })
      .filter(id => id !== null);
    
    ALLOWED_IDS = new Set(ids);
    console.log(`✅ БЕЛЫЙ СПИСОК: ${ALLOWED_IDS.size} чел.`);
  } catch (err) { console.log('⚠️ all_users.txt пока пуст'); }
}

async function writeToGithub(userId, userInfo) {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${ALL_USERS_FILE}`;
  const headers = { Authorization: `token ${GITHUB_TOKEN}` };
  try {
    let currentContent = '';
    let sha = null;
    try {
      const getRes = await axios.get(url, { headers });
      currentContent = Buffer.from(getRes.data.content, 'base64').toString('utf-8');
      sha = getRes.data.sha;
    } catch (e) {}

    if (currentContent.includes(userId)) return; 

    const newContent = currentContent + userInfo + '\n';
    await axios.put(url, {
      message: `👤 Регистрация: ${userId}`,
      content: Buffer.from(newContent).toString('base64'),
      sha: sha
    }, { headers });
    
    ALLOWED_IDS.add(userId);
  } catch (err) { console.error('❌ Ошибка записи:', err.message); }
}

syncGitHubLists();
setInterval(syncGitHubLists, 300000); // Обновление раз в 5 минут

// Автопинг Render
setInterval(() => {
  axios.get("https://tiktokbot-1100.onrender.com/ping").catch(() => {});
}, 300000);

const queue = [];
let isProcessing = false;

// tikwm иногда рвёт соединение / банит запрос без UA — поэтому шлём как браузер.
// Чередуем tikwm.com и www.tikwm.com между попытками — так реже ловим бан по IP рендера.
const TIKWM_HOSTS = ['https://www.tikwm.com', 'https://tikwm.com'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

// 🔄 ГЛАВНЫЙ ОБРАБОТЧИК
bot.on('message', async (msg) => {
  if (!msg.from) return;
  
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text?.trim();

  // 🔥 1. ПЕРВАЯ И ГЛАВНАЯ ПРОВЕРКА: БАН
  if (BANNED_IDS.has(userId)) {
    console.log(`[BAN] Попытка входа от ${userId} отклонена.`);
    return bot.sendMessage(chatId, `🚫 Доступ к боту заблокирован владельцем.

"Вас отправили подумать над своим поведением 😢"`);
  }

  // 2. АВТОРИЗАЦИЯ
  if (text === '🔐 Я человек') {
    const info = `ID: ${userId} | @${msg.from.username || 'null'} | Name: ${msg.from.first_name}`;
    await writeToGithub(userId, info); 
    return bot.sendMessage(chatId, `✅ Доступ разрешен. Теперь присылай ссылки.`, {
      reply_markup: { remove_keyboard: true }
    });
  }

  // 3. ПРОВЕРКА ПРАВ (БЕЛЫЙ СПИСОК)
  if (!ALLOWED_IDS.has(userId)) {
    return bot.sendMessage(chatId, `Привет. Чтобы на бота не напали другие боты)\nПодтверди авторизацию, чтобы я знал, что ты человек. 👇`, {
      reply_markup: {
        keyboard: [['🔐 Я человек']],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
  }

  // 4. РАБОТА СО ССЫЛКАМИ
  if (text?.includes('tiktok.com')) {
    queue.push({ chatId, url: text });
    if (!isProcessing) processQueue();
  } else if (text !== '/start') {
    bot.sendMessage(chatId, '⚠️ Пришли ссылку на TikTok-видео.');
  }
});

// Один заход: спросить у tikwm инфу по ссылке и отправить результат.
// Бросает исключение, если что-то пошло не так (сеть, пустой ответ, ошибка отправки в TG).
async function fetchAndSend(chatId, url, attempt) {
  const host = TIKWM_HOSTS[(attempt - 1) % TIKWM_HOSTS.length];
  const apiUrl = `${host}/api/?url=${encodeURIComponent(url)}`;

  const res = await axios.get(apiUrl, {
    timeout: 15000,
    headers: { 'User-Agent': UA, 'Referer': 'https://www.tikwm.com/' }
  });

  const data = res.data?.data;
  if (!data || (!data.images && !data.play)) {
    // Настоящая причина отказа — видна в логах вместо бесполезного "Ошибка загрузки"
    throw new Error(`tikwm(${host}) пустой ответ: code=${res.data?.code}, msg=${res.data?.msg}`);
  }

  if (data.images) {
    for (const imgUrl of data.images) await bot.sendPhoto(chatId, imgUrl);
  } else if (data.play) {
    const videoPath = path.resolve(__dirname, `v_${Date.now()}_${attempt}.mp4`);
    const vRes = await axios.get(data.play, { responseType: 'stream', timeout: 30000, headers: { 'User-Agent': UA } });
    const writer = fs.createWriteStream(videoPath);
    vRes.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    await bot.sendVideo(chatId, videoPath);
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  }
}

// Проверяет и, если нужно, ПОВТОРЯЕТ попытку сама — без ручной пересылки ссылки юзером.
async function downloadWithRetry(chatId, url) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await fetchAndSend(chatId, url, attempt);
      return; // успех — выходим
    } catch (err) {
      const detail = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}`
        : err.message;
      console.error(`❌ Ошибка загрузки [попытка ${attempt}/${MAX_ATTEMPTS}] ${url} — ${detail}`);

      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        bot.sendMessage(chatId, '⚠️ Не получилось скачать видео после нескольких попыток. Попробуй ещё раз чуть позже.');
      }
    }
  }
}

async function processQueue() {
  isProcessing = true;
  while (queue.length > 0) {
    const { chatId, url } = queue.shift();
    await downloadWithRetry(chatId, url);
    await new Promise(r => setTimeout(r, 2000));
  }
  isProcessing = false;
}
