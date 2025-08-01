const TelegramBot = require('node-telegram-bot-api');

// 🚨 ВПИСАННЫЙ ТОКЕН БЕЗ заморочек
const token = '8378347903:AAGH5GCOaKGWFIBIPO3hV5-AntVGGLOsCC8';

const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '🟢 Бот работает. Сюда кидай TikTok-ссылку.');
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text && text.includes('tiktok.com')) {
    try {
      bot.sendMessage(chatId, `🔗 Видео:\n${text}\n⚠️ Отправка как видео не поддерживается, скачай вручную.`);
    } catch (err) {
      console.error('Ошибка при обработке:', err.message);
      bot.sendMessage(chatId, '❌ Что-то пошло не так, попробуй другую ссылку.');
    }
  }
});

// Корректная остановка polling
process.once('SIGINT', () => bot.stopPolling());
process.once('SIGTERM', () => bot.stopPolling());
