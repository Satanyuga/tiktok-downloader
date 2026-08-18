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
// Поэтому опрашиваем НЕЗАВИСИМЫЕ провайдеры ПАРАЛЛЕЛЬНО: v1=прямой API TikTok, v2=ssstik, v3=musicaldown.
// (см. MIRROR_VERSIONS/FALLBACK_VERSION ниже — v1 больше не в общей гонке, см. пояснение там)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// У каждого провайдера свой CDN — некоторые отдают видео только с "правильным" Referer,
// а без него подсовывают HTML-заглушку вместо настоящего mp4 (отсюда "битые" видео-документы).
const REFERERS = {
  v1: 'https://www.tiktok.com/', // v1 бьёт напрямую в TikTok (не tikwm) — CDN этому и должен соответствовать
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
      console.log(`📩 Новая ссылка от ${userId} (@${msg.from.username || 'null'}): ${link}`);
      // Статус-сообщение сразу — юзер видит, что ссылка принята и бот уже работает.
      const statusMsg = await bot.sendMessage(chatId, `⏳ ${link}\nСкачиваю видео...`, { disable_web_page_preview: true });
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
  if (version === 'v1') { // прямой API TikTok — оригинальный мастер-файл (может быть честным 4K)
    videoUrl = result.video?.playAddr?.[0] || result.video?.downloadAddr?.[0];
  } else if (version === 'v2') { // ssstik — сервис-зеркало, обычно уже ужатая для шаринга версия
    videoUrl = result.video?.playAddr || result.direct;
  } else if (version === 'v3') { // musicaldown — аналогично, компактнее мастер-файла
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

// v2/v3 — сервисы-зеркала, отдают уже ужатую для шаринга версию (то самое маленькое "как раньше").
// v1 — прямой API TikTok, отдаёт оригинальный мастер-файл (может быть честным 4K, огромным).
// Поэтому v1 НЕ участвует в общей гонке — он бы почти всегда выигрывал по скорости (не нужен HTML-скрейпинг)
// и заваливал бы нас тяжёлыми файлами. Сначала параллельно пробуем компактные v2/v3, и только если
// ОБА отказали — идём в v1 как последний резерв (лучше тяжёлое видео, чем никакого).
const MIRROR_VERSIONS = ['v2', 'v3'];
const FALLBACK_VERSION = 'v1';

async function fetchMediaAnyProvider(url) {
  try {
    return await Promise.any(MIRROR_VERSIONS.map(v => fetchMedia(url, v)));
  } catch (aggErr) {
    console.log(`ℹ️ [${url}] компактные зеркала (v2/v3) не сработали — пробую ${FALLBACK_VERSION} (оригинал, может быть тяжелее)`);
    try {
      return await fetchMedia(url, FALLBACK_VERSION);
    } catch (fallbackErr) {
      const details = [...(aggErr.errors || [aggErr]), fallbackErr].map(e => e.message).join(' | ');
      throw new Error(`все провайдеры отказали: ${details}`);
    }
  }
}

// Скачивает файл по ссылке и проверяет, что это ДЕЙСТВИТЕЛЬНО видео, а не HTML-заглушка
// (некоторые CDN без правильного Referer отдают страницу "доступ запрещён" вместо mp4 —
// именно из-за этого часть видео раньше приходила "битым документом" без превью).
// Раньше здесь не было защиты от зависания: если CDN "капает" данными очень медленно
// (или подвисает без явной ошибки), axios timeout не гарантированно срабатывает на потоковом
// ответе — видели зависание именно тут. Добавлен детектор простоя + абсолютный потолок,
// оба обрывают скачивание через AbortController.
const DOWNLOAD_STALL_MS = 20 * 1000; // нет новых данных 20с — считаем зависшим
const DOWNLOAD_ABSOLUTE_MS = 3 * 60 * 1000; // на случай вечного микро-капанья

async function downloadAndValidate(mediaUrl, version, destPath) {
  const controller = new AbortController();
  let stallTimer = null;
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
  };
  armStall();
  const absTimer = setTimeout(() => controller.abort(), DOWNLOAD_ABSOLUTE_MS);
  const clearTimers = () => { if (stallTimer) clearTimeout(stallTimer); clearTimeout(absTimer); };

  let vRes;
  try {
    vRes = await axios.get(mediaUrl, {
      responseType: 'stream',
      timeout: 20000,
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Referer': REFERERS[version] || '' }
    });
  } catch (err) {
    clearTimers();
    if (controller.signal.aborted) throw new Error(`${version}: не удалось даже начать скачивание (таймаут)`);
    throw err;
  }

  const contentType = vRes.headers['content-type'] || '';
  if (contentType && !contentType.startsWith('video') && !contentType.includes('octet-stream')) {
    clearTimers();
    throw new Error(`${version}: сервер отдал не видео (content-type: ${contentType})`);
  }

  const writer = fs.createWriteStream(destPath);
  vRes.data.on('data', armStall); // любые новые байты — сдвигаем таймер простоя
  vRes.data.pipe(writer);

  try {
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
      vRes.data.on('error', reject);
      controller.signal.addEventListener('abort', () => reject(new Error(`${version}: скачивание зависло/не уложилось в лимит времени`)));
    });
  } finally {
    clearTimers();
  }

  const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
  if (size < 20000) { // меньше ~20KB — почти наверняка не настоящее видео, а заглушка/ошибка
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    throw new Error(`${version}: подозрительно маленький файл (${size} байт), похоже на заглушку`);
  }
}

