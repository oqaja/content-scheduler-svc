/**
 * insightSync.js
 * Tarik insight video channel ini lalu tulis LANGSUNG ke tab "KALENDER AFFILIATE",
 * di kolom sebelah kanan baris kontennya masing-masing.
 *
 * Aturan:
 *  - Baris dicocokkan lewat POST ID YT (= video ID YouTube) dan hanya baris dengan AKUN
 *    channel ini yang disentuh. Baris channel lain & kolom milik sistem lain gak diubah.
 *  - Header kolom insight dibuat otomatis di kanan header terakhir kalau belum ada.
 *  - Tulis per-sel (bukan per-kolom penuh), jadi 3 channel boleh jalan bersamaan tanpa
 *    saling menimpa.
 *  - Nilai `undefined` = jangan sentuh sel (dipakai kalau Analytics API gagal, supaya angka
 *    lama gak ketimpa kosong).
 */

const { INSIGHT_CONFIG } = require("./insightConfig");
const { columnNumberToLetter, withRateLimitRetry } = require("./sheetsHelper");
const { toSheetDateString } = require("./dateUtils");
const {
  getMyChannel,
  listUploadedVideoIds,
  getVideoDetails,
  getVideoAnalytics,
  toNumber,
} = require("./youtubeInsight");

// Prefix "YT" biar jelas ini angka YouTube kalau nanti ada insight platform lain di sheet yang sama.
const INSIGHT_HEADERS = [
  "YT VIEWS",
  "YT LIKES",
  "YT COMMENTS",
  "YT SHARES",
  "YT WATCH TIME (MENIT)",
  "YT AVG VIEW DURATION (DETIK)",
  "YT AVG VIEW %",
  "YT SUBS GAINED",
  "YT INSIGHT UPDATED",
  "YT LINK",
];

function dateOnly(date) {
  return toSheetDateString(date, INSIGHT_CONFIG.TIMEZONE).slice(0, 10);
}

function round2(value) {
  return Math.round(value * 100) / 100;
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

/** Record header -> nilai untuk 1 video. Kolom yang gak boleh disentuh dibiarkan undefined. */
function buildInsightRecord(video, analyticsRow, lastUpdated) {
  const stats = video.statistics || {};
  const record = {
    "YT VIEWS": toNumber(stats.viewCount),
    "YT LIKES": toNumber(stats.likeCount),
    "YT COMMENTS": toNumber(stats.commentCount),
    "YT INSIGHT UPDATED": lastUpdated,
    "YT LINK": `https://youtube.com/shorts/${video.id}`,
  };

  if (analyticsRow === null) return record; // Analytics gagal -> kolom Analytics biarkan nilai lama
  const a = analyticsRow || {}; // video tanpa data Analytics (baru / belum tayang) -> 0
  record["YT SHARES"] = toNumber(a.shares ?? 0);
  record["YT WATCH TIME (MENIT)"] = toNumber(a.estimatedMinutesWatched ?? 0);
  record["YT AVG VIEW DURATION (DETIK)"] = toNumber(a.averageViewDuration ?? 0);
  record["YT AVG VIEW %"] = round2(toNumber(a.averageViewPercentage ?? 0));
  record["YT SUBS GAINED"] = toNumber(a.subscribersGained ?? 0);
  return record;
}

/** Pastikan semua INSIGHT_HEADERS ada di baris 1; yang belum ada ditaruh persis setelah header terakhir yang terisi. */
async function ensureInsightHeaders(sheets, spreadsheetId, sheetName) {
  const res = await withRateLimitRetry(
    () => sheets.spreadsheets.values.get({ spreadsheetId, range: `'${sheetName}'!1:1` }),
    "ensureInsightHeaders(read)"
  );
  const headerRow = ((res.data.values || [])[0] || []).map((h) => String(h || "").trim());

  let lastFilled = -1;
  headerRow.forEach((h, i) => {
    if (h !== "") lastFilled = i;
  });

  const colIndex = {};
  const toWrite = [];
  let nextIdx = lastFilled + 1;
  for (const h of INSIGHT_HEADERS) {
    const existing = headerRow.indexOf(h);
    if (existing !== -1) {
      colIndex[h] = existing;
    } else {
      colIndex[h] = nextIdx;
      toWrite.push({ range: `'${sheetName}'!${columnNumberToLetter(nextIdx + 1)}1`, values: [[h]] });
      nextIdx++;
    }
  }

  if (toWrite.length > 0) {
    await withRateLimitRetry(
      () =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: "RAW", data: toWrite },
        }),
      "ensureInsightHeaders(write)"
    );
    console.log(`  ${toWrite.length} header insight baru ditambahkan ke '${sheetName}'.`);
  }

  return { colIndex, headerRow };
}

