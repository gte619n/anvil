/**
 * A small, strict zip reader for the SolidCraft release asset (agent-cad-and-browser spec §4.14
 * item 15). The daemon lists and extracts with ONE parser — its own — so there is no gap between
 * "the names we checked" and "the names some other tool wrote".
 *
 * What it refuses, before writing a single byte:
 *   - absolute paths, backslashes, drive letters, NUL bytes and any `..` segment;
 *   - symlinks, and every other entry that is neither a regular file nor a folder;
 *   - encrypted entries, compression other than stored/deflate, zip64, multi-disk archives;
 *   - duplicate names, more than one top-level folder, or files beside that folder;
 *   - archives over the entry-count and total-size caps (a zip bomb).
 *
 * Extraction strips the single top-level folder, writes into a folder the caller guarantees is new
 * and empty, creates every file exclusively (`wx`), and checks each file's size and CRC-32.
 */
import { createReadStream, createWriteStream, mkdirSync, openSync, readSync, closeSync, fstatSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, crc32 } from "node:zlib";

export type ZipProblem = "bad-zip" | "unsafe-zip";

/** A zip the daemon will not extract. `problem` separates "malformed" from "hostile". */
export class ZipError extends Error {
  constructor(
    readonly problem: ZipProblem,
    message: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  /** The entry's name exactly as stored in the central directory. */
  name: string;
  isDirectory: boolean;
  /** 0 = stored, 8 = deflate. Nothing else is accepted. */
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  /** Unix permission bits (0 when the archive was not made on Unix). */
  mode: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
/** Caps that a real release (7 entries, 0.5 GB) sits far inside. */
export const MAX_ZIP_ENTRIES = 2000;
export const MAX_ZIP_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function readAt(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, position + got);
    if (n <= 0) throw new ZipError("bad-zip", "zip is truncated");
    got += n;
  }
  return buf;
}

/** Why an entry NAME is unsafe, or undefined when it is fine. */
export function unsafeNameReason(name: string): string | undefined {
  if (!name) return "empty entry name";
  if (name.includes("\0")) return "entry name contains a NUL byte";
  if (name.includes("\\")) return `entry name contains a backslash: ${name}`;
  if (name.startsWith("/")) return `absolute path: ${name}`;
  if (/^[A-Za-z]:/.test(name)) return `drive-letter path: ${name}`;
  const parts = name.replace(/\/+$/, "").split("/");
  if (parts.some((p) => p === "..")) return `path escapes with '..': ${name}`;
  if (parts.some((p) => p === "" || p === ".")) return `path has an empty or '.' segment: ${name}`;
  return undefined;
}

/**
 * Read and validate the central directory. Throws `ZipError` on anything this module refuses; a
 * returned list is safe to hand to `extractZip`.
 */
