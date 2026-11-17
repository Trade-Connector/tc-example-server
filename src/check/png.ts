// A tiny, valid PNG (1 x 1 pixel), generated rather than shipped, for the attachment check.
// TC re-checks the file's signature when the upload completes, so it must be a real PNG.

import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** A 1 x 1 PNG of one RGBA colour (default: a green pixel). */
export function tinyPng(rgba: [number, number, number, number] = [29, 157, 99, 255]): Uint8Array {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); // width
  header.writeUInt32BE(1, 4); // height
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace
  const scanline = Buffer.from([0, ...rgba]); // filter byte 0, then the pixel
  const png = Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(scanline)), chunk("IEND", Buffer.alloc(0))]);
  return new Uint8Array(png);
}
