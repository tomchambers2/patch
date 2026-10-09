// folderLabel — the friendly label for a chat's folder crumb (ChatHeader) and
// the document title (documentTitle.ts): the folder's basename, full path
// dropped. `null` where the chat names no real folder — an empty path, or one
// that is only `.` — so a caller can leave the segment out entirely. There is
// no placeholder: a stand-in folder string says the chat is somewhere it
// isn't (NO FALLBACK).
export function folderLabel(folder: string): string | null {
  const segs = folder.split('/').filter((s) => s.trim() !== '' && s !== '.');
  return segs[segs.length - 1] ?? null;
}
