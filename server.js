/**
 * tiktok-downloader-service
 * Free TikTok video downloader microservice (no watermark).
 *
 * Engine: TikWM free API (primary, direct CDN links jo browser me download hote hain)
 *         + yt-dlp file mode (fallback, khud download kar ke file deta hai)
 * Audio:  yt-dlp + ffmpeg-static (MP3 extract, bilkul reels-audio-service jesa)
 *
 * Endpoints:
 *   GET  /                         -> standalone tool page (public/index.html)
 *   GET  /health                   -> { ok: true }
 *   GET  /api/download?url=<tiktok url>
 *   POST /api/download             -> body JSON { url } ya { link }
 *     -> { success: true, title, author, thumbnail, duration,
 *          videoUrl, qualities: [{label, url, height}], watermarkUrl,
 *          musicUrl, source: "tikwm" | "yt-dlp-file" }
 *   GET  /api/audio?url=<tiktok url>
 *   POST /api/audio                -> body JSON { url } ya { link }
 *     -> { success: true, audioUrl, downloadUrl }  (MP3, 30 min valid)
 */

const express = require('express');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.set('trust proxy', 1); // Render proxy ke peeche https pehchanne ke liye
const PORT = process.env.PORT || 3000;
const YTDLP = path.join(__dirname, 'bin', 'yt-dlp');
const FILES_DIR = path.join(__dirname, 'files');
const FILE_TTL_MS = 30 * 60 * 1000; // MP3 links expire after 30 minutes

fs.mkdirSync(FILES_DIR, { recursive: true });

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(FILES_DIR));

// ---- simple CORS (taake tool kisi bhi site se call ho sake) ----
app.use('/api/', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- simple in-memory rate limit: max 30 requests per minute per IP ----
const hits = {};
setInterval(() => { for (const k in hits) delete hits[k]; }, 60 * 1000);
app.use('/api/', (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  hits[ip] = (hits[ip] || 0) + 1;
  if (hits[ip] > 30) return res.status(429).json({ success: false, message: 'Too many requests. Slow down.' });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, ytdlp: fs.existsSync(YTDLP) }));

// ---- TikTok URL check: tiktok.com + short links (vm/vt.tiktok.com) ----
function isTikTokUrl(u) {
  return /^https?:\/\/([a-z0-9-]+\.)*tiktok\.com\//i.test(String(u || ''));
}
function getInputUrl(req) {
  return String((req.query && req.query.url) || (req.body && (req.body.url || req.body.link)) || '').trim();
}

// ---- keep yt-dlp fresh: startup pe update check (non-blocking) ----
function updateYtDlp() {
  if (!fs.existsSync(YTDLP)) {
    console.log('[yt-dlp] binary not found. Run: node scripts/fetch-ytdlp.js');
    return;
  }
  execFile(YTDLP, ['-U'], { timeout: 90000 }, (err, stdout) => {
    const line = (stdout || '').trim().split('\n').pop();
    console.log('[yt-dlp] update check:', err ? String(err.message).slice(0, 120) : line);
  });
}

/* ================================================================
   Primary: TikWM free API (koi key nahi, koi account nahi)
   play / hdplay = no watermark, wmplay = watermark, music, cover
   Photo slideshow post par "images" array ata hai (har photo ka
   alag direct link) — ye photos hasil karne ka wahid tareeqa hai,
   yt-dlp /photo/ URLs ko support hi nahi karta (verify shuda).
   Headers bilkul browser jese rakhe hain, warna kuch servers
   (Cloudflare) aam API request ko rok dete hain. 2 hosts bari
   bari try hote hain.
   ================================================================ */
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.tiktok.com/',
};

