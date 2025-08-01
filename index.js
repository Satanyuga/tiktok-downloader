const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

// 🔑 Вставь сюда свой токен
const token = '8378347903:AAGH5GCOaKGWFIBIPO3hV5-AntVGGLOsCC8';

// 🚀 Запускаем бот с polling
const bot = new TelegramBot(token, { polling: true });

// ⏳ Простая задержка
function delay(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

// ✅ Стартовое сообщение
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  console.log(`Получено сообщение от ${chatId}: ${text}`);

  if (text === '/start') {
    bot.sendMessage(chatId, '👋 Привет! Я бот для скачивания TikTok-видео без водяного знака.');
    await delay(500);
    bot.sendMessage(chatId, '✨ Просто пришли мне ссылку на видео.');
  } else if (text.includes('tiktok.com')) {
    bot.sendMessage(chatId, '⏳ Скачиваю видео, подожди чуть-чуть...');

    const apiUrl = `https://www.tikwm.com/api/?url=${text}&hd=1`;

    try {
      const res = await fetch(apiUrl);
      const json = await res.json();

      if (!json.data || !json.data.hdplay) {
        bot.sendMessage(chatId, '😔 Не удалось получить видео. Возможно, ссылка нерабочая или TikTok временно недоступен.');
        return;
      }

      await delay(500);
      bot.sendVideo(chatId, json.data.hdplay);
    } catch (err) {
      console.error('Ошибка при загрузке:', err);
      bot.sendMessage(chatId, '⚠️ Произошла ошибка при скачивании. Попробуй снова позже.');
    }
  } else {
    bot.sendMessage(chatId, '🧐 Пришли, пожалуйста, ссылку на TikTok-видео.');
  }
});
