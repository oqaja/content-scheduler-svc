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
  postFirstComment,
} = require("./youtubePublisher");

function sheetStatusFor(privacyStatus) {
  return privacyStatus === "public" ? CONFIG.POSTED_STATUS_VALUE : CONFIG.SCHEDULED_STATUS_VALUE;
}

/** Coba post first comment kalau ada isinya dan belum pernah sukses. Gagal itu wajar (video masih private) - dibiarkan, dicoba lagi run berikutnya. */
async function tryPostFirstComment(row, headerMap, videoId, { sheets, youtube }) {
  const nomorBaris = row._rowNumber;
  const commentText = String(row[CONFIG.FIRST_COMMENT_COLUMN] || "").trim();
  if (!commentText) return; // tidak ada first comment yang diminta

  const currentStatus = String(row[CONFIG.FIRST_COMMENT_STATUS_COLUMN] || "").trim();
  if (currentStatus === CONFIG.FIRST_COMMENT_DONE_VALUE) return; // sudah pernah sukses

  try {
    await postFirstComment(youtube, videoId, commentText);
    await setCellValue(
      sheets,
      CONFIG.KALENDER_SPREADSHEET_ID,
      CONFIG.SHEET_NAME,
      nomorBaris,
      headerMap[CONFIG.FIRST_COMMENT_STATUS_COLUMN],
      CONFIG.FIRST_COMMENT_DONE_VALUE
    );
    console.log(`  First comment berhasil diposting di baris ${nomorBaris}.`);
  } catch (e) {
    console.log(`  (info) First comment baris ${nomorBaris} belum berhasil (kemungkinan video masih private): ${e.message}`);
  }
}

async function processNewUpload(row, headerMap, { sheets, drive, youtube }) {
  const nomorBaris = row._rowNumber;
  const namaFile = String(row[CONFIG.FILE_MATCH_COLUMN] || "").trim();
  const judul = String(row[CONFIG.TITLE_TEXT_COLUMN] || "").trim() || namaFile;
  const caption = String(row[CONFIG.CAPTION_COLUMN] || "").trim();
  const tanggalCell = row[CONFIG.TANGGAL_COLUMN];
  const jamCell = row[CONFIG.JAM_COLUMN];

  console.log(`Proses upload baris ${nomorBaris}: ${judul}`);

  try {
    const jadwalUpload = combineDateAndTime(tanggalCell, jamCell, CONFIG.TIMEZONE);
    if (!jadwalUpload) {
      throw new Error(`TANGGAL (${tanggalCell}) atau ${CONFIG.JAM_COLUMN} (${jamCell}) tidak valid.`);
    }

    const videoFile = await cariFileVideo(drive, namaFile);
    if (!videoFile) {
      throw new Error(`File video tidak ditemukan di folder Drive dengan nama: ${namaFile}`);
    }

    const title = buildTitle(judul);
    const description = buildDescription(caption);
    const { privacyStatus, publishAt } = determinePrivacyAndSchedule(jadwalUpload);
    const statusToWrite = sheetStatusFor(privacyStatus);

    const fileStream = await downloadFileStream(drive, videoFile.id);
    const uploaded = await uploadVideo(youtube, { title, description, fileStream, privacyStatus, publishAt });

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

    await tryPostFirstComment(row, headerMap, uploaded.id, { sheets, youtube });
  } catch (e) {
    await setCellValue(sheets, CONFIG.KALENDER_SPREADSHEET_ID, CONFIG.SHEET_NAME, nomorBaris, headerMap[CONFIG.STATUS_COLUMN], CONFIG.ERROR_STATUS_VALUE);
    await setCellValue(sheets, CONFIG.KALENDER_SPREADSHEET_ID, CONFIG.SHEET_NAME, nomorBaris, headerMap[CONFIG.CATATAN_COLUMN], `Error upload: ${e.toString()}`);
    console.log(`  GAGAL baris ${nomorBaris}: ${e.toString()}`);
  }
}

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

    await setCellValue(sheets, CONFIG.KALENDER_SPREADSHEET_ID, CONFIG.SHEET_NAME, nomorBaris, headerMap[CONFIG.STATUS_COLUMN], expectedSheetStatus);

    await tryPostFirstComment(row, headerMap, videoId, { sheets, youtube });
  } catch (e) {
    console.log(`  (info) Gagal cek/reschedule baris ${nomorBaris} (${videoId}): ${e.message}`);
  }
}

async function runMainUpload({ sheets, drive, youtube }) {
  const headerMap = await getHeaderColumnMap(sheets, CONFIG.KALENDER_SPREADSHEET_ID, CONFIG.SHEET_NAME);

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