function tikwmRequest(host, url) {
  return new Promise((resolve, reject) => {
    const api = `https://${host}/api/?hd=1&url=` + encodeURIComponent(url);
    https.get(api, { headers: BROWSER_HEADERS, timeout: 30000 }, (resp) => {
      let body = '';
      resp.on('data', (d) => { body += d; });
      resp.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (!j || j.code !== 0 || !j.data) return reject(new Error('tikwm failed on ' + host));
          resolve(j.data);
        } catch (e) { reject(new Error('tikwm bad output on ' + host)); }
      });
    }).on('error', () => reject(new Error('tikwm unreachable: ' + host)));
  });
}

async function fetchWithTikWm(url) {
  let d = null;
  let lastErr = null;
  for (const host of ['www.tikwm.com', 'tikwm.com']) {
    try { d = await tikwmRequest(host, url); break; } catch (e) { lastErr = e; }
  }
  if (!d) throw lastErr || new Error('tikwm failed');

  const base = {
    success: true,
    source: 'tikwm',
    title: d.title || '',
    author: (d.author && (d.author.unique_id || d.author.nickname)) || '',
    thumbnail: d.cover || d.origin_cover || '',
    musicUrl: d.music || null,
  };

  // ---- Photo slideshow post ----
  if (Array.isArray(d.images) && d.images.length) {
    return {
      ...base,
      type: 'photo',
      duration: null,
      images: d.images,
      videoUrl: null,
      qualities: [],
      watermarkUrl: null,
    };
  }

  // ---- Aam video post ----
  const qualities = [];
  if (d.hdplay) qualities.push({ label: 'Download Video HD (No Watermark)', url: d.hdplay, height: null });
  if (d.play && d.play !== d.hdplay) qualities.push({ label: 'Download Video (No Watermark)', url: d.play, height: null });
  if (!qualities.length) throw new Error('tikwm: no video');
  return {
    ...base,
    type: 'video',
    duration: d.duration || null,
    videoUrl: qualities[0].url,
    qualities,
    watermarkUrl: d.wmplay || null,
  };
}

/* ================================================================
   Fallback: yt-dlp khud file download kar ke apne server se deta hai.
   Ye is liye zaroori hai ke yt-dlp ke diye hue direct (webapp) links
   cookies ke baghair "Access Denied" dete hain (2026-10-23 ko verify
   kiya) - wo links browser me kaam nahi karte. Isi liye pehle TikWM
   ke direct CDN links try hote hain, aur agar wo fail ho jaye to
   file wala tareeqa use hota hai. File 30 min baad auto-delete.
   ================================================================ */
function fetchByDownloadingFile(url, req) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(YTDLP)) return reject(new Error('yt-dlp missing'));
    const id = crypto.randomBytes(8).toString('hex');
    const filePath = path.join(FILES_DIR, `${id}.mp4`);
    const args = [
      '-f', 'bv*[format_id!=download]+ba/b[format_id!=download]',
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', ffmpegPath,
      '--no-playlist',
      '--print-json',
      '-o', filePath,
      url,
    ];
    execFile(YTDLP, args, { timeout: 240000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err || !fs.existsSync(filePath)) {
        fs.unlink(filePath, () => {});
        return reject(new Error('yt-dlp file download failed'));
      }
      let info = {};
      try { info = JSON.parse(String(stdout).trim().split('\n').pop()); } catch (e) { /* title na mile to khali chalega */ }
      setTimeout(() => fs.unlink(filePath, () => {}), FILE_TTL_MS);
      const fileUrl = `${req.protocol}://${req.get('host')}/files/${id}.mp4`;
      resolve({
        success: true,
        source: 'yt-dlp-file',
        type: 'video',
        title: info.title || '',
        author: info.uploader || info.channel || '',
        thumbnail: info.thumbnail || '',
        duration: info.duration || null,
        videoUrl: fileUrl,
        qualities: [{ label: 'Download Video (No Watermark)', url: fileUrl, height: null }],
        watermarkUrl: null,
        musicUrl: null,
      });
    });
  });
}