export function readZipEntries(file: string): ZipEntry[] {
  const fd = openSync(file, "r");
  try {
    const fileSize = fstatSync(fd).size;
    if (fileSize < 22) throw new ZipError("bad-zip", "not a zip (too small)");
    // The end-of-central-directory record is the last thing in the file, after an optional comment.
    const tailLen = Math.min(fileSize, 22 + 0xffff);
    const tail = readAt(fd, tailLen, fileSize - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError("bad-zip", "not a zip (no end-of-central-directory record)");
    const disk = tail.readUInt16LE(eocd + 4);
    const cdDisk = tail.readUInt16LE(eocd + 6);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || cdDisk !== 0 || tail.readUInt16LE(eocd + 8) !== count) throw new ZipError("bad-zip", "multi-disk zips are not supported");
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("bad-zip", "zip64 archives are not supported");
    if (count === 0) throw new ZipError("bad-zip", "zip has no entries");
    if (count > MAX_ZIP_ENTRIES) throw new ZipError("unsafe-zip", `zip has ${count} entries (limit ${MAX_ZIP_ENTRIES})`);
    if (cdOffset + cdSize > fileSize) throw new ZipError("bad-zip", "central directory lies outside the file");

    const cd = readAt(fd, cdSize, cdOffset);
    const entries: ZipEntry[] = [];
    const seen = new Set<string>();
    let total = 0;
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN_SIG) throw new ZipError("bad-zip", "corrupt central directory");
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compressedSize = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      const localHeaderOffset = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new ZipError("bad-zip", "corrupt central directory");
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      p += 46 + nameLen + extraLen + commentLen;

      const bad = unsafeNameReason(name);
      if (bad) throw new ZipError("unsafe-zip", bad);
      if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) throw new ZipError("bad-zip", "zip64 entries are not supported");
      if (flags & 0x1) throw new ZipError("unsafe-zip", `encrypted entry: ${name}`);

      // Unix archives carry the file type in the high 16 bits of the external attributes.
      const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0;
      const type = unixMode & S_IFMT;
      const isDirectory = name.endsWith("/") || type === S_IFDIR;
      if (type === S_IFLNK) throw new ZipError("unsafe-zip", `symlink entry: ${name}`);
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) throw new ZipError("unsafe-zip", `entry is not a regular file or folder: ${name}`);
      if (isDirectory && (size !== 0 || (type !== 0 && type !== S_IFDIR))) throw new ZipError("unsafe-zip", `folder entry carries data: ${name}`);
      if (!isDirectory && method !== 0 && method !== 8) throw new ZipError("bad-zip", `unsupported compression method ${method}: ${name}`);

      const key = name.replace(/\/+$/, "");
      if (seen.has(key)) throw new ZipError("unsafe-zip", `duplicate entry: ${name}`);
      seen.add(key);
      total += size;
      if (total > MAX_ZIP_TOTAL_BYTES) throw new ZipError("unsafe-zip", "zip expands past the size limit");
      entries.push({ name, isDirectory, method, compressedSize, size, crc, mode: unixMode & 0o777, localHeaderOffset });
    }
    // A file may not also be used as a folder by another entry ("a" and "a/b").
    for (const e of entries) {
      if (e.isDirectory) continue;
      const prefix = `${e.name}/`;
      if (entries.some((o) => o.name.startsWith(prefix))) throw new ZipError("unsafe-zip", `entry is both a file and a folder: ${e.name}`);
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/**
 * The single top-level folder every entry sits under. Throws when there is more than one, or a file
 * at the top level — the release zip always has exactly `solidcraft-cli-<version>-macos-universal/`.
 */
export function singleTopFolder(entries: readonly ZipEntry[]): string {
  const tops = new Set<string>();
  for (const e of entries) {
    const slash = e.name.indexOf("/");
    if (slash < 0) throw new ZipError("bad-zip", `expected one top-level folder, found a file beside it: ${e.name}`);
    tops.add(e.name.slice(0, slash));
  }
  if (tops.size !== 1) throw new ZipError("bad-zip", `expected one top-level folder, found ${tops.size}`);
  return [...tops][0]!;
}

export interface ExtractOptions {
  /** Entry names (after stripping the top folder) that are never written. */
  skip?: readonly string[];
}

/**
 * Extract `file` into `destDir` with the single top-level folder stripped. `destDir` MUST be a new,
 * empty folder owned by the caller. Returns the relative paths written. Throws `ZipError`.
 */
export async function extractZip(file: string, destDir: string, opts: ExtractOptions = {}): Promise<string[]> {
  const entries = readZipEntries(file);
  const top = singleTopFolder(entries);
  const skip = new Set(opts.skip ?? []);
  const written: string[] = [];
  const fd = openSync(file, "r");
  try {
    for (const e of entries) {
      const rel = e.name.slice(top.length + 1).replace(/\/+$/, "");
      if (!rel) continue; // the top folder itself
      if (skip.has(rel)) continue;
      const out = join(destDir, rel);
      if (e.isDirectory) {
        mkdirSync(out, { recursive: true });
        continue;
      }
      mkdirSync(dirname(out), { recursive: true });
      // The local header repeats the name with its own (possibly different) extra field length.
      const loc = readAt(fd, 30, e.localHeaderOffset);
      if (loc.readUInt32LE(0) !== LOC_SIG) throw new ZipError("bad-zip", `corrupt local header: ${e.name}`);
      const locNameLen = loc.readUInt16LE(26);
      const locName = readAt(fd, locNameLen, e.localHeaderOffset + 30).toString("utf8");
      if (locName !== e.name) throw new ZipError("unsafe-zip", `local header names a different file (${locName}) than the directory (${e.name})`);
      const dataStart = e.localHeaderOffset + 30 + locNameLen + loc.readUInt16LE(28);
      const mode = e.mode & 0o111 ? 0o755 : 0o644;

      if (e.compressedSize === 0) {
        if (e.size !== 0) throw new ZipError("bad-zip", `size mismatch: ${e.name}`);
        writeFileSync(out, "", { flag: "wx", mode });
        written.push(rel);
        continue;
      }
      let crc = 0;
      let bytes = 0;
      const check = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > e.size) return cb(new ZipError("unsafe-zip", `entry expands past its declared size: ${e.name}`));
          crc = crc32(chunk, crc);
          cb(null, chunk);
        },
      });
      const src = createReadStream(file, { start: dataStart, end: dataStart + e.compressedSize - 1 });
      const sink = createWriteStream(out, { flags: "wx", mode });
      try {
        if (e.method === 8) await pipeline(src, createInflateRaw(), check, sink);
        else await pipeline(src, check, sink);
      } catch (err) {
        if (err instanceof ZipError) throw err;
        throw new ZipError("bad-zip", `could not extract ${e.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (bytes !== e.size) throw new ZipError("bad-zip", `size mismatch: ${e.name}`);
      if (crc >>> 0 !== e.crc >>> 0) throw new ZipError("bad-zip", `checksum mismatch: ${e.name}`);
      written.push(rel);
    }
  } finally {
    closeSync(fd);
  }
  return written;
}
