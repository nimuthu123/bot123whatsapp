const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const MENU_IMAGE_PATH = path.join(__dirname, "..", "assets", "menu.jpg");
const MAX_IMAGE_SIZE = 1.8 * 1024 * 1024; // 1.8MB

/* ===== MENU TEXT ===== */
function buildCaption() {
  return (
    "📌 *BEAUTIFUL MENU*\n\n" +
    "╔══════════════════╗\n" +
    "║   ✨ *NIMUTHU MD* ✨   ║\n" +
    "╚══════════════════╝\n\n" +

    "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n" +
    "🌟 *GENERAL COMMANDS* 🌟\n" +
    "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n" +
    "┌──⊷ *INFORMATION* ⊶\n" +
    "│ ✦ `.menu` - Show this menu\n" +
    "│ ✦ `.ping` - Check bot response\n" +
    "└───────────────◯\n\n" +

    "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n" +
    "🎵 *DOWNLOADER* 🎵\n" +
    "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n" +
    "┌──⊷ *SOCIAL MEDIA* ⊶\n" +
    "│ ✦ `.tt <url>` - TikTok video\n" +
    "│ ✦ `.fb <url>` - Facebook video\n" +
    "│ ✦ `.ig <url>` - Instagram post\n" +
    "└───────────────◯\n\n" +

    "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n" +
    "⚙️ *UTILITIES* ⚙️\n" +
    "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n" +
    "┌──⊷ *TOOLS* ⊶\n" +
    "│ ✦ `.pair <num>` - Pair device\n" +
    "│ ✦ `.sticker` - Image to sticker\n" +
    "│ ✦ `.qr <text>` - Generate QR\n" +
    "└───────────────◯\n\n" +

    "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n" +
    "🎨 *FUN* 🎨\n" +
    "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n" +
    "┌──⊷ *ENTERTAINMENT* ⊶\n" +
    "│ ✦ `.fact` - Random facts\n" +
    "│ ✦ `.joke` - Joke generator\n" +
    "│ ✦ `.meme` - Random meme\n" +
    "└───────────────◯\n\n" +

    "✨ *Thanks for using this bot!* ✨"
  );
}

module.exports = {
  async handle({ sock, jid, reply }) {
    const caption = buildCaption();

    try {
      const stat = await fsp.stat(MENU_IMAGE_PATH);

      // fallback to text only
      if (!stat.isFile() || stat.size > MAX_IMAGE_SIZE) {
        return reply(caption);
      }

      // ✅ LOWEST RAM METHOD (Baileys handles file)
      await sock.sendMessage(jid, {
        image: { url: MENU_IMAGE_PATH },
        caption,
      });

    } catch (err) {
      return reply(caption);
    }
  },
};