// Запускает ffmpeg и всегда резолвит с {code, stderr} — не бросает исключение на ненулевом коде,
// это нужно и для обычных команд, и для "пробы" длительности видео (см. ниже).
// onProgress(seconds, speed) вызывается на КАЖДОЙ строке прогресса, которую печатает сам ffmpeg —
// цифры настоящие, не выдуманная оценка.
// opts.stallMs — убиваем процесс, если прогресс НЕ СДВИГАЕТСЯ дольше stallMs (реальное зависание).
// opts.absoluteMs — абсолютный потолок на случай, если прогресс идёт вечно микро-шагами.
// Важно: медленное, но ИДУЩЕЕ сжатие (например, декодирование тяжёлого 4K-исходника) — это НЕ зависание,
// раньше фиксированный таймаут убивал такие видео на середине просто потому что они долгие, а не зависшие.
function runFfmpeg(args, onProgress, opts = {}) {
  const { stallMs, absoluteMs } = opts;
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    let buf = '';
    let timeoutReason = null;

    let stallTimer = null;
    const armStallTimer = () => {
      if (!stallMs) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { timeoutReason = 'stall'; proc.kill('SIGKILL'); }, stallMs);
    };
    armStallTimer(); // отсчёт идёт и до первого прогресс-тика — если ffmpeg вообще не стартовал

    const absTimer = absoluteMs ? setTimeout(() => { timeoutReason = 'absolute'; proc.kill('SIGKILL'); }, absoluteMs) : null;

    proc.stderr.on('data', d => {
      const s = d.toString();
      stderr += s;
      if (!onProgress) return;
      buf += s;
      const lines = buf.split(/\r|\n/);
      buf = lines.pop(); // последняя (возможно неполная) строка остаётся в буфере
      for (const line of lines) {
        const m = line.match(/time=(\d+):(\d+):(\d+\.\d+).*speed=\s*([\d.]+)x/);
        if (m) {
          armStallTimer(); // есть реальный прогресс — сдвигаем таймер зависания
          onProgress((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]), parseFloat(m[4]));
        }
      }
    });
    proc.on('error', err => {
      if (stallTimer) clearTimeout(stallTimer);
      if (absTimer) clearTimeout(absTimer);
      reject(err);
    });
    proc.on('close', code => {
      if (stallTimer) clearTimeout(stallTimer);
      if (absTimer) clearTimeout(absTimer);
      resolve({ code: timeoutReason ? `timeout:${timeoutReason}` : code, stderr });
    });
  });
}

