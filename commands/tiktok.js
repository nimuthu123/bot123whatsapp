// commands/tiktok.js
// TikTok downloader using tikwm.com API
// RATE LIMITED + LOW RAM + BAILEYS SAFE

const https = require("https");
const { URL } = require("url");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ================= RATE LIMIT CONFIG =================
const API_INTERVAL_MS = 1100;   // tikwm: 1 request / second
const USER_COOLDOWN_MS = 15_000; // 15s per user

let lastApiCall = 0;
const userCooldown = new Map(); // jid -> timestamp
const USER_COOLDOWN_MAX = 1000;

// =====================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- global API throttle (tikwm limit) ---
async function throttleApi() {
  const now = Date.now();
  const diff = now - lastApiCall;
  if (diff < API_INTERVAL_MS) {
    await sleep(API_INTERVAL_MS - diff);
  }
  lastApiCall = Date.now();
}

// --- per-user cooldown ---
function checkUserCooldown(jid) {
  const now = Date.now();
  const last = userCooldown.get(jid) || 0;

  if (now - last < USER_COOLDOWN_MS) {
    return Math.ceil((USER_COOLDOWN_MS - (now - last)) / 1000);
  }

  userCooldown.set(jid, now);

  // prevent map from growing forever
  if (userCooldown.size > USER_COOLDOWN_MAX) {
    for (const k of userCooldown.keys()) {
      userCooldown.delete(k);
      break;
    }
  }

  return 0;
}

function isTikTokUrl(input) {
  try {
    const u = new URL(String(input || "").trim());
    const h = u.hostname.toLowerCase();
    return h.includes("tiktok.com") || h.includes("vt.tiktok.com") || h.includes("vm.tiktok.com");
  } catch {
    return false;
  }
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    const req = https.request(
      {
        method: "GET",
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          "user-agent": UA,
          accept: "application/json",
        },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Invalid JSON response"));
          }
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
    req.end();
  });
}

function formatNumber(num) {
  const n = Number(num || 0);
  if (!n) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function formatDuration(seconds) {
  const s = Number(seconds || 0);
  if (!s) return "0:00";
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

// ===================== HANDLER =====================

async function handle({ sock, jid, url, reply }) {
  try {
    url = String(url || "").trim();

    if (!isTikTokUrl(url)) {
      await reply("❌ Please send a valid TikTok link\nUse: `.tt <tiktok link>`");
      return;
    }

    // ---- per-user rate limit ----
    const wait = checkUserCooldown(jid);
    if (wait > 0) {
      await reply(`⏳ Please wait ${wait}s before using .tt again`);
      return;
    }

    await reply("⏳ Fetching TikTok info...");

    // ---- API throttle (global) ----
    await throttleApi();

    const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
    const apiRes = await httpsGetJson(apiUrl);

    if (!apiRes || apiRes.code !== 0) {
      throw new Error(apiRes?.msg || "API error");
    }

    const data = apiRes.data;
    if (!data) throw new Error("No data in API response");

    const videoUrl = data.play || data.hdplay || data.wmplay;
    if (!videoUrl) throw new Error("No video URL found");

    const author = data.author?.unique_id || data.author?.nickname || "Unknown";
    const playCount = formatNumber(data.play_count);
    const duration = formatDuration(data.duration);

    const caption =
      `🎬 *TikTok Video*\n\n` +
      `👤 *Author:* @${author}\n` +
      `👁️ *Views:* ${playCount}\n` +
      `⏱️ *Duration:* ${duration}\n\n` +
      `📝 *Title:* ${data.title || "No title"}\n` +
      `🎵 *Music:* ${data.music_info?.title || "Unknown"}`;

    await reply("⬆️ Uploading to WhatsApp...");

    // ✅ Baileys-safe (NO buffer, NO stream bugs)
    await sock.sendMessage(jid, {
      video: { url: videoUrl },
      mimetype: "video/mp4",
      caption,
    });

    await reply("✅ Done!");
  } catch (e) {
    console.error("TikTok Error:", e);
    await reply(`❌ Error: ${e.message}`);
  }
}

module.exports = { handle };