async function handleDownload(req, res) {
  const url = getInputUrl(req);
  if (!isTikTokUrl(url)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid TikTok URL.' });
  }
  // 1) Pehle TikWM: is ke direct CDN links browser me seedha download hote hain (verify shuda)
  try {
    const data = await fetchWithTikWm(url);
    return res.json(data);
  } catch (e1) {
    console.error('[download] tikwm failed, trying yt-dlp file mode:', e1.message);
  }
  // 2) Fallback: yt-dlp khud download kar ke file dega (sirf video posts ke liye;
  //    photo posts ko yt-dlp support nahi karta, un ka wahid rasta TikWM hai)
  try {
    const data = await fetchByDownloadingFile(url, req);
    return res.json(data);
  } catch (e2) {
    console.error('[download] yt-dlp file mode failed:', e2.message);
    if (/\/photo\//i.test(url)) {
      return res.status(500).json({ success: false, message: 'Could not fetch this photo post right now. Please try again in a little while.' });
    }
    return res.status(500).json({ success: false, message: 'Could not fetch this video. The link may be private or removed, please try another one.' });
  }
}
app.get('/api/download', handleDownload);
app.post('/api/download', handleDownload);

/* ================================================================
   MP3 audio — bilkul reels-audio-service wala tareeqa
   ================================================================ */
function handleAudio(req, res) {
  const url = getInputUrl(req);
  if (!isTikTokUrl(url)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid TikTok URL.' });
  }
  if (!fs.existsSync(YTDLP)) {
    return res.status(500).json({ success: false, message: 'Audio engine not installed yet. Try again in a minute.' });
  }
  // Photo post ki music ke liye: yt-dlp /photo/ URL nahi parhta,
  // lekin usi post ka /video/ wala pata us ki audio de deta hai (verify shuda)
  const ytdlpUrl = url.replace('/photo/', '/video/');
  const id = crypto.randomBytes(8).toString('hex');
  const outTemplate = path.join(FILES_DIR, `${id}.%(ext)s`);
  const args = [
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--ffmpeg-location', ffmpegPath,
    '--no-playlist',
    '-o', outTemplate,
    ytdlpUrl,
  ];
  const child = spawn(YTDLP, args, { timeout: 180000 });
  let errOut = '';
  child.stderr.on('data', (d) => { errOut += d.toString(); });
  child.on('error', (e) => {
    console.error('[audio] spawn error:', e.message);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Audio service unavailable. Try again.' });
  });
  child.on('close', (code) => {
    if (res.headersSent) return;
    const files = fs.readdirSync(FILES_DIR).filter((f) => f.startsWith(id) && f.endsWith('.mp3'));
    if (code === 0 && files.length > 0) {
      const file = files[0];
      const fileUrl = `${req.protocol}://${req.get('host')}/files/${file}`;
      setTimeout(() => fs.unlink(path.join(FILES_DIR, file), () => {}), FILE_TTL_MS);
      return res.json({ success: true, audioUrl: fileUrl, downloadUrl: fileUrl });
    }
    console.error('[audio] yt-dlp failed, code', code, errOut.slice(-400));
    fs.readdirSync(FILES_DIR).filter((f) => f.startsWith(id)).forEach((f) => fs.unlink(path.join(FILES_DIR, f), () => {}));
    return res.status(500).json({ success: false, message: 'Could not extract audio from this link.' });
  });
}
app.get('/api/audio', handleAudio);
app.post('/api/audio', handleAudio);

// ---- background cleanup: 30 min se purani MP3 files delete (har 10 min) ----
setInterval(() => {
  const now = Date.now();
  fs.readdirSync(FILES_DIR).forEach((f) => {
    if (f === '.gitkeep') return;
    const p = path.join(FILES_DIR, f);
    fs.stat(p, (e, st) => { if (!e && now - st.mtimeMs > FILE_TTL_MS) fs.unlink(p, () => {}); });
  });
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`tiktok-downloader-service listening on port ${PORT}`);
  updateYtDlp();
});
