// index.js - Ultra-Low RAM Multi-Session WhatsApp Bot (MEMORY FIXED + Forwarded many times)
// Run: node --expose-gc index.js  (optional for GC)

const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode-terminal");
const P = require("pino");

const tiktokCommand = require("./commands/tiktok");
const menuCommand = require("./commands/menu");
const ytCommand = require("./commands/yt");
const fbCommand = require("./commands/fb");

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require("@whiskeysockets/baileys");

// ================== CONFIG ==================
const CONFIG = {
  AUTH_ROOT: path.join(__dirname, "auth"),
  SESSION_STORAGE: path.join(__dirname, "auth", "sessions"),
  MAIN_SESSION: path.join(__dirname, "auth", "main"),

  RECONNECT_INTERVAL: 5000,
  PAIRING_WAIT_BEFORE_REQUEST: 6000,

  // loop prevention (bot-sent ids)
  SENT_ID_TTL_MS: 25_000,
  SENT_ID_MAX: 700,

  // status dedupe cache
  STATUS_CACHE_TTL_MS: 45_000,
  STATUS_CACHE_MAX: 700,

  CLEANUP_INTERVAL_MS: 30_000,
  MEM_LOG_INTERVAL_MS: 20_000,

  // ✅ read only commands (and YT selection replies)
  AUTO_READ_COMMANDS_ONLY: true,

  // ✅ auto status (only main)
  AUTO_VIEW_STATUS: true,
  AUTO_REACT_STATUS: true,
  STATUS_REACTION_EMOJI: "😊",
  STATUS_ONLY_MAIN_SESSION: true,

  // ✅ "Forwarded many times" label
  ADD_FORWARDED_LABEL: true,
  FORWARDED_SCORE: 999,

  // Optional forced GC
  FORCE_GC_INTERVAL_MS: 5 * 60 * 1000, // 5 min
};

// ================== UTILS ==================
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};
const rmDirSafe = (dir) => {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digitsOnly = (s) => (s || "").replace(/\D/g, "");

function normalizePhone(raw) {
  const d = digitsOnly(raw);
  if (!d) return "";
  if (d.startsWith("94")) return d;
  if (d.startsWith("0")) return "94" + d.slice(1);
  return d.length === 9 ? "94" + d : d;
}

function getMessageText(m) {
  const msg = m.message;
  if (!msg) return "";
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ""
  );
}

// Only treat these as "real status contents" (not reaction/protocol)
function isRealStatusContent(message) {
  if (!message) return false;
  return !!(
    message.conversation ||
    message.extendedTextMessage ||
    message.imageMessage ||
    message.videoMessage
  );
}

// ================== MANAGER ==================
class SessionManager {
  constructor() {
    this.sessions = new Map(); // phone -> session object
    this.version = null;

    this.mainSock = null;
    this.mainConnecting = false;
    this.mainReconnectTimer = null;

    this.restoreDone = false; // ✅ prevent restoreSessions duplication

    this.sentIdsBySock = new WeakMap(); // WeakMap<sock, Set<msgId>>
    this.statusSeen = new Map(); // Map<participant|id, ts>

    // pending YT reply selection
    this.pendingYt = new Map(); // key `${jid}|${sender}` -> { url, createdAt, menuMsgId }
    this.PENDING_YT_TTL_MS = 60 * 1000;

    // child reconnect timer dedupe
    this.childReconnectTimers = new Map(); // phone -> timer

    this.logger = P({ level: "fatal" });

    setInterval(() => this.cleanupMemory(), CONFIG.CLEANUP_INTERVAL_MS).unref?.();

    // RAM monitor
    setInterval(() => {
      const m = process.memoryUsage();
      const toMB = (x) => Math.round((x / 1024 / 1024) * 10) / 10;
      console.log(
        `[MEM] rss=${toMB(m.rss)}MB heapUsed=${toMB(m.heapUsed)}MB heapTotal=${toMB(
          m.heapTotal
        )}MB ext=${toMB(m.external)}MB`
      );
    }, CONFIG.MEM_LOG_INTERVAL_MS).unref?.();

    // Optional forced GC
    setInterval(() => {
      if (global.gc) {
        console.log("[SYSTEM] GC...");
        global.gc();
      }
    }, CONFIG.FORCE_GC_INTERVAL_MS).unref?.();
  }

