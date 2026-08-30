/**
 * CRC-32, the one the zip format wants (IEEE 802.3 polynomial, reflected).
 *
 * Here rather than from a package for the reason in zip.mjs: this file is
 * twenty lines and a dependency is a supply chain. The table is built once
 * on first use rather than shipped as a literal, because a 256-entry array
 * of magic numbers is unreviewable and this is not.
 */

let TABLE = null;

function table() {
  if (TABLE) return TABLE;
  TABLE = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    TABLE[i] = c;
  }
  return TABLE;
}

export function crc32(buf) {
  const t = table();
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}
