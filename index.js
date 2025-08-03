const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');

const app = express();
const PORT = process.env.PORT || 3000;
const RENDER_URL = 'https://tiktokbot-1100.onrender.com';

app.get('/', (req, res) => res.send('🤖 Bot is alive'));
app.listen(PORT, () => console.log(`🧠 Express слушает порт ${PORT}`));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('❌ TELEGRAM_TOKEN не установлен.');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const queue = [];
let isProcessing = false;

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();
  if (!url?.startsWith('http') || !url.includes('tiktok')) {
    return bot.sendMessage(chatId, '⚠️ Это не похоже на TikTok ссылку. Пришли корректную.');
  }

  queue.push({ chatId, url });
  if (!isProcessing) processQueue();
});

async function extractImages(url) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath,
    headless: chromium.headless,
  });

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });

  const imgs = await page.$$eval('img', list =>
    list.map(img => img.src).filter(src =>
      src.includes('object') && src.endsWith('.jpg')
    )
  );

  await browser.close();
  return [...new Set(imgs)];
}

async function processQueue() {
  isProcessing = true;
  while (queue.length > 0) {
    const { chatId, url } = queue.shift();
    try {
      const { data } = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(url)}`);
      const videoLink = data?.data?.play;

      if (videoLink) {
        const filename = `video_${Date.now()}.mp4`;
        const videoPath = path.resolve(__dirname, filename);
        const stream = await axios.get(videoLink, { responseType: 'stream' });
        const writer = fs.createWriteStream(videoPath);
        stream.data.pipe(writer);
        await new Promise((res, rej) => {
          writer.on('finish', res);
          writer.on('error', rej);
        });

        chatId !== 'internal_ping'
          ? await bot.sendVideo(chatId, videoPath, { caption: '🎬 Вот твоё видео' })
          : console.log(`✅ Видео скачано: ${filename}`);

        fs.unlinkSync(videoPath);
      } else {
        const images = await extractImages(url);
        if (images.length > 0) {
          const mediaGroup = images.map((img, i) => ({
            type: 'photo',
            media: img,
            caption: i === 0 ? '🖼️ Галерея TikTok' : undefined
          }));
          chatId !== 'internal_ping'
            ? await bot.sendMediaGroup(chatId, mediaGroup)
            : console.log(`✅ Изображений: ${images.length}`);
        } else {
          chatId !== 'internal_ping'
            ? await bot.sendMessage(chatId, '📭 Ничего не найдено.')
            : console.log('📭 Нет галереи');
        }
      }
    } catch (err) {
      chatId !== 'internal_ping'
        ? await bot.sendMessage(chatId, `🔥 Ошибка: ${err.message}`)
        : console.error('🔥 Ошибка:', err.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  isProcessing = false;
}

(async () => {
  try {
    const me = await bot.getMe();
    console.log(`🤖 Бот активен: @${me.username}`);
  } catch (err) {
    console.error('❌ Ошибка getMe:', err.message);
  }
})();

process.once('SIGINT', () => {
  console.log('🧨 SIGINT. Завершаем...');
  process.exit(0);
});
process.once('SIGTERM', () => {
  console.log('🔪 SIGTERM. Уничтожение...');
  process.exit(0);
});

setInterval(() => {
  axios.get(RENDER_URL + '/')
    .then(() => console.log('📡 Render пинг прошёл'))
    .catch((e) => console.error('⚠️ Пинг ошибка:', e.message));
}, 5 * 60 * 1000);

setInterval(() => {
  queue.push({
    chatId: 'internal_ping',
    url: 'https://www.tiktok.com/@bellapoarch/video/7338180453062479134?is_from_webapp=1&sender_device=pc'
  });
  console.log('📥 Автозапрос добавлен');
  if (!isProcessing) processQueue();
}, 5 * 60 * 1000);