// Узнаём длительность и разрешение видео без полного декодирования — ffmpeg печатает
// "Duration: HH:MM:SS.xx" и "Video: ... WxH" в stderr ещё до того, как ругнётся на отсутствие выходного файла.
async function probeVideoInfo(input) {
  const { stderr } = await runFfmpeg(['-i', input]);
  const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const r = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  return {
    duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : null,
    width: r ? +r[1] : null,
    height: r ? +r[2] : null
  };
}

// Перекладывает контейнер (moov atom в начало) БЕЗ перекодирования — мгновенно и без потери качества.
// Чинит конкретный баг: некоторые провайдеры отдают mp4, в котором Telegram не видит длительность/превью
// и показывает видео как "файл, надо скачать" вместо проигрываемого ролика.
async function remux(input, output) {
  const { code, stderr } = await runFfmpeg(['-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', output]);
  if (code !== 0) throw new Error(`remux exit ${code}: ${stderr.slice(-300)}`);
}

function formatEta(sec) {
  if (!isFinite(sec) || sec < 0) return '?';
  if (sec < 60) return `~${Math.ceil(sec)} сек`;
  return `~${Math.floor(sec / 60)} мин ${Math.round(sec % 60)} сек`;
}

// Детектор зависания вместо жёсткого потолка: убиваем ffmpeg только если прогресс НЕ ИДЁТ
// дольше STALL_MS (реальное зависание/фриз). Медленный, но ИДУЩИЙ прогресс (например, декодирование
// тяжёлого 4K-исходника — видели 2160x3840 в логах) — это не зависание, ему просто нужно больше времени.
// ABSOLUTE_MS — крайний потолок на случай микро-прогресса без реального завершения (перестраховка).
const COMPRESS_STALL_MS = 90 * 1000;
const COMPRESS_ABSOLUTE_MS = 20 * 60 * 1000;

// Сжимает ПОД ТОЧНЫЙ РАЗМЕР — считаем битрейт из длительности видео и целевого размера,
// вместо того чтобы вслепую понижать разрешение. Разрешение почти всегда остаётся оригинальным
// (кап только на аномально широких/высоких видео — иначе x264 на маленьком сервере может съесть всю память).
// duration — уже известная длительность (не пробуем повторно), progressCtx — {chatId, statusMsgId, url, label}
// для живого статуса и логов.
async function compressToFit(input, output, targetBytes, duration, progressCtx) {
  const audioKbps = 128;
  const safetyMargin = 0.90; // чуть больше запас, чем раньше — на медленном CPU второй проход (пересжатие) стоит очень дорого по времени, лучше не промахиваться
  let videoKbps = Math.floor((targetBytes * 8 / 1024 / duration) * safetyMargin - audioKbps);
  if (videoKbps < 300) videoKbps = 300; // ниже уже совсем плохо будет выглядеть, но это край случая для очень длинных роликов

  console.log(`⚙️ [${progressCtx.url}] старт сжатия (${progressCtx.label}): длительность ${duration.toFixed(0)}с, ${progressCtx.width || '?'}x${progressCtx.height || '?'}, целевой битрейт ${videoKbps}kbps`);

  let lastEditAt = 0;
  const onProgress = (t, speed) => {
    const now = Date.now();
    if (now - lastEditAt < 6000) return; // не чаще раза в 6 сек — не спамим Telegram и логи
    lastEditAt = now;
    const pct = Math.min(99, Math.round((t / duration) * 100));
    const etaSec = speed > 0 ? (duration - t) / speed : null;
    console.log(`📊 [${progressCtx.url}] сжатие (${progressCtx.label}): ${pct}% (${t.toFixed(0)}/${duration.toFixed(0)}с, скорость ${speed}x, осталось ${etaSec != null ? formatEta(etaSec) : '?'})`);
    if (progressCtx.statusMsgId) {
      const etaText = etaSec != null ? formatEta(etaSec) : 'считаю...';
      bot.editMessageText(
        `📦 ${progressCtx.url}\nВидео не влезает по размеру — сжимаю без потери качества...\n⏱ ${pct}%, осталось ${etaText}`,
        { chat_id: progressCtx.chatId, message_id: progressCtx.statusMsgId, disable_web_page_preview: true }
      ).catch(() => {});
    }
  };

  const t0 = Date.now();
  // Сервер оказался в разы медленнее обычного (0.12x реального времени в логах — почти в 8 раз
  // медленнее нормального ядра). Урезаю разрешение и ставлю самый быстрый preset — но это не помогает
  // против тяжёлого ДЕКОДИРОВАНИЯ 4K-исходника (оно не зависит от целевого разрешения на выходе).
  const { code, stderr } = await runFfmpeg([
    '-y', '-i', input,
    '-vf', "scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2',
    '-b:v', `${videoKbps}k`, '-maxrate', `${Math.floor(videoKbps * 1.2)}k`, '-bufsize', `${videoKbps * 2}k`,
    '-c:a', 'aac', '-b:a', `${audioKbps}k`,
    '-movflags', '+faststart',
    output
  ], onProgress, { stallMs: COMPRESS_STALL_MS, absoluteMs: COMPRESS_ABSOLUTE_MS });

  if (code === 'timeout:stall') throw new Error(`compress: завис (нет прогресса ${COMPRESS_STALL_MS / 1000}с), процесс убит принудительно`);
  if (code === 'timeout:absolute') throw new Error(`compress: превышен абсолютный потолок ${COMPRESS_ABSOLUTE_MS / 60000} мин, процесс убит принудительно`);
  if (code !== 0) throw new Error(`compress exit ${code}: ${stderr.slice(-300)}`);
  console.log(`✅ [${progressCtx.url}] сжатие (${progressCtx.label}) готово за ${((Date.now() - t0) / 1000).toFixed(1)}с: ${(fs.statSync(output).size / 1024 / 1024).toFixed(1)}MB`);
}

