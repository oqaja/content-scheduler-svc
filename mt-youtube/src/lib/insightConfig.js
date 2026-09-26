// Config khusus tarik insight. Sengaja dipisah dari config.js supaya run insight
// gak butuh env var upload (KALENDER_SPREADSHEET_ID, DRIVE_FOLDER_ID, template deskripsi),
// dan run upload gak butuh INSIGHT_SPREADSHEET_ID.
const AKUN = "MT";

const INSIGHT_CONFIG = {
  AKUN,
  INSIGHT_SPREADSHEET_ID: getRequiredEnv("MT_INSIGHT_SPREADSHEET_ID"),

  // Tab dibuat otomatis kalau belum ada. Nama tab diberi suffix AKUN supaya ketiga
  // channel boleh nulis ke spreadsheet yang sama tanpa bentrok.
  VIDEO_SHEET_NAME: `INSIGHT VIDEO ${AKUN}`,
  CHANNEL_SHEET_NAME: `INSIGHT CHANNEL ${AKUN}`,

  // Data harian YouTube Analytics telat ~2-3 hari dan masih bisa direvisi, jadi
  // tiap run N hari terakhir ditarik ulang dan di-overwrite.
  DAILY_LOOKBACK_DAYS: 30,

  TIMEZONE: "Asia/Jakarta",
};

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable '${name}' belum di-set. Cek GitHub Variables atau file .env lokal.`);
  }
  return value;
}

module.exports = { INSIGHT_CONFIG };
