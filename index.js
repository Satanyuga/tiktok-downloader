import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';

// 🔒 Получаем токен из переменной окружения
const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// 📌 Команда старта
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '🟢 Бот запущен и ждёт ссылку на TikTok!');
});

// 💣 Обработка TikTok ссылки
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Если сообщение содержит TikTok ссылку
  if (text && text.includes('tiktok.com')) {
    bot.sendMessage(chatId, '🔄 Обрабатываю TikTok...');

    try {
      // Просто отправляем ссылку пользователю, без попытки превратить в видео
      bot.sendMessage(chatId, `💾 Скачай видео вручную:\n${text}`);
    } catch (err) {
      console.error('Ошибка при обработке TikTok:', err.message);
      bot.sendMessage(chatId, '❌ Не удалось обработать ссылку. Попробуй другую.');
    }
  }
});

// 🛑 Корректное завершение polling при остановке
process.once('SIGINT', () => bot.stopPolling());
process.once('SIGTERM', () => bot.stopPolling());
