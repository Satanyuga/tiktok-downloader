var Telegram = require('node-telegram-bot-api');
var request = require("request");
var token = '8378347903:AAGH5GCOaKGWFIBIPO3hV5-AntVGGLOsCC8';

// Конфигурация бота с polling
var opt = {
  polling: true
};

var bot = new Telegram(token, opt);

// Обработчик входящих сообщений
bot.on("message", function(msg) {
  var text = msg.text;

  if (text == '/start') {
    bot.sendMessage(msg.chat.id, "👋 Привет! Я бот для скачивания TikTok-видео без водяного знака.");
    
    function delay(time) {
      return new Promise(resolve => setTimeout(resolve, time));
    }

    delay(500).then(() => bot.sendMessage(msg.chat.id, "✨ Просто пришли мне ссылку на видео"));
  } else if (text.includes('tiktok.com')) {
    bot.sendMessage(msg.chat.id, "⏳ Обрабатываю ссылку...");

    var reqvideourl = "https://www.tikwm.com/api/?url=" + text + "&hd=1";
    request(reqvideourl, function(error, response, body) {
      var json = JSON.parse(body);

      if (json.data == undefined) {
        bot.sendMessage(msg.chat.id, "😔 Сейчас не могу скачать это видео. Попробуй позже.");
      } else {
        function delay(time) {
          return new Promise(resolve => setTimeout(resolve, time));
        }

        delay(500).then(() => bot.sendVideo(msg.chat.id, json.data.hdplay));
      }
    });
  } else {
    bot.sendMessage(msg.chat.id, "🧐 Пожалуйста, пришли корректную ссылку на видео TikTok.");
  }
});
