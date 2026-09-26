/**
 * insightSync.js
 * Tarik insight channel lalu upsert ke spreadsheet insight:
 *  - tab "INSIGHT VIDEO <AKUN>"   : 1 baris per video (key: VIDEO ID), di-update tiap run.
 *  - tab "INSIGHT CHANNEL <AKUN>" : 1 baris per tanggal (key: TANGGAL), N hari terakhir di-update tiap run.
 *
 * Aturan tulis:
 *  - Tab + header dibuat otomatis kalau belum ada. Header yang hilang ditambah di kanan.
 *  - Hanya kolom milik sistem ini yang ditulis; kolom tambahan buatan user (catatan, rumus) aman.
 *  - Nilai `undefined` = jangan sentuh cell (dipakai kalau Analytics API gagal, supaya angka
 *    lama gak ketimpa kosong).
 */

const { INSIGHT_CONFIG } = require("./insightConfig");
const { ensureSheetWithHeaders, columnNumberToLetter, withRateLimitRetry } = require("./sheetsHelper");
const { toSheetDateString } = require("./dateUtils");
const {
  getMyChannel,
  listUploadedVideoIds,
  getVideoDetails,
  getVideoAnalytics,
  getDailyChannelAnalytics,
  parseIsoDurationToSeconds,
  toNumber,
} = require("./youtubeInsight");

const VIDEO_HEADERS = [
  "VIDEO ID",
  "URL",
  "JUDUL",
  "TANGGAL PUBLISH",
  "PRIVACY",
  "DURASI (DETIK)",
  "VIEWS",
  "LIKES",
  "COMMENTS",
  "SHARES",
  "WATCH TIME (MENIT)",
  "AVG VIEW DURATION (DETIK)",
  "AVG VIEW %",
  "SUBS GAINED",
  "LAST UPDATED",
];

const CHANNEL_HEADERS = [
  "TANGGAL",
  "VIEWS",
  "WATCH TIME (MENIT)",
  "SUBS GAINED",
  "SUBS LOST",
  "LIKES",
  "COMMENTS",
  "SHARES",
  "TOTAL SUBSCRIBERS",
  "TOTAL VIEWS",
  "TOTAL VIDEO",
  "LAST UPDATED",
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dateOnly(date) {
  return toSheetDateString(date, INSIGHT_CONFIG.TIMEZONE).slice(0, 10);
}

function round2(value) {
  return value === "" ? "" : Math.round(value * 100) / 100;
}

async function ensureRowCapacity(sheets, spreadsheetId, sheetName, neededRows) {
  const res = await withRateLimitRetry(
    () => sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" }),
    "ensureRowCapacity(get)"
  );
  const sheet = res.data.sheets.find((s) => s.properties.title === sheetName);
  const rowCount = sheet.properties.gridProperties.rowCount;
  if (rowCount >= neededRows) return;
  await withRateLimitRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ appendDimension: { sheetId: sheet.properties.sheetId, dimension: "ROWS", length: neededRows - rowCount } }],
        },
      }),
    "ensureRowCapacity(append)"
  );
}

