const { CONFIG } = require("./config");
const { readSheetAsObjects } = require("./sheetsHelper");
const { isSameDateInTimezone, nowMinutesInTimezone, combineDateAndTime } = require("./dateUtils");

function toMinutesOfDay(jamCell) {
  if (typeof jamCell === "number") {
    const fraction = jamCell - Math.floor(jamCell);
    return Math.round(fraction * 24 * 60);
  }
  const jamStr = String(jamCell || "").trim().replace(".", ":");
  const parts = jamStr.split(":");
  if (parts.length < 2) return null;
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

function isReadyToPost(row, now) {
  const production = String(row[CONFIG.PRODUCTION_COLUMN] || "").trim();
  if (production !== CONFIG.PRODUCTION_DONE_VALUE) return false;

  const statusYt = String(row[CONFIG.STATUS_COLUMN] || "").trim().toUpperCase();
  if (statusYt !== CONFIG.READY_STATUS_VALUE.toUpperCase()) return false;

  const namaFile = String(row[CONFIG.FILE_MATCH_COLUMN] || "").trim();
  if (!namaFile) return false;

  const postId = String(row[CONFIG.POST_ID_COLUMN] || "").trim();
  if (postId !== "") return false; // sudah pernah upload, biarkan proses reschedule yang urus, bukan upload baru

  return true;
}

/** Row yang statusnya Acc + Production selesai (siap upload, terlepas dari jadwalnya sudah lewat/belum -> itu menentukan private/public, bukan apa perlu diproses). */
async function getReadyRows(sheets) {
  const { rows } = await readSheetAsObjects(sheets, CONFIG.KALENDER_SPREADSHEET_ID, CONFIG.SHEET_NAME);
  const now = new Date();
  return rows.filter((row) => isReadyToPost(row, now));
}

/** Row yang SUDAH pernah di-upload (punya POST ID YT), dipakai buat cek reschedule dinamis. */
async function getUploadedRows(sheets) {
  const { rows } = await readSheetAsObjects(sheets, CONFIG.KALENDER_SPREADSHEET_ID, CONFIG.SHEET_NAME);
  return rows.filter((row) => String(row[CONFIG.POST_ID_COLUMN] || "").trim() !== "");
}

module.exports = { getReadyRows, getUploadedRows, isReadyToPost, toMinutesOfDay };
