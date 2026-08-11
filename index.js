const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const TiktokDL = require('@tobyg74/tiktok-api-dl');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Охрана Адель активна'));
app.get('/ping', (req, res) => res.send('✅ OK'));
app.listen(PORT, () => console.log(`🧠 Порт: ${PORT}`));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; 

const REPO_OWNER = 'Satanyuga'; 
const REPO_NAME = 'tiktok-downloader';
const ALL_USERS_FILE = 'all_users.txt';
const BLACKLIST_FILE = 'blacklist.txt';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Страховка: одна неожиданная ошибка (например, необычный формат ответа от API)
// не должна ронять ВЕСЬ процесс и отключать бота для всех пользователей разом.
process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException (бот продолжает работать):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('💥 unhandledRejection (бот продолжает работать):', err);
});

// 409 Conflict = где-то ЕЩЁ работает второй polling-инстанс с этим же токеном
// (старый деплой на Render не остановился, или бот запущен локально/на другом сервисе).
// Сам по себе процесс это не чинит — нужно погасить второй инстанс руками.
bot.on('polling_error', (error) => {
  if (error.code === 'ETELEGRAM' && /409/.test(error.message)) {
    console.error('⚠️ 409 Conflict: где-то работает ещё один инстанс бота с этим токеном. Проверь Render (старые деплои/сервисы) и локальные запуски.');
  } else {
    console.error('⚠️ polling_error:', error.code, error.message);
  }
});

let BANNED_IDS = new Set();
let ALLOWED_IDS = new Set();

// 🛡️ Синхронизация через API (чтобы не было задержек кэша)
async function syncGitHubLists() {
  const headers = { Authorization: `token ${GITHUB_TOKEN}` };
  
  // 1. Читаем ЧЕРНЫЙ СПИСОК через API
  try {
    const banUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${BLACKLIST_FILE}`;
    const res = await axios.get(banUrl, { headers });
    const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
    
    const rawBans = content.split('\n')
      .map(id => id.trim())
      .filter(id => /^\d+$/.test(id)); // Берем только строки из цифр
    
    BANNED_IDS = new Set(rawBans);
    console.log(`🚫 ЧЕРНЫЙ СПИСОК: ${BANNED_IDS.size} чел. (ID: ${Array.from(BANNED_IDS).join(', ')})`);
  } catch (err) { console.log('⚠️ blacklist.txt не найден или пуст'); }

  // 2. Читаем БЕЛЫЙ СПИСОК через API
  try {
    const usersUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${ALL_USERS_FILE}`;
    const res = await axios.get(usersUrl, { headers });
    const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
    
    const ids = content.split('\n')
      .map(line => {
        const match = line.match(/ID:\s*(\d+)/);
        return match ? match[1].trim() : null;
      })
      .filter(id => id !== null);
    
    ALLOWED_IDS = new Set(ids);
    console.log(`✅ БЕЛЫЙ СПИСОК: ${ALLOWED_IDS.size} чел.`);
  } catch (err) { console.log('⚠️ all_users.txt пока пуст'); }
}

