const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ✅ токен теперь берётся из переменной среды
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

if (!TELEGRAM_TOKEN) {
  throw new Error('❌ TELEGRAM_TOKEN не установлен в переменных среды.');
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text.trim();

  if (!url.startsWith('http')) {
    return bot.sendMessage(chatId, '⚠️ Это не похоже на TikTok ссылку.');
  }

  try {
    const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(url)}`;
    const { data } = await axios.get(apiUrl);

    const videoLink = data?.data?.play;
    if (!videoLink) {
      return bot.sendMessage(chatId, '🚫 Видео не найдено.');
    }

    const filename = `video_${Date.now()}.mp4`;
    const videoPath = path.resolve(__dirname, filename);
    const videoStream = await axios.get(videoLink, { responseType: 'stream' });

    const writer = fs.createWriteStream(videoPath);
    videoStream.data.pipe(writer);

    writer.on('finish', async () => {
      await bot.sendVideo(chatId, videoPath, { caption: '🎬 Вот твоё видео' });
      fs.unlinkSync(videoPath); // удаляем файл после отправки
    });

    writer.on('error', () => {
      bot.sendMessage(chatId, '❌ Ошибка при записи видео.');
    });
  } catch (err) {
    bot.sendMessage(chatId, '🔥 Ошибка: ' + err.message);
  }
});
