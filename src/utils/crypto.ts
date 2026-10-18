import * as crypto from "crypto";

export const BAIDU_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB

/**
 * Compute MD5 hash of an ArrayBuffer or Buffer
 */
export function calculateMd5(buffer: ArrayBuffer | Buffer): string {
  const hash = crypto.createHash("md5");
  if (Buffer.isBuffer(buffer)) {
    hash.update(buffer);
  } else {
    hash.update(Buffer.from(buffer));
  }
  return hash.digest("hex").toLowerCase();
}

/**
 * Split buffer into 4MB chunks and calculate block_list (array of MD5s) for Baidu Netdisk API
 */
export function calculateBlockList(buffer: ArrayBuffer | Buffer): { blockList: string[]; chunks: Buffer[] } {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const blockList: string[] = [];
  const chunks: Buffer[] = [];

  if (buf.length === 0) {
    // Empty file
    const emptyMd5 = calculateMd5(buf);
    blockList.push(emptyMd5);
    chunks.push(buf);
    return { blockList, chunks };
  }

  for (let offset = 0; offset < buf.length; offset += BAIDU_CHUNK_SIZE) {
    const end = Math.min(offset + BAIDU_CHUNK_SIZE, buf.length);
    const chunk = buf.subarray(offset, end);
    chunks.push(chunk);
    blockList.push(calculateMd5(chunk));
  }

  return { blockList, chunks };
}
