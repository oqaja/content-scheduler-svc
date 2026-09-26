/**
 * youtubeInsight.js
 * Tarik data insight channel dari dua sumber:
 *  - YouTube Data API v3      : statistik real-time (views/likes/comments per video, subscriber total).
 *                               Scope `youtube` yang sudah dipakai upload sudah cukup.
 *  - YouTube Analytics API v2 : watch time, avg view duration, shares, subs gained, dan data harian.
 *                               Butuh scope `yt-analytics.readonly` (lihat scripts/regen-refresh-token.js)
 *                               + API "YouTube Analytics API" di-enable di Google Cloud project.
 */

const { google } = require("googleapis");

const VIDEO_BATCH_SIZE = 50; // batas id per videos.list
const ANALYTICS_VIDEO_FILTER_SIZE = 200; // id per query Analytics (filter video==a,b,c)

const VIDEO_ANALYTICS_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "shares",
  "subscribersGained",
];

const DAILY_ANALYTICS_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "subscribersGained",
  "subscribersLost",
  "likes",
  "comments",
  "shares",
];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return "";
  const n = Number(value);
  return isNaN(n) ? "" : n;
}

/** "PT1M5S" -> 65. Durasi ISO 8601 dari contentDetails.duration. */
function parseIsoDurationToSeconds(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ""));
  if (!m) return "";
  const [, d, h, min, s] = m.map((v) => parseInt(v || "0", 10));
  return d * 86400 + h * 3600 + min * 60 + s;
}

async function getMyChannel(youtube) {
  const res = await youtube.channels.list({ part: ["snippet", "statistics", "contentDetails"], mine: true });
  const channel = res.data.items && res.data.items[0];
  if (!channel) throw new Error("Channel YouTube tidak ditemukan untuk refresh token ini.");
  return channel;
}

/** Semua video id di playlist "uploads" channel (termasuk yang private/scheduled, karena kita owner-nya). */
async function listUploadedVideoIds(youtube, uploadsPlaylistId) {
  const ids = [];
  let pageToken;
  do {
    const res = await youtube.playlistItems.list({
      part: ["contentDetails"],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken,
    });
    for (const item of res.data.items || []) ids.push(item.contentDetails.videoId);
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return ids;
}

async function getVideoDetails(youtube, videoIds) {
  const videos = [];
  for (const ids of chunk(videoIds, VIDEO_BATCH_SIZE)) {
    const res = await youtube.videos.list({ part: ["snippet", "statistics", "contentDetails", "status"], id: ids });
    videos.push(...(res.data.items || []));
  }
  return videos;
}

function rowsToObjects(data) {
  const headers = (data.columnHeaders || []).map((h) => h.name);
  return (data.rows || []).map((row) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i]));
    return obj;
  });
}

/** Metrik Analytics lifetime per video. Return Map videoId -> { views, estimatedMinutesWatched, ... }. */
async function getVideoAnalytics(auth, videoIds, startDate, endDate) {
  const analytics = google.youtubeAnalytics({ version: "v2", auth });
  const result = new Map();
  for (const ids of chunk(videoIds, ANALYTICS_VIDEO_FILTER_SIZE)) {
    const res = await analytics.reports.query({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: VIDEO_ANALYTICS_METRICS.join(","),
      dimensions: "video",
      filters: `video==${ids.join(",")}`,
      sort: "-views",
      maxResults: ANALYTICS_VIDEO_FILTER_SIZE,
    });
    for (const obj of rowsToObjects(res.data)) result.set(obj.video, obj);
  }
  return result;
}

/** Metrik Analytics level channel per hari. Return array { day: "YYYY-MM-DD", views, ... }. */
async function getDailyChannelAnalytics(auth, startDate, endDate) {
  const analytics = google.youtubeAnalytics({ version: "v2", auth });
  const res = await analytics.reports.query({
    ids: "channel==MINE",
    startDate,
    endDate,
    metrics: DAILY_ANALYTICS_METRICS.join(","),
    dimensions: "day",
    sort: "day",
  });
  return rowsToObjects(res.data);
}

module.exports = {
  getMyChannel,
  listUploadedVideoIds,
  getVideoDetails,
  getVideoAnalytics,
  getDailyChannelAnalytics,
  parseIsoDurationToSeconds,
  toNumber,
};