  cleanupMemory() {
    const now = Date.now();

    // status cache TTL
    for (const [k, t] of this.statusSeen) {
      if (now - t > CONFIG.STATUS_CACHE_TTL_MS) this.statusSeen.delete(k);
    }
    // hard cap: remove oldest insertion order
    if (this.statusSeen.size > CONFIG.STATUS_CACHE_MAX) {
      const extra = this.statusSeen.size - CONFIG.STATUS_CACHE_MAX;
      let i = 0;
      for (const k of this.statusSeen.keys()) {
        this.statusSeen.delete(k);
        if (++i >= extra) break;
      }
    }

    // pending yt TTL
    for (const [k, v] of this.pendingYt) {
      if (!v || now - v.createdAt > this.PENDING_YT_TTL_MS) this.pendingYt.delete(k);
    }
  }

  // ✅ IMPORTANT: really destroy old socket (prevents listener leak)
  async destroySocket(sock) {
    if (!sock) return;
    try {
      sock.ev?.removeAllListeners?.();
    } catch {}
    try {
      sock.ws?.removeAllListeners?.();
    } catch {}
    try {
      sock.end?.();
    } catch {}
    try {
      sock.ws?.close?.();
    } catch {}
  }

  markSent(sock, msgId) {
    if (!sock || !msgId) return;

    let set = this.sentIdsBySock.get(sock);
    if (!set) {
      set = new Set();
      this.sentIdsBySock.set(sock, set);
    }
    set.add(msgId);

    // hard cap
    if (set.size > CONFIG.SENT_ID_MAX) {
      const excess = set.size - CONFIG.SENT_ID_MAX;
      let i = 0;
      for (const v of set) {
        set.delete(v);
        if (++i >= excess) break;
      }
    }

    setTimeout(() => {
      try {
        set.delete(msgId);
        if (set.size === 0) this.sentIdsBySock.delete(sock);
      } catch {}
    }, CONFIG.SENT_ID_TTL_MS).unref?.();
  }

  wasSentByBot(sock, msgId) {
    const set = this.sentIdsBySock.get(sock);
    return !!(set && set.has(msgId));
  }

  // ✅ Send helper + "Forwarded many times" label
  async safeSend(sock, jid, content) {
    try {
      const payload = typeof content === "string" ? { text: content } : { ...(content || {}) };

      // ✅ Add "Forwarded many times" label (NOT for reactions)
      if (CONFIG.ADD_FORWARDED_LABEL && !payload.react) {
        payload.contextInfo = {
          ...(payload.contextInfo || {}),
          forwardingScore: CONFIG.FORWARDED_SCORE,
          isForwarded: true,
        };
      }

      const sent = await sock.sendMessage(jid, payload);
      this.markSent(sock, sent?.key?.id);
      return sent;
    } catch {
      return null;
    }
  }

