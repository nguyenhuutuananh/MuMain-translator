// zip.ts - ZIP writer (stored, no compression) and reader (stored or deflate) for the fallback web
// build's save download and the translation packages (see package.ts). A thin wrapper over fflate,
// which runs the same on the desktop server, in the browser and in tests; it keeps the AppError
// messages and the entry shape the rest of the code uses. No encryption or multi-disk archives.

import { inflateSync, unzipSync, zipSync, type Zippable } from "fflate";
import { AppError } from "./errors";

// fflate does not verify checksums, so the CRC-32 of every unpacked file is compared with the one
// in the central directory (the check that catches a damaged download).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string; // "/"-separated path inside the archive
  bytes: Uint8Array;
}

export function zip(files: ZipEntry[], date = new Date()): Uint8Array {
  const entries: Zippable = {};
  for (const f of files) entries[f.name] = [f.bytes, { level: 0, mtime: date }];
  return zipSync(entries);
}

export const isZip = (bytes: Uint8Array) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

const bad = (detail: string) => new AppError("zip-invalid", `Not a usable ZIP file: ${detail}.`, { detail });

// An archive (or one entry) larger than this once unpacked is refused (a zip bomb, not a package).
const MAX_UNPACKED = 512 * 1024 * 1024;

// CRC-32 and name of the files (not folders) in central-directory order, which is the order
// unzipSync returns them in. Names here are only used to line up with fflate's output.
function centralCrcs(bytes: Uint8Array): number[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw bad("no end of central directory");
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const out: number[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw bad("broken central directory");
    const nameLen = v.getUint16(p + 28, true);
    const folder = bytes[p + 46 + nameLen - 1] === 0x2f && nameLen > 0;
    if (!folder) out.push(v.getUint32(p + 16, true));
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return out;
}

// The files of an archive (folders left out). Names that are not marked UTF-8 are read as Latin-1
// (Windows' built-in zip writes them in the local code page; package files only use ASCII names).
export function unzip(bytes: Uint8Array): ZipEntry[] {
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith("/")) return false;
        total += f.originalSize;
        if (total > MAX_UNPACKED) throw bad("it unpacks to too much data");
        return true;
      },
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw bad(/end of central directory|invalid zip|unexpected EOF/i.test(msg) ? `no end of central directory (${msg})` : msg);
  }
  const crcs = centralCrcs(bytes);
  return Object.entries(files).map(([name, content], i) => {
    if (crcs[i] !== undefined && crc32(content) !== crcs[i]) throw bad(`${name} is damaged (CRC)`);
    return { name: name.replace(/\\/g, "/"), bytes: content };
  });
}

// Decode raw deflate data (RFC 1951). `expected` is only a size hint.
export function inflateRaw(src: Uint8Array, expected = 0): Uint8Array {
  try {
    return inflateSync(src, expected > 0 ? { out: new Uint8Array(expected) } : undefined);
  } catch (e) {
    throw bad(e instanceof Error ? e.message : String(e));
  }
}
