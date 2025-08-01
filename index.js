const Telegram = require('node-telegram-bot-api');
const request = require('request');
const fetch = require('node-fetch');

const token = '8378347903:AAGH5GCOaKGWFIBIPO3hV5-AntVGGLOsCC8';

(async () => {
  try {
    // 🔐 Удаляем webhook, чтобы Telegram не конфликтовал
    await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
    console.log('✅ Webhook удалён перед стартом polling');

    const opt = { polling: true };
    const bot = new Telegram(token, opt);

    console.log('🐱‍👤 Бот запущен и начал polling');

    function delay(time) {
      return new Promise(resolve => setTimeout(resolve, time));
    }

    // 🛡️ Проверка, чтобы не запускался polling повторно
    let isActive = false;
    if (isActive) {
      console.log('⚠️ Бот уже работает — повторный запуск отменён');
      return;
    }
    isActive = true;

    bot.on('message', async function(msg) {
      const text = msg.text;

      console.log(`📩 Получено сообщение от ${msg.chat.id}: ${text}`);

      if (text === '/start') {
        await bot.sendMessage(msg.chat.id, '👋 Привет! Я бот для скачивания TikTok-видео без водяного знака.');
        await delay(500);
        await bot.sendMessage(msg.chat.id, '✨ Просто пришли мне ссылку на видео.');
      } else if (text && text.includes('tiktok.com')) {
        await bot.sendMessage(msg.chat.id, '⏳ Подожди немного, обрабатываю ссылку...');
        const reqvideourl = 'https://www.tikwm.com/api/?url=' + text + '&hd=1';

        request(reqvideourl, async function(error, response, body) {
          try {
            const json = JSON.parse(body);
            if (!json.data || !json.data.hdplay) {
              await bot.sendMessage(msg.chat.id, '😔 Не удалось получить видео. Попробуй позже или проверь ссылку.');
            } else {
              await delay(500);
              await bot.sendVideo(msg.chat.id, json.data.hdplay);
            }
          } catch (e) {
            await bot.sendMessage(msg.chat.id, '⚠️ Произошла ошибка при обработке. Попробуй снова.');
            console.error('❌ Ошибка при парсинге JSON:', e);
          }
        });
      } else {
        await bot.sendMessage(msg.chat.id, '🧐 Пришли, пожалуйста, ссылку на TikTok-видео.');
      }
    });
  } catch (err) {
    console.error('🔥 Фатальная ошибка при запуске:', err);
  }
})();