  makeSocketBaseOptions(state) {
    return {
      version: this.version,
      logger: this.logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },

      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      markOnlineOnConnect: false,

      // ✅ LOW RAM
      emitOwnEvents: false,
      fireInitQueries: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async () => ({ conversation: "" }),

      generateHighQualityLinkPreview: false,
      msgRetryCounterCache: undefined,

      connectTimeoutMs: 20_000,
      defaultQueryTimeoutMs: 20_000,
      retryRequestDelayMs: 150,
      maxRetries: 2,
    };
  }

  async initialize() {
    ensureDir(CONFIG.AUTH_ROOT);
    ensureDir(CONFIG.MAIN_SESSION);
    ensureDir(CONFIG.SESSION_STORAGE);

    const { version } = await fetchLatestBaileysVersion();
    this.version = version;

    await this.startMainSession();
  }

  // ✅ ONE status = ONE reaction (and only MAIN if enabled)
  async handleStatusAuto(sock, m, isMain) {
    try {
      if (m.key?.remoteJid !== "status@broadcast") return;
      if (m.key?.fromMe) return;

      if (CONFIG.STATUS_ONLY_MAIN_SESSION && !isMain) return;
      if (!isRealStatusContent(m.message)) return;

      const id = m.key?.id || "";
      const participant = m.key?.participant || "";
      if (!id || !participant) return;

      const statusKey = `${participant}|${id}`;
      if (this.statusSeen.has(statusKey)) return;

      this.statusSeen.set(statusKey, Date.now());

      if (CONFIG.AUTO_VIEW_STATUS) {
        await sock.readMessages([m.key]).catch(() => {});
      }

      if (CONFIG.AUTO_REACT_STATUS) {
        await sock
          .sendMessage(
            "status@broadcast",
            { react: { text: CONFIG.STATUS_REACTION_EMOJI, key: m.key } },
            { statusJidList: [participant] }
          )
          .catch(() => {});
      }
    } catch {}
  }

  attachHandlers(sock, isMain) {
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" && type !== "append") return;

      for (const m of messages) {
        if (!m?.message) continue;

        const jid = m.key?.remoteJid;
        const msgId = m.key?.id;

        // ✅ statuses
        if (jid === "status@broadcast") {
          await this.handleStatusAuto(sock, m, isMain);
          continue;
        }

        // prevent loops only for bot-sent messages
        if (this.wasSentByBot(sock, msgId)) continue;

        const text = (getMessageText(m) || "").trim();

        // ✅ sender key (works in group + private)
        const sender = m.key?.participant || m.key?.remoteJid || "";
        const pendingKey = `${jid}|${sender}`;

        // ✅ If user has pending YT selection, accept 1/2/3 (no dot needed)
        if (this.pendingYt.has(pendingKey) && (text === "1" || text === "2" || text === "3")) {
          // ✅ Read only the selection reply (still not reading normal messages)
          if (CONFIG.AUTO_READ_COMMANDS_ONLY) {
            await sock.readMessages([m.key]).catch(() => {});
          }

          const pending = this.pendingYt.get(pendingKey);
          this.pendingYt.delete(pendingKey);

          await ytCommand.sendByMode({
            sock,
            jid,
            ytUrl: pending.url,
            mode: text,
            reply: (msg) => this.safeSend(sock, jid, msg),
          });
          continue;
        }

        // ✅ Read ONLY command messages (normal messages not read)
        if (CONFIG.AUTO_READ_COMMANDS_ONLY && text.startsWith(".")) {
          await sock.readMessages([m.key]).catch(() => {});
        }

        // commands only from here
        if (!text.startsWith(".")) continue;

        const parts = text.split(/\s+/);
        const cmd = (parts[0] || "").toLowerCase();
        const arg1 = parts[1];

        if (cmd === ".menu") {
          await menuCommand.handle({
            sock,
            jid,
            reply: (msg) => this.safeSend(sock, jid, msg),
          });
        } else if (cmd === ".ping") {
          await this.safeSend(sock, jid, "Pong! 🏓");
        }

        // ✅ YouTube downloader MENU (reply 1/2/3) - SAFE fallback (no crash)
        else if (cmd === ".yt") {
          const url = (arg1 || "").trim();
          if (!url) {
            await this.safeSend(sock, jid, "❌ Use: `.yt <youtube link>`");
            continue;
          }

          if (ytCommand.isYouTubeUrl && !ytCommand.isYouTubeUrl(url)) {
            await this.safeSend(sock, jid, "❌ Please send a valid YouTube link.");
            continue;
          }

          let menuMsg = null;
          try {
            if (typeof ytCommand.buildMenuPayload === "function") {
              const menu = await ytCommand.buildMenuPayload(url);
              menuMsg = await this.safeSend(
                sock,
                jid,
                menu?.thumbUrl
                  ? { image: { url: menu.thumbUrl }, caption: menu.caption }
                  : (menu?.caption ||
                      "Reply number:\n1️⃣ Video\n2️⃣ Audio\n3️⃣ Document\n\n⏳ Reply within 60 seconds.")
              );
            } else {
              menuMsg = await this.safeSend(
                sock,
                jid,
                "Reply number:\n1️⃣ Video\n2️⃣ Audio\n3️⃣ Document\n\n⏳ Reply within 60 seconds."
              );
            }
          } catch {
            menuMsg = await this.safeSend(
              sock,
              jid,
              "Reply number:\n1️⃣ Video\n2️⃣ Audio\n3️⃣ Document\n\n⏳ Reply within 60 seconds."
            );
          }

          this.pendingYt.set(pendingKey, {
            url,
            createdAt: Date.now(),
            menuMsgId: menuMsg?.key?.id || null,
          });
        }

        // ✅ Facebook video downloader
        else if (cmd === ".fb") {
          const urlOrId = (arg1 || "").trim();
          if (!urlOrId) {
            await this.safeSend(sock, jid, "❌ Use: `.fb <facebook video link or ID>`");
            continue;
          }

          await fbCommand.handle({
            sock,
            jid,
            urlOrId,
            quoted: m,
            reply: (msg) => this.safeSend(sock, jid, msg),
          });
        }

        // ✅ TikTok downloader
        else if (cmd === ".tt") {
          const url = (arg1 || "").trim();
          if (!url) {
            await this.safeSend(sock, jid, "❌ Use: `.tt <tiktok link>`");
            continue;
          }

          await tiktokCommand.handle({
            sock,
            jid,
            url,
            reply: (msg) => this.safeSend(sock, jid, msg),
          });
        }

        // ✅ Optional: manual GC test (run node with --expose-gc)
        else if (cmd === ".gc") {
          if (global.gc) {
            global.gc();
            await this.safeSend(sock, jid, "✅ GC called.");
          } else {
            await this.safeSend(sock, jid, "❌ Run: `node --expose-gc index.js`");
          }
        }

        // ✅ Pair: create child session via pairing code
        else if (cmd === ".pair") {
          const num = normalizePhone(arg1);
          if (!num || num.length < 10) {
            await this.safeSend(sock, jid, "❌ Use: `.pair 07XXXXXXXX`");
            continue;
          }
          await this.safeSend(sock, jid, `⏳ Pairing *${num}*...`);
          await this.startChildSession(num, {
            replySock: sock,
            replyJid: jid,
            forceFresh: true,
          });
        }

        // unknown commands => silent
      }
    });
  }

  // ✅ MAIN SESSION (no recursion leak)
  async startMainSession() {
    if (this.mainConnecting) return;
    this.mainConnecting = true;

    // clear pending reconnect timer
    if (this.mainReconnectTimer) {
      clearTimeout(this.mainReconnectTimer);
      this.mainReconnectTimer = null;
    }

    // destroy old main sock if exists
    if (this.mainSock) {
      await this.destroySocket(this.mainSock);
      this.mainSock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.MAIN_SESSION);
    const sock = makeWASocket({ ...this.makeSocketBaseOptions(state), printQRInTerminal: true });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (up) => {
      if (up.qr) qrcode.generate(up.qr, { small: true });

      if (up.connection === "open") {
        console.log("[MAIN] Connected");
        this.mainSock = sock;
        this.mainConnecting = false;

        // ✅ restore only once
        if (!this.restoreDone) {
          this.restoreDone = true;
          this.restoreSessions();
        }
      }

      if (up.connection === "close") {
        const code = up.lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;

        console.log("[MAIN] Closed", loggedOut ? "(logged out)" : "");

        // cleanup this sock
        await this.destroySocket(sock);

        this.mainSock = null;
        this.mainConnecting = false;

        // schedule reconnect
        this.mainReconnectTimer = setTimeout(() => {
          this.startMainSession().catch(console.error);
        }, CONFIG.RECONNECT_INTERVAL).unref?.();
      }
    });

    this.attachHandlers(sock, true);
  }

  async startChildSession(phone, opts = {}) {
    const sessionDir = path.join(CONFIG.SESSION_STORAGE, phone);

    // timer dedupe
    const oldTimer = this.childReconnectTimers.get(phone);
    if (oldTimer) {
      clearTimeout(oldTimer);
      this.childReconnectTimers.delete(phone);
    }

    if (opts.forceFresh) {
      const old = this.sessions.get(phone);
      if (old?.sock) await this.destroySocket(old.sock);
      rmDirSafe(sessionDir);
    }

    ensureDir(sessionDir);

    let session = this.sessions.get(phone) || { phone, authDir: sessionDir, connected: false };
    session = {
      ...session,
      lastReplySock: opts.replySock || session.lastReplySock,
      lastReplyJid: opts.replyJid || session.lastReplyJid,
    };
    this.sessions.set(phone, session);

    const { state, saveCreds } = await useMultiFileAuthState(session.authDir);
    session.registered = !!state.creds?.registered;

    // destroy previous sock (prevents duplicates)
    if (session.sock) await this.destroySocket(session.sock);

    const sock = makeWASocket(this.makeSocketBaseOptions(state));
    session.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    // pairing code request for unregistered session
    const requestPairingOnce = async () => {
      try {
        await sleep(CONFIG.PAIRING_WAIT_BEFORE_REQUEST);
        const code = await sock.requestPairingCode(digitsOnly(phone));
        if (!code) return;

        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        const msg = `📱 *PAIRING CODE*\n\nNumber: ${phone}\nCode: *${formatted}*`;
        if (session.lastReplySock && session.lastReplyJid) {
          await this.safeSend(session.lastReplySock, session.lastReplyJid, msg);
        }
      } catch {}
    };

    sock.ev.on("connection.update", async (up) => {
      const { connection, lastDisconnect } = up;

      if (connection === "connecting" && !session.registered) {
        requestPairingOnce();
      }

      if (connection === "open") {
        session.connected = true;
        session.registered = true;

        if (session.lastReplySock && session.lastReplyJid) {
          this.safeSend(session.lastReplySock, session.lastReplyJid, `✅ Connected: ${phone}`);
        }
      }

      if (connection === "close") {
        session.connected = false;

        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;

        await this.destroySocket(sock);

        if (loggedOut) {
          rmDirSafe(session.authDir);
          this.sessions.delete(phone);
          return;
        }

        // schedule reconnect (dedupe)
        const t = setTimeout(() => {
          this.startChildSession(phone).catch(() => {});
        }, CONFIG.RECONNECT_INTERVAL);
        t.unref?.();
        this.childReconnectTimers.set(phone, t);
      }
    });

    // child handlers attached, but statuses won't react because STATUS_ONLY_MAIN_SESSION=true
    this.attachHandlers(sock, false);
  }

  async restoreSessions() {
    try {
      if (!fs.existsSync(CONFIG.SESSION_STORAGE)) return;
      const dirs = fs.readdirSync(CONFIG.SESSION_STORAGE).filter((d) => !!d);
      for (const p of dirs) {
        await sleep(1200); // stagger
        this.startChildSession(p).catch(() => {});
      }
    } catch (e) {
      console.error("restoreSessions error:", e);
    }
  }
}

new SessionManager().initialize().catch(console.error);
