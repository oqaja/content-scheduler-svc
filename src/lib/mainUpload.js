const { CONFIG } = require("./config");
const { getReadyRows, getUploadedRows } = require("./sheetReader");
const { cariFileVideo, downloadFileStream } = require("./driveFinder");
const { setCellValue, getHeaderColumnMap } = require("./sheetsHelper");
const { combineDateAndTime } = require("./dateUtils");
const {
  buildTitle,
  buildDescription,
  determinePrivacyAndSchedule,
  uploadVideo,
  updateVideoSchedule,
  getVideoStatus,
} = require("./youtubePublisher");

function sheetStatusFor(privacyStatus) {
  return privacyStatus === "public" ? CONFIG.POSTED_STATUS_VALUE : CONFIG.SCHEDULED_STATUS_VALUE;
}

async function processNewUpload(row, headerMap, { sheets, drive, youtube }) {
  const nomorBaris = row._rowNumber;
  const judul = String(row[CONFIG.JUDUL_COLUMN] || "").trim();
  const caption = String(row[CONFIG.CAPTION_COLUMN] || "").trim();
  const tanggalCell = row[CONFIG.TANGGAL_COLUMN];
  const jamCell = row[CONFIG.JAM_COLUMN];

  console.log(`Proses upload baris ${nomorBaris}: ${judul}`);

  try {
    const jadwalUpload = combineDateAndTime(tanggalCell, jamCell, CONFIG.TIMEZONE);
    if (!jadwalUpload) {
      throw new Error(`TANGGAL (${tanggalCell}) atau ${CONFIG.JAM_COLUMN} (${jamCell}) tidak valid.`);
    }

    const videoFile = await cariFileVideo(drive, judul);
    if (!videoFile) {
      throw new Error(`File video tidak ditemukan di folder Drive dengan nama: ${judul}`);
    }

    const title = buildTitle(judul);
    const description = buildDescription(caption);
    const { privacyStatus, publishAt } = determinePrivacyAndSchedule(jadwalUpload);
    const statusToWrite = sheetStatusFor(privacyStatus);

    console.log(`  DEBUG baris ${nomorBaris}: jadwalUpload=${jadwalUpload.toISOString()}, privacyStatus=${privacyStatus}, statusToWrite="${statusToWrite}"`);

    const fileStream = await downloadFileStream(drive, videoFile.id);
    const uploaded = await uploadVideo(youtube, { title, description, fileStream, privacyStatus, publishAt });

    console.log(`  DEBUG baris ${nomorBaris}: menulis STATUS_COLUMN kolom ke-${headerMap[CONFIG.STATUS_COLUMN]} = "${statusToWrite}"`);
    await setCellValue(sheets, CONFIG.KALENDER_SPREADSHEET_ID, CONFIG.SHEET_NAME, nomorBaris, headerMap[CONFIG.STATUS_COLUMN], statusToWrite);
    await setCellValue(sheets, CONFIG.KALENDER_SPREADSHEET_ID, CONFIG.SHEET_NAME, nomorBaris, headerMap[CONFIG.POST_ID_COLUMN], uploaded.id);
    await setCellValue(
      sheets,
      CONFIG.KALENDER_SPREADSHEET_ID,
      CONFIG.SHEET_NAME,
      nomorBaris,
      headerMap[CONFIG.CATATAN_COLUMN],
      `Upload sukses (${privacyStatus}${publishAt ? `, publish ${jadwalUpload.toLocaleString("id-ID")}` : ""}).`
    );

    console.log(`  BERHASIL upload baris ${nomorBaris}: ${uploaded.id} (${privacyStatus})`);
  } catch (e) {
    await setCellValue(sheets, CONFIG.KALENDER_SPREADSHEET_ID, CONFIG.SHEET_NAME, nomorBaris, headerMap[CONFIG.STATUS_COLUMN], CONFIG.ERROR_STATUS_VALUE);
    await setCellValue(sheets, CONFIG.KALENDER_SPREADSHEET_ID, CONFIG.SHEET_NAME, nomorBaris, headerMap[CONFIG.CATATAN_COLUMN], `Error upload: ${e.toString()}`);
    console.log(`  GAGAL baris ${nomorBaris}: ${e.toString()}`);
  }
}

