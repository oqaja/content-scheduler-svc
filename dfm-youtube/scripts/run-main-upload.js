const { getGoogleAuthClients } = require("../src/lib/googleAuth");
const { getYoutubeClient } = require("../src/lib/youtubeAuth");
const { runMainUpload } = require("../src/lib/mainUpload");

(async () => {
  console.log("========================================");
  console.log("Affiliate Automation (YouTube) - mulai jalan");
  console.log("========================================");
  const { sheets, drive } = await getGoogleAuthClients();
  const youtube = await getYoutubeClient();
  await runMainUpload({ sheets, drive, youtube });
})().catch((e) => {
  console.error("FATAL ERROR:", e);
  process.exit(1);
});