async function runInsightSync({ sheets, youtube, auth }) {
  const { KALENDER_SPREADSHEET_ID: spreadsheetId, SHEET_NAME: sheetName } = INSIGHT_CONFIG;
  const now = new Date();
  const today = dateOnly(now);
  const lastUpdated = toSheetDateString(now, INSIGHT_CONFIG.TIMEZONE);

  const channel = await getMyChannel(youtube);
  console.log(`Channel: ${channel.snippet.title} (${channel.id})`);

  const videoIds = await listUploadedVideoIds(youtube, channel.contentDetails.relatedPlaylists.uploads);
  console.log(`${videoIds.length} video ditemukan di channel.`);
  const videos = await getVideoDetails(youtube, videoIds);

  const channelStartDate = dateOnly(new Date(channel.snippet.publishedAt));
  const analyticsByVideo =
    videos.length > 0
      ? await tryAnalytics("Analytics per video", () => getVideoAnalytics(auth, videoIds, channelStartDate, today))
      : new Map();

  const recordById = new Map(
    videos.map((v) => [v.id, buildInsightRecord(v, analyticsByVideo === null ? null : analyticsByVideo.get(v.id), lastUpdated)])
  );

  const { colIndex, headerRow } = await ensureInsightHeaders(sheets, spreadsheetId, sheetName);

  // Baca ulang seluruh tab (nilai mentah) buat nyocokin baris.
  const res = await withRateLimitRetry(
    () => sheets.spreadsheets.values.get({ spreadsheetId, range: `'${sheetName}'`, valueRenderOption: "UNFORMATTED_VALUE" }),
    "runInsightSync(read)"
  );
  const data = res.data.values || [];
  const postIdCol = headerRow.indexOf(INSIGHT_CONFIG.POST_ID_COLUMN);
  const akunCol = headerRow.indexOf(INSIGHT_CONFIG.AKUN_COLUMN);
  if (postIdCol === -1 || akunCol === -1) {
    throw new Error(
      `Kolom '${INSIGHT_CONFIG.POST_ID_COLUMN}' / '${INSIGHT_CONFIG.AKUN_COLUMN}' tidak ketemu di tab '${sheetName}'. ` +
        `Cek header baris 1 (harus persis sama).`
    );
  }

  const akun = INSIGHT_CONFIG.AKUN.toLowerCase();
  const ranges = [];
  let cocok = 0;
  let tidakKetemu = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i] || [];
    if (String(row[akunCol] ?? "").trim().toLowerCase() !== akun) continue;
    const postId = String(row[postIdCol] ?? "").trim();
    if (!postId) continue;

    const record = recordById.get(postId);
    if (!record) {
      tidakKetemu++;
      console.log(`  Baris ${i + 1}: video ${postId} gak ada di channel (dihapus / beda channel), dilewati.`);
      continue;
    }

    cocok++;
    for (const h of INSIGHT_HEADERS) {
      if (record[h] === undefined) continue;
      ranges.push({ range: `'${sheetName}'!${columnNumberToLetter(colIndex[h] + 1)}${i + 1}`, values: [[record[h]]] });
    }
  }

  if (ranges.length > 0) {
    await withRateLimitRetry(
      () =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: "RAW", data: ranges },
        }),
      "runInsightSync(write)"
    );
  }

  console.log(`  Tab '${sheetName}' (${INSIGHT_CONFIG.AKUN}): ${cocok} baris di-update, ${tidakKetemu} dilewati.`);
  console.log("Selesai tarik insight.");
}

module.exports = { runInsightSync, INSIGHT_HEADERS };
