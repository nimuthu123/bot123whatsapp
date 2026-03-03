// commands/fb.js (using facebook-dl package)
// npm i facebook-dl
// No token required!

const fbDownloader = require('facebook-dl');

function safeFileName(name) {
  return (name || "Facebook_Video")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 60);
}

function extractFbVideoId(input) {
  if (!input) return null;

  // numeric id
  if (/^\d{8,}$/.test(input)) return input;

  // /videos/<id>
  let m = input.match(/\/videos\/(\d{8,})/);
  if (m) return m[1];

  // story.php?story_fbid=<id>
  m = input.match(/[?&]story_fbid=(\d{8,})/);
  if (m) return m[1];

  // video.php?v=<id>
  m = input.match(/[?&]v=(\d{8,})/);
  if (m) return m[1];

  // Just return the URL if it's a valid Facebook URL
  if (input.includes('facebook.com') || input.includes('fb.watch')) {
    return input;
  }

  return null;
}

module.exports = {
  name: "fb",

  async handle({ sock, jid, urlOrId, reply, quoted }) {
    try {
      const videoId = extractFbVideoId(urlOrId);
      if (!videoId) {
        await reply("❌ Invalid Facebook video link or ID");
        return;
      }

      await reply("⏳ Downloading Facebook video...");

      // Use facebook-dl package to download
      const videoInfo = await fbDownloader(urlOrId);
      
      if (!videoInfo || !videoInfo.url) {
        throw new Error("Could not fetch video");
      }

      // Get the highest quality video URL
      const videoUrl = videoInfo.url.hd || videoInfo.url.sd;
      const title = videoInfo.title || "Facebook Video";
      
      const fileName = `${safeFileName(title)}.mp4`;
      const caption = 
        `*${title}*\n` +
        (videoInfo.url.hd ? `🎥 HD Available\n` : `🎥 SD\n`) +
        `> *_Downloaded by NIMUTHU Bot MD_*`;

      await sock.sendMessage(
        jid,
        {
          document: { url: videoUrl },
          mimetype: "video/mp4",
          fileName,
          caption,
        },
        { quoted }
      );
    } catch (e) {
      console.error("[FB] Error:", e.message);
      await reply("❌ Failed to download Facebook video. Make sure the link is valid and video is public.");
    }
  },
};