// Сжатие (в отличие от remux) реально прожорливо по памяти. Если 2-3 сжатия пойдут ОДНОВРЕМЕННО
// (при concurrency-очереди это возможно), инстанс на Render может уйти в OOM и упасть целиком.
// Поэтому сжатия выполняются строго ПО ОДНОМУ, независимо от того, сколько видео качается параллельно.
let compressionChain = Promise.resolve();
let compressionBusy = false;
function runCompressionExclusive(fn, onQueued) {
  if (compressionBusy && onQueued) onQueued();
  compressionBusy = true;
  const result = compressionChain.then(fn, fn).finally(() => { compressionBusy = false; });
  compressionChain = result.then(() => {}, () => {}); // цепочка живёт дальше даже после ошибки
  return result;
}

// Сжимает ТОЛЬКО если файл реально больше лимита Telegram. Маленькие видео эта функция не трогает вообще.
async function ensureUnderTelegramLimit(inputPath, chatId, statusMsgId, url) {
  const size = fs.statSync(inputPath).size;
  if (size <= MAX_TELEGRAM_BYTES) return inputPath;

  console.log(`⚙️ [${url}] видео ${(size / 1024 / 1024).toFixed(1)}MB больше лимита ${(MAX_TELEGRAM_BYTES / 1024 / 1024).toFixed(0)}MB — начинаю сжатие`);
  const info = await probeVideoInfo(inputPath);
  const duration = info.duration || 180;
  console.log(`ℹ️ [${url}] исходник: ${info.width || '?'}x${info.height || '?'}, ${duration.toFixed(0)}с`);

  if (statusMsgId) {
    bot.editMessageText(
      `📦 ${url}\nВидео (${(size / 1024 / 1024).toFixed(1)}MB) не влезает по размеру, сжимаю без потери качества...`,
      { chat_id: chatId, message_id: statusMsgId, disable_web_page_preview: true }
    ).catch(() => {});
  }

  const onQueued = () => {
    console.log(`⏳ [${url}] ждёт очереди — уже идёт сжатие другого видео`);
    if (statusMsgId) {
      bot.editMessageText(`⏳ ${url}\nВ очереди на сжатие (сейчас сжимается другое видео)...`, { chat_id: chatId, message_id: statusMsgId, disable_web_page_preview: true }).catch(() => {});
    }
  };

  const outPath = inputPath.replace(/\.mp4$/, '') + '_fit.mp4';
  await runCompressionExclusive(() => compressToFit(inputPath, outPath, MAX_TELEGRAM_BYTES, duration, { chatId, statusMsgId, url, label: 'заход 1', width: info.width, height: info.height }), onQueued);

  if (fs.statSync(outPath).size > MAX_TELEGRAM_BYTES) {
    // Расчёт битрейта — оценка (VBR пики, реальный muxing overhead), иногда чуть промахивается.
    // Один дожим с меньшим запасом — и всё, дальше не гоняем по кругу до бесконечности.
    console.log(`⚠️ [${url}] после сжатия всё ещё больше лимита — дожимаю плотнее`);
    const outPath2 = inputPath.replace(/\.mp4$/, '') + '_fit2.mp4';
    await runCompressionExclusive(() => compressToFit(outPath, outPath2, Math.floor(MAX_TELEGRAM_BYTES * 0.88), duration, { chatId, statusMsgId, url, label: 'заход 2', width: info.width, height: info.height }), onQueued);
    fs.unlinkSync(outPath);
    if (statusMsgId) bot.editMessageText(`✅ ${url}\nСжато, отправляю...`, { chat_id: chatId, message_id: statusMsgId, disable_web_page_preview: true }).catch(() => {});
    return outPath2;
  }

  if (statusMsgId) bot.editMessageText(`✅ ${url}\nСжато, отправляю...`, { chat_id: chatId, message_id: statusMsgId, disable_web_page_preview: true }).catch(() => {});
  return outPath;
}