/** Upsert `records` (object header -> value) ke tab, dicocokkan lewat kolom `keyHeader`. Semua tulis dalam 1 batchUpdate. */
async function upsertRowsByKey(sheets, spreadsheetId, sheetName, headers, keyHeader, records) {
  await ensureSheetWithHeaders(sheets, spreadsheetId, sheetName, headers);

  const res = await withRateLimitRetry(
    () => sheets.spreadsheets.values.get({ spreadsheetId, range: `'${sheetName}'`, valueRenderOption: "UNFORMATTED_VALUE" }),
    "upsertRowsByKey(read)"
  );
  const data = res.data.values || [];
  const headerRow = (data[0] || []).map((h) => String(h || "").trim());

  const colIndex = {};
  for (const h of headers) {
    let idx = headerRow.indexOf(h);
    if (idx === -1) {
      headerRow.push(h);
      idx = headerRow.length - 1;
    }
    colIndex[h] = idx;
  }

  const grid = data.slice(1).map((r) => r.slice());
  const rowByKey = new Map();
  grid.forEach((r, i) => {
    const key = String(r[colIndex[keyHeader]] ?? "").trim();
    if (key) rowByKey.set(key, i);
  });

  let added = 0;
  let updated = 0;
  for (const record of records) {
    const key = String(record[keyHeader]).trim();
    let i = rowByKey.get(key);
    if (i === undefined) {
      i = grid.length;
      grid.push([]);
      rowByKey.set(key, i);
      added++;
    } else {
      updated++;
    }
    for (const h of headers) {
      if (record[h] !== undefined) grid[i][colIndex[h]] = record[h];
    }
  }

  await ensureRowCapacity(sheets, spreadsheetId, sheetName, grid.length + 1);

  const ranges = [{ range: `'${sheetName}'!A1:${columnNumberToLetter(headerRow.length)}1`, values: [headerRow] }];
  if (grid.length > 0) {
    for (const h of headers) {
      const col = columnNumberToLetter(colIndex[h] + 1);
      ranges.push({
        range: `'${sheetName}'!${col}2:${col}${grid.length + 1}`,
        values: grid.map((r) => [r[colIndex[h]] ?? ""]),
      });
    }
  }

  // RAW supaya key TANGGAL "YYYY-MM-DD" tetap string (gak di-parse jadi serial date) dan tetap match di run berikutnya.
  await withRateLimitRetry(
    () => sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: "RAW", data: ranges } }),
    "upsertRowsByKey(write)"
  );

  return { added, updated };
}

/** Jalanin fungsi Analytics; kalau gagal (scope belum ada / API belum di-enable) log warning dan return null, bukan crash. */
async function tryAnalytics(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.log(`  (warning) ${label} gagal: ${e.message}`);
    console.log("  -> Kolom Analytics gak di-update run ini. Cek: scope yt-analytics.readonly sudah ada di refresh token");
    console.log("     (jalanin ulang `npm run regen-token`) dan 'YouTube Analytics API' sudah di-enable di Google Cloud.");
    return null;
  }
}

function buildVideoRecord(video, analyticsRow, lastUpdated) {
  const stats = video.statistics || {};
  const publishDate =
    video.status && video.status.privacyStatus === "private" && video.status.publishAt
      ? video.status.publishAt // video terjadwal: pakai jadwal tayang, bukan waktu upload
      : video.snippet.publishedAt;

  const record = {
    "VIDEO ID": video.id,
    URL: `https://youtube.com/shorts/${video.id}`,
    JUDUL: video.snippet.title,
    "TANGGAL PUBLISH": toSheetDateString(new Date(publishDate), INSIGHT_CONFIG.TIMEZONE),
    PRIVACY: video.status ? video.status.privacyStatus : "",
    "DURASI (DETIK)": parseIsoDurationToSeconds(video.contentDetails && video.contentDetails.duration),
    VIEWS: toNumber(stats.viewCount),
    LIKES: toNumber(stats.likeCount),
    COMMENTS: toNumber(stats.commentCount),
    "LAST UPDATED": lastUpdated,
  };

  if (analyticsRow === null) return record; // Analytics gagal -> kolom Analytics biarkan nilai lama
  const a = analyticsRow || {}; // video tanpa data Analytics (baru / belum tayang) -> 0
  record.SHARES = toNumber(a.shares ?? 0);
  record["WATCH TIME (MENIT)"] = toNumber(a.estimatedMinutesWatched ?? 0);
  record["AVG VIEW DURATION (DETIK)"] = toNumber(a.averageViewDuration ?? 0);
  record["AVG VIEW %"] = round2(toNumber(a.averageViewPercentage ?? 0));
  record["SUBS GAINED"] = toNumber(a.subscribersGained ?? 0);
  return record;
}

