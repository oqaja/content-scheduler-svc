// ID resource + template deskripsi dibaca dari environment variable (GitHub Actions
// repo Variables / file .env lokal), tidak di-hardcode. Lihat .env.example.
const CONFIG = {
  KALENDER_SPREADSHEET_ID: getSecret("KALENDER_SPREADSHEET_ID"),
  SHEET_NAME: "KALENDER AFFILIATE",

  DRIVE_FOLDER_ID: getSecret("DRIVE_FOLDER_ID"),

  STATUS_COLUMN: "STATUS YT",
  READY_STATUS_VALUE: "Acc",
  POSTED_STATUS_VALUE: "Uploaded",
  SCHEDULED_STATUS_VALUE: "Scheduled",
  ERROR_STATUS_VALUE: "Gagal",
  FIRST_COMMENT_COLUMN: "FIRST COMMENT",
  FIRST_COMMENT_STATUS_COLUMN: "FIRST COMMENT STATUS",
  FIRST_COMMENT_DONE_VALUE: "Posted",
  PRODUCTION_COLUMN: "PRODUCTION",
  PRODUCTION_DONE_VALUE: "✅",

  JAM_COLUMN: "JAM UP YT",
  TANGGAL_COLUMN: "TANGGAL",
  FILE_MATCH_COLUMN: "JUDUL VIDEO",
  TITLE_TEXT_COLUMN: "JUDUL KONTEN",
  CAPTION_COLUMN: "CAPTION",
  POST_ID_COLUMN: "POST ID YT",
  CATATAN_COLUMN: "CATATAN",

  TIMEZONE: "Asia/Jakarta",

  MAX_TITLE_LENGTH: 100, // batas YouTube buat judul video
  MAX_DESCRIPTION_LENGTH: 5000,

  // Template deskripsi channel (di-append ke tiap video). Diisi dari repo Variable
  // CHANNEL_DESCRIPTION_TEMPLATE.
  DESCRIPTION_TEMPLATE: getSecret("CHANNEL_DESCRIPTION_TEMPLATE"),
};

function getSecret(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable '${name}' belum di-set. Cek GitHub Secrets atau file .env lokal.`);
  }
  return value;
}

module.exports = { CONFIG, getSecret };