async function writeToGithub(userId, userInfo) {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${ALL_USERS_FILE}`;
  const headers = { Authorization: `token ${GITHUB_TOKEN}` };
  try {
    let currentContent = '';
    let sha = null;
    try {
      const getRes = await axios.get(url, { headers });
      currentContent = Buffer.from(getRes.data.content, 'base64').toString('utf-8');
      sha = getRes.data.sha;
    } catch (e) {}

    if (currentContent.includes(userId)) return; 

    const newContent = currentContent + userInfo + '\n';
    await axios.put(url, {
      message: `👤 Регистрация: ${userId}`,
      content: Buffer.from(newContent).toString('base64'),
      sha: sha
    }, { headers });
    
    ALLOWED_IDS.add(userId);
  } catch (err) { console.error('❌ Ошибка записи:', err.message); }
}

syncGitHubLists();
setInterval(syncGitHubLists, 300000); // Обновление раз в 5 минут

// Автопинг Render
setInterval(() => {
  axios.get("https://tiktokbot-1100.onrender.com/ping").catch(() => {});
}, 300000);

const queue = [];
let isProcessing = false;

// tikwm.com банит IP хостингов (Render/AWS/итд) — обычный ретрай туда же бессмысленен.
// Поэтому опрашиваем НЕЗАВИСИМЫЕ провайдеры ПАРАЛЛЕЛЬНО: v1=tikwm, v2=ssstik, v3=musicaldown.
// Если один забанен/лежит — используем того, кто ответит первым успехом.
const VERSIONS = ['v1', 'v2', 'v3'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// У каждого провайдера свой CDN — некоторые отдают видео только с "правильным" Referer,
// а без него подсовывают HTML-заглушку вместо настоящего mp4 (отсюда "битые" видео-документы).
const REFERERS = {
  v1: 'https://www.tikwm.com/',
  v2: 'https://ssstik.io/',
  v3: 'https://musicaldown.com/'
};
// Сколько ссылок скачиваем ОДНОВРЕМЕННО — раньше было 1, отсюда и "трюльками по одной раз в 5 минут".
const CONCURRENCY = 3;
const RETRY_ROUNDS = 2; // сколько раз повторить полный круг по всем провайдерам, если все отказали
// Telegram Bot API режет загрузку файлов на 50MB — берём с запасом.
const MAX_TELEGRAM_BYTES = 49 * 1024 * 1024;

// Ловит ссылки вида vt.tiktok.com/..., vm.tiktok.com/..., www.tiktok.com/@user/video/...
const TIKTOK_URL_REGEX = /https?:\/\/(?:[\w-]+\.)?tiktok\.com\/\S+/gi;

// 🔄 ГЛАВНЫЙ ОБРАБОТЧИК
bot.on('message', async (msg) => {
  if (!msg.from) return;
  
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text?.trim();

  // 🔥 1. ПЕРВАЯ И ГЛАВНАЯ ПРОВЕРКА: БАН
  if (BANNED_IDS.has(userId)) {
    console.log(`[BAN] Попытка входа от ${userId} отклонена.`);
    return bot.sendMessage(chatId, `🚫 Доступ к боту заблокирован владельцем.

"Вас отправили подумать над своим поведением 😢"`);
  }

  // 2. АВТОРИЗАЦИЯ
  if (text === '🔐 Я человек') {
    const info = `ID: ${userId} | @${msg.from.username || 'null'} | Name: ${msg.from.first_name}`;
    await writeToGithub(userId, info); 
    return bot.sendMessage(chatId, `✅ Доступ разрешен. Теперь присылай ссылки.`, {
      reply_markup: { remove_keyboard: true }
    });
  }

  // 3. ПРОВЕРКА ПРАВ (БЕЛЫЙ СПИСОК)
  if (!ALLOWED_IDS.has(userId)) {
    return bot.sendMessage(chatId, `Привет. Чтобы на бота не напали другие боты)\nПодтверди авторизацию, чтобы я знал, что ты человек. 👇`, {
      reply_markup: {
        keyboard: [['🔐 Я человек']],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
  }

  // 4. РАБОТА СО ССЫЛКАМИ — достаём ВСЕ tiktok-ссылки из сообщения (их может быть несколько,
  // например при пересылке нескольких сообщений одним блоком) и добавляем каждую отдельно.
  const links = text ? text.match(TIKTOK_URL_REGEX) : null;
  if (links && links.length) {
    for (const link of links) {
      // Статус-сообщение сразу — юзер видит, что ссылка принята и бот уже работает.
      const statusMsg = await bot.sendMessage(chatId, '⏳ Скачиваю видео...');
      queue.push({ chatId, url: link, statusMsgId: statusMsg.message_id });
    }
    if (!isProcessing) processQueue();
  } else if (text !== '/start') {
    bot.sendMessage(chatId, '⚠️ Пришли ссылку на TikTok-видео.');
  }
});

// Достаёт ссылку(и) на медиа из ответа, формат которого отличается между версиями API.
function extractMedia(version, result) {
  if (!result) return null;

  if (result.type === 'image' && result.images?.length) {
    return { images: result.images };
  }

  let videoUrl = null;
  if (version === 'v1') { // tikwm
    videoUrl = result.video?.playAddr?.[0] || result.video?.downloadAddr?.[0];
  } else if (version === 'v2') { // ssstik
    videoUrl = result.video?.playAddr || result.direct;
  } else if (version === 'v3') { // musicaldown
    videoUrl = result.videoHD || result.videoWatermark;
  }

  if (videoUrl) return { video: videoUrl };
  if (result.images?.length) return { images: result.images }; // на случай type не проставлен
  return null;
}

// Спрашивает у ОДНОГО конкретного провайдера ссылку на медиа (без скачивания и отправки).
async function fetchMedia(url, version) {
  const res = await TiktokDL.Downloader(url, { version });
  if (res.status !== 'success' || !res.result) {
    throw new Error(`tiktok-dl(${version}) отказ: ${res.message || 'без сообщения'}`);
  }
  const media = extractMedia(version, res.result);
  if (!media) throw new Error(`tiktok-dl(${version}) не нашёл медиа в ответе`);
  return { version, media };
}

// Опрашивает ВСЕ провайдеры ПАРАЛЛЕЛЬНО — используем того, кто первым ответил успехом.
// Это сильно быстрее последовательного перебора: не ждём таймаут/бан одного, чтобы пойти к следующему.
async function fetchMediaAnyProvider(url) {
  const attempts = VERSIONS.map(v => fetchMedia(url, v));
  try {
    return await Promise.any(attempts);
  } catch (aggErr) {
    const details = (aggErr.errors || [aggErr]).map(e => e.message).join(' | ');
    throw new Error(`все провайдеры отказали: ${details}`);
  }
}

// Скачивает файл по ссылке и проверяет, что это ДЕЙСТВИТЕЛЬНО видео, а не HTML-заглушка
// (некоторые CDN без правильного Referer отдают страницу "доступ запрещён" вместо mp4 —
// именно из-за этого часть видео раньше приходила "битым документом" без превью).
async function downloadAndValidate(mediaUrl, version, destPath) {
  const vRes = await axios.get(mediaUrl, {
    responseType: 'stream',
    timeout: 30000,
    headers: { 'User-Agent': UA, 'Referer': REFERERS[version] || '' }
  });

  const contentType = vRes.headers['content-type'] || '';
  if (contentType && !contentType.startsWith('video') && !contentType.includes('octet-stream')) {
    throw new Error(`${version}: сервер отдал не видео (content-type: ${contentType})`);
  }

  const writer = fs.createWriteStream(destPath);
  vRes.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
  if (size < 20000) { // меньше ~20KB — почти наверняка не настоящее видео, а заглушка/ошибка
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    throw new Error(`${version}: подозрительно маленький файл (${size} байт), похоже на заглушку`);
  }
}

// Запускает ffmpeg и всегда резолвит с {code, stderr} — не бросает исключение на ненулевом коде,
// это нужно и для обычных команд, и для "пробы" длительности видео (см. ниже).
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => resolve({ code, stderr }));
  });
}

// Узнаём длительность видео без полного декодирования — ffmpeg печатает "Duration: HH:MM:SS.xx"
// в stderr ещё до того, как ругнётся на отсутствие выходного файла.
async function probeDurationSeconds(input) {
  const { stderr } = await runFfmpeg(['-i', input]);
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

// Перекладывает контейнер (moov atom в начало) БЕЗ перекодирования — мгновенно и без потери качества.
// Чинит конкретный баг: некоторые провайдеры отдают mp4, в котором Telegram не видит длительность/превью
// и показывает видео как "файл, надо скачать" вместо проигрываемого ролика.
async function remux(input, output) {
  const { code, stderr } = await runFfmpeg(['-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', output]);
  if (code !== 0) throw new Error(`remux exit ${code}: ${stderr.slice(-300)}`);
}

// Сжимает ПОД ТОЧНЫЙ РАЗМЕР — считаем битрейт из длительности видео и целевого размера,
// вместо того чтобы вслепую понижать разрешение. Разрешение остаётся оригинальным —
// это даёт заметно лучшее качество на тот же вес, чем фиксированный crf+downscale.
async function compressToFit(input, output, targetBytes) {
  const duration = (await probeDurationSeconds(input)) || 180; // не смогли определить — считаем как 3 мин (перестрахуемся)
  const audioKbps = 128;
  const safetyMargin = 0.93; // запас под накладные расходы контейнера и пики битрейта
  let videoKbps = Math.floor((targetBytes * 8 / 1024 / duration) * safetyMargin - audioKbps);
  if (videoKbps < 300) videoKbps = 300; // ниже уже совсем плохо будет выглядеть, но это край случая для очень длинных роликов

  const { code, stderr } = await runFfmpeg([
    '-y', '-i', input,
    '-c:v', 'libx264', '-preset', 'medium', // medium вместо veryfast — заметно лучше качество на тот же битрейт
    '-b:v', `${videoKbps}k`, '-maxrate', `${Math.floor(videoKbps * 1.2)}k`, '-bufsize', `${videoKbps * 2}k`,
    '-c:a', 'aac', '-b:a', `${audioKbps}k`,
    '-movflags', '+faststart',
    output
  ]);
  if (code !== 0) throw new Error(`compress exit ${code}: ${stderr.slice(-300)}`);
}

// Сжимает ТОЛЬКО если файл реально больше лимита Telegram. Маленькие видео эта функция не трогает вообще.
async function ensureUnderTelegramLimit(inputPath, chatId, statusMsgId) {
  const size = fs.statSync(inputPath).size;
  if (size <= MAX_TELEGRAM_BYTES) return inputPath;

  console.log(`⚙️ Видео ${(size / 1024 / 1024).toFixed(1)}MB больше лимита ${(MAX_TELEGRAM_BYTES / 1024 / 1024).toFixed(0)}MB — сжимаю под точный размер...`);
  if (statusMsgId) {
    bot.editMessageText('📦 Видео не влезает по размеру, сжимаю без потери качества...', { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
  }

  const outPath = inputPath.replace(/\.mp4$/, '') + '_fit.mp4';
  await compressToFit(inputPath, outPath, MAX_TELEGRAM_BYTES);

  if (fs.statSync(outPath).size > MAX_TELEGRAM_BYTES) {
    // Расчёт битрейта — оценка (VBR пики, реальный muxing overhead), иногда чуть промахивается.
    // Один дожим с меньшим запасом — и всё, дальше не гоняем по кругу до бесконечности.
    const outPath2 = inputPath.replace(/\.mp4$/, '') + '_fit2.mp4';
    await compressToFit(outPath, outPath2, Math.floor(MAX_TELEGRAM_BYTES * 0.88));
    fs.unlinkSync(outPath);
    if (statusMsgId) bot.editMessageText('✅ Сжато, отправляю...', { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
    return outPath2;
  }

  if (statusMsgId) bot.editMessageText('✅ Сжато, отправляю...', { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
  return outPath;
}

// Один полный круг: спросить у провайдеров (параллельно) и отправить результат в Telegram.
async function fetchAndSend(chatId, url, roundAttempt, statusMsgId) {
  const { version, media } = await fetchMediaAnyProvider(url);

  if (media.images) {
    for (const imgUrl of media.images) await bot.sendPhoto(chatId, imgUrl);
    return;
  }

  const videoPath = path.resolve(__dirname, `v_${Date.now()}_${roundAttempt}.mp4`);
  await downloadAndValidate(media.video, version, videoPath);

  // Всегда чиним контейнер (faststart) — без этого часть видео Telegram показывает
  // как "файл, нужно скачать" вместо проигрываемого ролика. Это ремукс, не перекодирование:
  // быстро и без малейшей потери качества.
  const remuxedPath = videoPath.replace(/\.mp4$/, '') + '_r.mp4';
  await remux(videoPath, remuxedPath);
  fs.unlinkSync(videoPath);

  const sendPath = await ensureUnderTelegramLimit(remuxedPath, chatId, statusMsgId);

  // filename/contentType — чтобы Telegram точно распознал файл как проигрываемое видео.
  await bot.sendVideo(chatId, sendPath, { supports_streaming: true }, { filename: 'video.mp4', contentType: 'video/mp4' });

  if (fs.existsSync(remuxedPath)) fs.unlinkSync(remuxedPath);
  if (sendPath !== remuxedPath && fs.existsSync(sendPath)) fs.unlinkSync(sendPath);
}

// Повторяет ПОЛНЫЙ круг по всем провайдерам ещё раз, если с первого захода не вышло.
// Управляет статус-сообщением: удаляет его при успехе, показывает ошибку при полном отказе.
async function downloadWithRetry(chatId, url, statusMsgId) {
  for (let round = 1; round <= RETRY_ROUNDS; round++) {
    try {
      await fetchAndSend(chatId, url, round, statusMsgId);
      if (statusMsgId) bot.deleteMessage(chatId, statusMsgId).catch(() => {});
      return;
    } catch (err) {
      console.error(`❌ Ошибка загрузки [круг ${round}/${RETRY_ROUNDS}] ${url} — ${err.message || err}`);
      if (round === RETRY_ROUNDS) {
        const failText = '⚠️ Не получилось скачать это видео. Попробуй ещё раз чуть позже.';
        if (statusMsgId) {
          bot.editMessageText(failText, { chat_id: chatId, message_id: statusMsgId }).catch(() => bot.sendMessage(chatId, failText));
        } else {
          bot.sendMessage(chatId, failText);
        }
      }
    }
  }
}

// Обрабатывает очередь несколькими "воркерами" параллельно вместо строго одной ссылки за раз.
async function worker() {
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) return;
    await downloadWithRetry(item.chatId, item.url, item.statusMsgId);
  }
}

async function processQueue() {
  isProcessing = true;
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  isProcessing = false;
}
