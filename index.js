var Telegram = require('node-telegram-bot-api');
var request = require('request');

var token = '8378347903:AAGH5GCOaKGWFIBIPO3hV5-AntVGGLOsCC8';
var opt = { polling: true };

var bot = new Telegram(token, opt);

function delay(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

bot.on('message', function(msg) {
  var text = msg.text;

  console.log(`Получено сообщение от ${msg.chat.id}: ${text}`);

  if (text === '/start') {
    bot.sendMessage(msg.chat.id, '👋 Привет! Я бот для скачивания TikTok-видео без водяного знака.');

    delay(500).then(() => bot.sendMessage(msg.chat.id, '✨ Просто пришли мне ссылку на видео.'));
  } else if (text && text.includes('tiktok.com')) {
    bot.sendMessage(msg.chat.id, '⏳ Подожди немного, обрабатываю ссылку...');

    var reqvideourl = 'https://www.tikwm.com/api/?url=' + text + '&hd=1';

    request(reqvideourl, function(error, response, body) {
      try {
        var json = JSON.parse(body);

        if (!json.data || !json.data.hdplay) {
          bot.sendMessage(msg.chat.id, '😔 Не удалось получить видео. Попробуй позже или проверь ссылку.');
        } else {
          delay(500).then(() => bot.sendVideo(msg.chat.id, json.data.hdplay));
        }
      } catch (e) {
        bot.sendMessage(msg.chat.id, '⚠️ Произошла ошибка при обработке. Попробуй снова.');
        console.error('Ошибка при парсинге JSON:', e);
      }
    });
  } else {
    bot.sendMessage(msg.chat.id, '🧐 Пришли, пожалуйста, ссылку на TikTok-видео.');
  }
});