async function syncVideoInsight({ sheets, youtube, auth }, channel, today, lastUpdated) {
  const videoIds = await listUploadedVideoIds(youtube, channel.contentDetails.relatedPlaylists.uploads);
  console.log(`${videoIds.length} video ditemukan di channel.`);
  const videos = await getVideoDetails(youtube, videoIds);

  const channelStartDate = dateOnly(new Date(channel.snippet.publishedAt));
  const analyticsByVideo =
    videos.length > 0
      ? await tryAnalytics("Analytics per video", () => getVideoAnalytics(auth, videoIds, channelStartDate, today))
      : new Map();

  const records = videos.map((v) =>
    buildVideoRecord(v, analyticsByVideo === null ? null : analyticsByVideo.get(v.id), lastUpdated)
  );

  const { added, updated } = await upsertRowsByKey(
    sheets,
    INSIGHT_CONFIG.INSIGHT_SPREADSHEET_ID,
    INSIGHT_CONFIG.VIDEO_SHEET_NAME,
    VIDEO_HEADERS,
    "VIDEO ID",
    records
  );
  console.log(`  Tab '${INSIGHT_CONFIG.VIDEO_SHEET_NAME}': ${added} baris baru, ${updated} baris di-update.`);
}

async function syncChannelInsight({ sheets, auth }, channel, today, lastUpdated) {
  const startDate = dateOnly(new Date(Date.now() - INSIGHT_CONFIG.DAILY_LOOKBACK_DAYS * MS_PER_DAY));
  const daily = await tryAnalytics("Analytics harian channel", () => getDailyChannelAnalytics(auth, startDate, today));

  const records = (daily || []).map((d) => ({
    TANGGAL: d.day,
    VIEWS: toNumber(d.views),
    "WATCH TIME (MENIT)": toNumber(d.estimatedMinutesWatched),
    "SUBS GAINED": toNumber(d.subscribersGained),
    "SUBS LOST": toNumber(d.subscribersLost),
    LIKES: toNumber(d.likes),
    COMMENTS: toNumber(d.comments),
    SHARES: toNumber(d.shares),
    "LAST UPDATED": lastUpdated,
  }));

  // Snapshot total channel (real-time dari Data API) ditempel di baris hari ini, supaya
  // pertumbuhan subscriber/total views kelihatan dari hari ke hari.
  const stats = channel.statistics || {};
  const snapshot = {
    TANGGAL: today,
    "TOTAL SUBSCRIBERS": toNumber(stats.subscriberCount),
    "TOTAL VIEWS": toNumber(stats.viewCount),
    "TOTAL VIDEO": toNumber(stats.videoCount),
    "LAST UPDATED": lastUpdated,
  };
  const todayRecord = records.find((r) => r.TANGGAL === today);
  if (todayRecord) Object.assign(todayRecord, snapshot);
  else records.push(snapshot);

  const { added, updated } = await upsertRowsByKey(
    sheets,
    INSIGHT_CONFIG.INSIGHT_SPREADSHEET_ID,
    INSIGHT_CONFIG.CHANNEL_SHEET_NAME,
    CHANNEL_HEADERS,
    "TANGGAL",
    records
  );
  console.log(`  Tab '${INSIGHT_CONFIG.CHANNEL_SHEET_NAME}': ${added} baris baru, ${updated} baris di-update.`);
}

async function runInsightSync({ sheets, youtube, auth }) {
  const now = new Date();
  const today = dateOnly(now);
  const lastUpdated = toSheetDateString(now, INSIGHT_CONFIG.TIMEZONE);

  const channel = await getMyChannel(youtube);
  console.log(`Channel: ${channel.snippet.title} (${channel.id})`);

  await syncVideoInsight({ sheets, youtube, auth }, channel, today, lastUpdated);
  await syncChannelInsight({ sheets, auth }, channel, today, lastUpdated);

  console.log("Selesai tarik insight.");
}

module.exports = { runInsightSync, upsertRowsByKey, VIDEO_HEADERS, CHANNEL_HEADERS };