/** Reschedule dinamis - SELALU pastikan status sheet sesuai expectedPrivacy saat ini, apa pun kondisi video di YouTube. */
async function processReschedule(row, headerMap, { sheets, youtube }) {
  const nomorBaris = row._rowNumber;
  const videoId = String(row[CONFIG.POST_ID_COLUMN] || "").trim();
  const tanggalCell = row[CONFIG.TANGGAL_COLUMN];
  const jamCell = row[CONFIG.JAM_COLUMN];

  const jadwalUpload = combineDateAndTime(tanggalCell, jamCell, CONFIG.TIMEZONE);
  if (!jadwalUpload) return;

  try {
    const currentStatus = await getVideoStatus(youtube, videoId);
    if (!currentStatus) {
      console.log(`  (skip) Video ${videoId} (baris ${nomorBaris}) tidak ditemukan di YouTube - mungkin dihapus manual.`);
      return;
    }

    const { privacyStatus: expectedPrivacy, publishAt: expectedPublishAt } = determinePrivacyAndSchedule(jadwalUpload);
    const expectedSheetStatus = sheetStatusFor(expectedPrivacy);

    console.log(`  DEBUG baris ${nomorBaris}: currentStatus.privacyStatus=${currentStatus.privacyStatus}, currentStatus.publishAt=${currentStatus.publishAt}, expectedPrivacy=${expectedPrivacy}, expectedSheetStatus="${expectedSheetStatus}"`);

    const currentPublishAtMs = currentStatus.publishAt ? new Date(currentStatus.publishAt).getTime() : null;
    const expectedPublishAtMs = expectedPublishAt ? new Date(expectedPublishAt).getTime() : null;
    const needsYoutubeUpdate = currentStatus.privacyStatus !== expectedPrivacy || currentPublishAtMs !== expectedPublishAtMs;

    if (needsYoutubeUpdate) {
      console.log(`  Reschedule baris ${nomorBaris} (${videoId}): ${currentStatus.privacyStatus} -> ${expectedPrivacy}`);
      await updateVideoSchedule(youtube, videoId, jadwalUpload);
      await setCellValue(
        sheets,
        CONFIG.KALENDER_SPREADSHEET_ID,
        CONFIG.SHEET_NAME,
        nomorBaris,
        headerMap[CONFIG.CATATAN_COLUMN],
        `Reschedule ke ${expectedPrivacy}${expectedPublishAt ? `, publish ${jadwalUpload.toLocaleString("id-ID")}` : ""}.`
      );
    }

    // SELALU tulis status sheet sesuai expectedSheetStatus saat ini, terlepas dari apa video-nya sendiri perlu diupdate atau tidak.
    console.log(`  DEBUG baris ${nomorBaris}: menulis STATUS_COLUMN kolom ke-${headerMap[CONFIG.STATUS_COLUMN]} = "${expectedSheetStatus}"`);
    await setCellValue(sheets, CONFIG.KALENDER_SPREADSHEET_ID, CONFIG.SHEET_NAME, nomorBaris, headerMap[CONFIG.STATUS_COLUMN], expectedSheetStatus);
  } catch (e) {
    console.log(`  (info) Gagal cek/reschedule baris ${nomorBaris} (${videoId}): ${e.message}`);
  }
}

async function runMainUpload({ sheets, drive, youtube }) {
  const headerMap = await getHeaderColumnMap(sheets, CONFIG.KALENDER_SPREADSHEET_ID, CONFIG.SHEET_NAME);
  console.log(`DEBUG headerMap[${CONFIG.STATUS_COLUMN}] = ${headerMap[CONFIG.STATUS_COLUMN]}`);

  const readyRows = await getReadyRows(sheets);
  console.log(`${readyRows.length} row siap di-upload.`);
  for (const row of readyRows) {
    await processNewUpload(row, headerMap, { sheets, drive, youtube });
  }

  const uploadedRows = await getUploadedRows(sheets);
  console.log(`${uploadedRows.length} row sudah pernah upload - cek apakah ada reschedule.`);
  for (const row of uploadedRows) {
    await processReschedule(row, headerMap, { sheets, youtube });
  }

  console.log("Selesai proses Main Upload.");
}

module.exports = { runMainUpload };
