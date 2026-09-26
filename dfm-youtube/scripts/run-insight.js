const { getGoogleAuthClients } = require("../src/lib/googleAuth");
const { getYoutubeOAuthClient } = require("../src/lib/youtubeAuth");
const { runInsightSync } = require("../src/lib/insightSync");
const { google } = require("googleapis");

(async () => {
  console.log("========================================");
  console.log("Affiliate Insight (YouTube) - mulai jalan");
  console.log("========================================");
  const { sheets } = await getGoogleAuthClients();
  const auth = await getYoutubeOAuthClient();
  const youtube = google.youtube({ version: "v3", auth });
  await runInsightSync({ sheets, youtube, auth });
})().catch((e) => {
  console.error("FATAL ERROR:", e);
  process.exit(1);
});
