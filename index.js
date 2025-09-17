// 📦 Импорт модулей
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 🔧 Express сервер для Render
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Bot is alive'));
app.get('/ping', (req, res) => res.send('✅ Ping OK'));
app.listen(PORT, () => console.log(`🧠 Express слушает порт ${PORT}`));

// 🔐 Telegram токен из ENV
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('❌ TELEGRAM_TOKEN не указан.');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// === ОДНОРАЗОВАЯ ПРОВЕРКА ДЛЯ УДАЛЕНИЯ WEBHOOK ===
(async () => {
    try {
        await bot.deleteWebHook();
        console.log('✅ Webhook успешно удален!');
        process.exit(0); // Выходим, чтобы потом запустить основной код
    } catch (e) {
        console.error('❌ Не удалось удалить Webhook:', e.message);
        process.exit(1);
    }
})();
// ===============================================
