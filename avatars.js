// Profile pictures, shared by the study app and the teacher dashboard. A
// profile's photo is "avatar:<name>" for one of the pictures in icons/avatars/,
// a small JPEG data URL the student uploaded, or "" for none (their initial).

import { escapeHtml } from "./questions.js";

export const AVATARS = [
  ["owl", "Owl"], ["fox", "Fox"], ["cat", "Cat"], ["panda", "Panda"],
  ["penguin", "Penguin"], ["frog", "Frog"], ["rocket", "Rocket"], ["planet", "Planet"],
];

// User names: 3 to 20 letters, numbers, or underscores. Keep in sync with firestore.rules.
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

export function photoSrc(photo) {
  if (!photo) return "";
  if (photo.startsWith("avatar:")) return `icons/avatars/${photo.slice(7)}.svg`;
  return photo.startsWith("data:image/jpeg;base64,") ? photo : "";
}

// A round picture, or the user name's first letter when there's no picture.
export function avatarHtml(profile, size = 32) {
  const src = photoSrc(profile?.photo);
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px`;
  return src
    ? `<img class="avatar" src="${escapeHtml(src)}" alt="" style="${style}">`
    : `<span class="avatar initial" aria-hidden="true" style="${style}">${escapeHtml((profile?.username || "?")[0].toUpperCase())}</span>`;
}

// Turns an uploaded image into a square 160px JPEG data URL, small enough to keep
// in Firestore (the rules allow up to 40,000 characters).
export async function photoFromFile(file) {
  if (!file.type.startsWith("image/")) throw new Error("not-image");
  if (file.size > 20 * 1024 * 1024) throw new Error("too-big");
  const image = await createImageBitmap(file);
  const side = Math.min(image.width, image.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 160;
  canvas.getContext("2d").drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 160, 160);
  image.close();
  for (const quality of [0.85, 0.7, 0.5]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= 40000) return url;
  }
  throw new Error("too-big");
}
