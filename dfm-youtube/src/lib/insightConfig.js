// Config khusus tarik insight. Dipisah dari config.js supaya run insight gak butuh env var
// upload (DRIVE_FOLDER_ID, template deskripsi). Insight ditulis langsung ke tab
// "KALENDER AFFILIATE" (spreadsheet yang sama dengan upload), jadi cuma butuh KALENDER_SPREADSHEET_ID.
const AKUN = "DFM";

const INSIGHT_CONFIG = {
  AKUN,
  KALENDER_SPREADSHEET_ID: getRequiredEnv("KALENDER_SPREADSHEET_ID"),
  SHEET_NAME: "KALENDER AFFILIATE",
  AKUN_COLUMN: "AKUN",
  POST_ID_COLUMN: "POST ID YT",

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