// Один полный круг: спросить у провайдеров (параллельно) и отправить результат в Telegram.
async function fetchAndSend(chatId, url, roundAttempt, statusMsgId) {
  const { version, media } = await fetchMediaAnyProvider(url);
  console.log(`ℹ️ [${url}] источник: ${version}${version === 'v1' ? ' (оригинал TikTok, может быть тяжёлым)' : ' (компактное зеркало)'}`);

  if (media.images) {
    for (const imgUrl of media.images) await bot.sendPhoto(chatId, imgUrl);
    return;
  }

  const videoPath = path.resolve(__dirname, `v_${Date.now()}_${roundAttempt}.mp4`);
  await downloadAndValidate(media.video, version, videoPath);
  console.log(`ℹ️ [${url}] скачано (${version}): ${(fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)}MB`);

  // Всегда чиним контейнер (faststart) — без этого часть видео Telegram показывает
  // как "файл, нужно скачать" вместо проигрываемого ролика. Это ремукс, не перекодирование:
  // быстро и без малейшей потери качества.
  const remuxedPath = videoPath.replace(/\.mp4$/, '') + '_r.mp4';
  await remux(videoPath, remuxedPath);
  fs.unlinkSync(videoPath);

  const sendPath = await ensureUnderTelegramLimit(remuxedPath, chatId, statusMsgId, url);

  // Узнаём метаданные ИМЕННО того файла, который реально отправляем (после возможного сжатия
  // разрешение другое) — без явных duration/width/height Telegram нередко показывает видео
  // как "файл, нужно скачать" вместо проигрываемого ролика, даже если сам контейнер в порядке.
  const sendInfo = await probeVideoInfo(sendPath);
  // Имя файла как раньше (v_<timestamp>.mp4) — статичное "video.mp4" было заменой без причины.
  const displayName = `v_${Date.now()}.mp4`;
  await bot.sendVideo(chatId, sendPath, {
    supports_streaming: true,
    duration: sendInfo.duration ? Math.round(sendInfo.duration) : undefined,
    width: sendInfo.width || undefined,
    height: sendInfo.height || undefined
  }, { filename: displayName, contentType: 'video/mp4' });

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
        const failText = `⚠️ ${url}\nНе получилось скачать это видео. Попробуй ещё раз чуть позже.`;
        if (statusMsgId) {
          bot.editMessageText(failText, { chat_id: chatId, message_id: statusMsgId, disable_web_page_preview: true }).catch(() => bot.sendMessage(chatId, failText, { disable_web_page_preview: true }));
        } else {
          bot.sendMessage(chatId, failText, { disable_web_page_preview: true });
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
