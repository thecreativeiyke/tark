// File-signature ("magic byte") detection for uploads.
//
// The client-supplied MIME type and file name are attacker-controlled, so they are never
// trusted. The first bytes of the file decide what it is. Only formats Tark accepts are
// recognised; anything else (HTML, SVG, scripts, executables, GIF, AVIF, Matroska...) returns
// null and is rejected.
//
// Limit: a signature check proves a file STARTS like a JPEG/PNG/etc. It cannot detect a
// polyglot (a valid image with extra content appended). Serve uploads with the detected
// content type and `X-Content-Type-Options: nosniff`, and prefer re-encoding images.

export type FileKind = 'image' | 'video';

export interface DetectedFile {
  mime: string;
  ext: string;
  kind: FileKind;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ISO-BMFF "ftyp" major brands (compared lower-cased, 4 chars).
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif']);
const QUICKTIME_BRANDS = new Set(['qt  ']);
const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'mp71',
  'avc1', 'dash', 'mmp4', 'm4v ', 'm4vh', 'm4vp', 'msnv', 'xavc', 'f4v ',
]);

export function detectFileType(buf: Buffer): DetectedFile | null {
  if (!buf || buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { mime: 'image/png', ext: 'png', kind: 'image' };
  }

  // WebP: "RIFF" .... "WEBP"
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  }

  // ISO base media (HEIC / MP4 / MOV): bytes 4-8 are "ftyp", bytes 8-12 the major brand.
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const boxSize = buf.readUInt32BE(0);
    if (boxSize < 12 || boxSize > 4096) return null;
    const brand = buf.toString('ascii', 8, 12).toLowerCase();
    if (HEIC_BRANDS.has(brand)) return { mime: 'image/heic', ext: 'heic', kind: 'image' };
    if (QUICKTIME_BRANDS.has(brand)) return { mime: 'video/quicktime', ext: 'mov', kind: 'video' };
    if (MP4_BRANDS.has(brand)) return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
    return null;
  }

  // WebM: EBML header 1A 45 DF A3 with DocType "webm" (Matroska "matroska" is rejected).
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    if (buf.subarray(0, Math.min(64, buf.length)).includes('webm')) {
      return { mime: 'video/webm', ext: 'webm', kind: 'video' };
    }
    return null;
  }

  return null;
}

// What the client CLAIMED, reduced to image / video / unknown.
export function claimedKind(claimedMime: string | undefined): FileKind | null {
  const m = String(claimedMime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return null;
}

// The original file name is only ever used for display; the stored name is rebuilt from a
// sanitised stem plus the extension of the DETECTED type, so ".png" can never carry a script.
export function safeFilename(original: string | undefined, ext: string): string {
  const base = String(original ?? 'upload').split(/[\\/]/).pop() ?? 'upload';
  const stem = base
    .replace(/\.[^.]*$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${stem || 'upload'}.${ext}`;
}
