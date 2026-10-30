/**
 * Zstandard frame primitives (RFC 8878) for a concatenated-frame container.
 *
 * Implemented from the specification: a session artifact is a sequence of
 * independent, checksummed frames. No upstream source is copied here.
 */

import fs from "node:fs";
import zlib from "node:zlib";

export const ZSTD_MAGIC = 0xfd2fb528; // little-endian on disk
export const CHECKSUM_OPTIONS = {
  params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
};

/** Whether this Node exposes the synchronous Zstandard API. */
export function hasZstd() {
  return typeof zlib.zstdCompressSync === "function" && typeof zlib.zstdDecompressSync === "function";
}

/**
 * Walk the container and return the byte range of every complete frame.
 *
 * A trailing partial frame is reported as `tornStart` instead of throwing:
 * a crash during append can leave one, and callers must not treat it as
 * corruption of the frames that came before.
 */
export function scanFrames(buf, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) return { frames, tornStart: start };
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buf.length) return { frames, tornStart: start };

    const descriptor = buf.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`reserved frame-header bit set at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const hasChecksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;

    const rest = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - offset < rest) return { frames, tornStart: start };
    offset += rest;

    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (hasChecksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset, hasChecksum });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** Compress one independently decodable, checksummed frame. */
export function compressFrame(payload) {
  const frame = zlib.zstdCompressSync(payload, CHECKSUM_OPTIONS);
  if (frame.readUInt32LE(0) !== ZSTD_MAGIC) throw new Error("compressed frame has wrong magic");
  if ((frame.readUInt8(4) & 4) === 0) throw new Error("compressed frame lacks the checksum flag");
  const back = zlib.zstdDecompressSync(frame).toString("utf8");
  if (back !== payload.toString("utf8")) throw new Error("compressed frame failed roundtrip");
  return frame;
}

/** Decompress exactly one complete frame, validating its checksum. */
export function decompressFrame(slice) {
  return zlib.zstdDecompressSync(slice).toString("utf8");
}

/** Read a file into memory. */
export function readBuffer(file) {
  return fs.readFileSync(file);
}
