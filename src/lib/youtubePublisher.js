const { CONFIG } = require("./config");

/** Judul di-lowercase-kan (bukan uppercase, sesuai keputusan lo) + suffix #Shorts. */
function buildTitle(judulKonten) {
  let title = judulKonten.trim().toLowerCase();
  const suffix = " #shorts";
  const maxBaseLength = CONFIG.MAX_TITLE_LENGTH - suffix.length;
  if (title.length > maxBaseLength) {
    title = title.substring(0, maxBaseLength).trim();
  }
  return title + suffix;
}

/** Gabung caption + template baku, potong dari BAGIAN CAPTION kalau kelebihan 5000 karakter (bukan template yang dipotong). */
function buildDescription(captionUser) {
  const template = CONFIG.DESCRIPTION_TEMPLATE;
  const separator = "\n\n";
  const maxCaptionLength = CONFIG.MAX_DESCRIPTION_LENGTH - template.length - separator.length;

  let caption = (captionUser || "").trim();
  if (maxCaptionLength > 0 && caption.length > maxCaptionLength) {
    caption = caption.substring(0, maxCaptionLength).trim();
  } else if (maxCaptionLength <= 0) {
    caption = "";
  }

  const full = caption ? `${caption}${separator}${template}` : template;
  return full.length > CONFIG.MAX_DESCRIPTION_LENGTH ? full.substring(0, CONFIG.MAX_DESCRIPTION_LENGTH) : full;
}

/** Tentukan privacyStatus + publishAt berdasarkan jadwal vs waktu sekarang. */
function determinePrivacyAndSchedule(jadwalUpload) {
  const now = new Date();
  if (jadwalUpload > now) {
    return { privacyStatus: "private", publishAt: jadwalUpload.toISOString() };
  }
  return { privacyStatus: "public", publishAt: null };
}

/** Upload video baru ke YouTube (resumable upload lewat stream dari Drive). */
async function uploadVideo(youtube, { title, description, fileStream, privacyStatus, publishAt }) {
  const requestBody = {
    snippet: { title, description },
    status: { privacyStatus, selfDeclaredMadeForKids: false },
  };
  if (publishAt) {
    requestBody.status.publishAt = publishAt;
  }

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody,
    media: { body: fileStream },
  });

  return res.data; // { id, ... }
}

/** Update jadwal video yang SUDAH ada (reschedule dinamis) - termasuk tarik balik Public -> Private kalau jadwal dimundurkan. */
async function updateVideoSchedule(youtube, videoId, jadwalUpload) {
  const { privacyStatus, publishAt } = determinePrivacyAndSchedule(jadwalUpload);

  const requestBody = {
    id: videoId,
    status: { privacyStatus, selfDeclaredMadeForKids: false },
  };
  if (publishAt) {
    requestBody.status.publishAt = publishAt;
  }

  await youtube.videos.update({ part: ["status"], requestBody });
  return { privacyStatus, publishAt };
}

/** Ambil status video saat ini dari YouTube (buat bandingin sebelum reschedule, hindari update yang gak perlu). */
async function getVideoStatus(youtube, videoId) {
  const res = await youtube.videos.list({ part: ["status"], id: [videoId] });
  const video = res.data.items && res.data.items[0];
  return video ? video.status : null;
}

module.exports = {
  buildTitle,
  buildDescription,
  determinePrivacyAndSchedule,
  uploadVideo,
  updateVideoSchedule,
  getVideoStatus,
};

/** Post komentar pertama ke video. Bisa gagal kalau video masih private (belum bisa dikomentari) - itu ditangani di pemanggil (retry di run berikutnya). */
async function postFirstComment(youtube, videoId, text) {
  await youtube.commentThreads.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        videoId,
        topLevelComment: { snippet: { textOriginal: text } },
      },
    },
  });
}

module.exports.postFirstComment = postFirstComment;
