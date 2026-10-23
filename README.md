# tiktok-downloader-service

Free TikTok video downloader microservice — **without watermark**, plus MP3 audio.
Scratch se banaya gaya, bilkul Snack Video / Reels audio service wali tarz par.

- **Video (primary):** TikWM free API — koi key nahi, koi account nahi. Is ke direct CDN links browser me seedha download hote hain.
- **Video (fallback):** yt-dlp khud file download kar ke isi server se deta hai (file 30 min baad auto-delete).
- **Audio MP3:** yt-dlp + ffmpeg (bilkul reels-audio-service wala tareeqa).
- **Cost:** $0 — **Hosting:** Render free tier.

> Kyun TikWM primary hai? 2026-10-23 ko test me verify hua ke yt-dlp ke diye hue
> TikTok "webapp" video links cookies ke baghair **Access Denied** dete hain —
> wo browser me download nahi hote. TikWM ke `tiktokcdn` links seedha download
> hote hain (test video: 3.3 MB asli MP4, 24 sec). Aur yt-dlp ka `download`
> naam wala format watermarked hota hai, wo code me hamesha exclude hai.

## Endpoints

| Endpoint | Kaam |
|---|---|
| `GET /` | Standalone tool page — Render URL kholo aur tool wahi chalta hai |
| `GET /health` | `{ ok: true }` — UptimeRobot ke liye bhi yahi use karna |
| `GET/POST /api/download?url=<tiktok url>` | Video info + no-watermark download links (HD + normal), thumbnail, music |
| `GET/POST /api/audio?url=<tiktok url>` | MP3 ban kar link deta hai (30 min valid) |

## Deploy on Render (free)

1. Is folder ko ek naye GitHub repo me upload karo (sab files; `node_modules` aur `bin` upload nahi honge, `.gitignore` pehle se bana hai)
2. Render dashboard → **New +** → **Web Service** → repo connect karo
3. Render `render.yaml` khud parh lega — bas **Create Web Service** dabao
4. Build 2–4 min lagegi (`npm install && npm run fetch-ytdlp` khud chalega)
5. Test: `https://tiktok-downloader.onrender.com/` kholo — tool page ana chahiye
6. Phir ek asli TikTok link paste kar ke download check karo
7. **UptimeRobot:** monitor banao, URL `https://tiktok-downloader.onrender.com/health`, interval 5 minutes — warna free service so jayegi aur pehli request 1–3 min legi

## WordPress se connect

Saath wala plugin use karo: `tiktok-video-downloader-plugin.zip`
(shortcode: `[tiktok_downloader]`)

Agar tumhare Render service ka naam `tiktok-downloader` se mukhtalif ho to
plugin ki file `tiktok-video-downloader.php` ke top par ye 2 lines badal dena:

```php
define('TTD_API_URL', 'https://TUMHARA-NAAM.onrender.com/api/download');
define('TTD_API_AUDIO_URL', 'https://TUMHARA-NAAM.onrender.com/api/audio');
```

## Notes

- Rate limit built-in: 30 requests/minute per IP
- yt-dlp har server start par khud update check karta hai (`-U`)
- MP3 aur fallback video files 30 min baad khud delete ho jati hain
- Private / deleted videos pe saaf error ata hai: "Could not fetch this video..."
