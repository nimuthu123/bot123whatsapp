// commands/yt.js (ULTRA LOW RAM + FAST + DOCUMENT-ONLY)
// Requires: npm i yt-search axios
// Notes:
// - Always sends as DOCUMENT (video/audio)
// - Menu has only 1 (MP4) and 2 (MP3)
// - No HEAD filesize check (faster + less RAM/IO)
// - Tiny metadata cache

const yts = require("yt-search");
const axios = require("axios");

// ====== Constants (primitives only) ======
const CACHE_TTL = 30_000; // 30s
const CACHE_MAX = 10;

// Axios defaults (single shared object)
const AXIOS_DEFAULTS = {
  timeout: 60_000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "application/json, text/plain, */*",
  },
};

// ====== Tiny meta cache ======
const metaCache = new Map();

const CACHE_CLEANUP_INTERVAL = 30_000;
let cleanupTimer = null;

function startCacheCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of metaCache) {
      if (!v || now - v.ts > CACHE_TTL) metaCache.delete(k);
    }
    while (metaCache.size > CACHE_MAX) {
      const firstKey = metaCache.keys().next().value;
      if (firstKey) metaCache.delete(firstKey);
    }
  }, CACHE_CLEANUP_INTERVAL);
  cleanupTimer.unref?.();
}
startCacheCleanup();

// ====== Retry helper (low overhead) ======
async function tryRequest(getter, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await getter();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        if (attempt === 1) {
          await Promise.resolve();
        } else {
          await new Promise((r) => {
            const t = setTimeout(r, 700 * attempt);
            t.unref?.();
          });
        }
      }
    }
  }
  throw lastError;
}

// ====== Download APIs (multi fallback) ======
async function getEliteProTechByUrl(youtubeUrl, format = "mp4") {
  const apiUrl =
    "https://eliteprotech-apis.zone.id/ytdown?url=" +
    encodeURIComponent(youtubeUrl) +
    "&format=" +
    format;

  const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
  if (res?.data?.success && res?.data?.downloadURL) {
    return { download: res.data.downloadURL, title: res.data.title || "YouTube" };
  }
  throw new Error("EliteProTech failed");
}

async function getYupraByUrl(youtubeUrl, format = "mp4") {
  const apiUrl =
    "https://api.yupra.my.id/api/downloader/yt" +
    format +
    "?url=" +
    encodeURIComponent(youtubeUrl);

  const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
  if (res?.data?.success && res?.data?.data?.download_url) {
    return { download: res.data.data.download_url, title: res.data.data.title || "YouTube" };
  }
  throw new Error("Yupra failed");
}

async function getOkatsuByUrl(youtubeUrl, format = "mp4") {
  const apiUrl =
    "https://okatsu-rolezapiiz.vercel.app/downloader/yt" +
    format +
    "?url=" +
    encodeURIComponent(youtubeUrl);

  const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
  if (res?.data?.result) {
    const r = res.data.result;
    return { download: r.mp4 || r.mp3, title: r.title || "YouTube" };
  }
  throw new Error("Okatsu failed");
}

const API_METHODS = [
  { name: "EliteProTech", method: getEliteProTechByUrl },
  { name: "Yupra", method: getYupraByUrl },
  { name: "Okatsu", method: getOkatsuByUrl },
];

async function getDownloadWithFallback(youtubeUrl, format) {
  let lastError;
  for (const api of API_METHODS) {
    try {
      const data = await api.method(youtubeUrl, format);
      if (data?.download) return data;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("All APIs failed");
}

// ====== URL helpers ======
const YT_URL_REGEX =
  /youtu(?:\.be\/|be\.com\/(?:watch\?v=|shorts\/))([a-zA-Z0-9_-]{11})/;
const YT_ID_REGEX = /(?:youtu\.be\/|v=|shorts\/)([a-zA-Z0-9_-]{11})/;

function isYouTubeUrl(u) {
  return u ? YT_URL_REGEX.test(u) : false;
}

function extractVideoId(url) {
  if (!url) return null;
  const m = url.match(YT_ID_REGEX);
  return m ? m[1] : null;
}

function safeFileName(name) {
  return (name || "YouTube")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 60);
}

// ====== Metadata (cached) ======
async function getYtMeta(ytUrl) {
  const id = extractVideoId(ytUrl);
  if (!id) return null;

  const cached = metaCache.get(id);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const r = await yts({ videoId: id });
    const meta = {
      id,
      title: (r?.title || "YouTube Video").substring(0, 100),
      thumbnail: r?.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
    metaCache.set(id, { data: meta, ts: Date.now() });
    return meta;
  } catch {
    const meta = {
      id,
      title: "YouTube Video",
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
    metaCache.set(id, { data: meta, ts: Date.now() });
    return meta;
  }
}

// ====== Module ======
module.exports = {
  name: "yt",
  isYouTubeUrl,

  async buildMenuPayload(ytUrl) {
    const meta = await getYtMeta(ytUrl);
    const caption =
      `🎬 *${meta?.title || "YouTube Video"}*\n\n` +
      `Choose:\n` +
      `1️⃣ Video (MP4)\n` +
      `2️⃣ Audio (MP3)\n\n` +
      `Reply within 60 seconds.`;

    return { meta, caption, thumbUrl: meta?.thumbnail || null };
  },

  // Always send as DOCUMENT (fast + low RAM)
  async sendByMode({ sock, jid, ytUrl, mode, reply, quoted }) {
    try {
      if (!isYouTubeUrl(ytUrl)) {
        await sock.sendMessage(jid, { text: "❌ Invalid YouTube link" }, { quoted });
        return;
      }

      if (mode !== "1" && mode !== "2") {
        await sock.sendMessage(jid, { text: "❌ Reply 1 or 2" }, { quoted });
        return;
      }

      const meta = await getYtMeta(ytUrl);
      const title = meta?.title || "YouTube";

      // Thumbnail message (non-blocking)
      if (meta?.thumbnail) {
        sock
          .sendMessage(
            jid,
            { image: { url: meta.thumbnail }, caption: `*${title}*\nDownloading...` },
            { quoted }
          )
          .catch(() => {});
      }

      const format = mode === "2" ? "mp3" : "mp4";

      const data = await getDownloadWithFallback(ytUrl, format);
      const downloadUrl = data.download;
      const videoTitle = data.title || title;

      const fileName = `${safeFileName(videoTitle)}.${format}`;
      const caption =
        `*${videoTitle}*\n\n` +
        `> *_Downloaded by NIMUTHU Bot MD_*`;

      const message = {
        document: { url: downloadUrl },
        mimetype: format === "mp3" ? "audio/mpeg" : "video/mp4",
        fileName,
        caption,
      };

      await sock.sendMessage(jid, message, { quoted });
    } catch (error) {
      console.error("[YT] Error:", error?.message);

      const errorMsg =
        error?.message?.includes("blocked") || error?.response?.status === 451
          ? "❌ Content unavailable (region blocked)"
          : error?.message?.includes("All APIs failed")
          ? "❌ All download sources failed"
          : `❌ ${error?.message || "Failed to download"}`;

      await sock.sendMessage(jid, { text: errorMsg }, { quoted }).catch(() => {});
    }
  },
};

// Cleanup
process.on("exit", () => {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  metaCache.clear();
});
