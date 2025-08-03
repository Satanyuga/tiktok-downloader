const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');

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

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text?.trim();
  if (!url?.startsWith('http') || !url.includes('tiktok')) {
    return bot.sendMessage(chatId, '⚠️ Это не похоже на TikTok ссылку.');
  }
  queue.push({ chatId, url });
  if (!isProcessing) processQueue();
});

async function extractImages(url) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });

  const images = await page.$$eval('img', imgs =>
    imgs.map(img => img.src).filter(src =>
      src.includes('object') && src.endsWith('.jpg')
    )
  );

  await browser.close();
  return [...new Set(images)];
}

async function processQueue() {
  isProcessing = true;
  while (queue.length > 0) {
    const { chatId, url } = queue.shift();
    try {
      const imgs = await extractImages(url);
      if (imgs.length > 0) {
        const mediaGroup = imgs.map((src, i) => ({
          type: 'photo',
          media: src,
          caption: i === 0 ? '🖼️ Галерея TikTok' : undefined
        }));
        await bot.sendMediaGroup(chatId, mediaGroup);
      } else {
        await bot.sendMessage(chatId, '📭 Нет изображений в ссылке.');
      }
    } catch (err) {
      await bot.sendMessage(chatId, `🔥 Ошибка: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  isProcessing = false;
}

setInterval(() => {
  require('axios').get(RENDER_URL + '/')
    .then(() => console.log('📡 Render проснулся'))
    .catch(e => console.error('⚠️ Пинг упал:', e.message));
}, 5 * 60 * 1000);
