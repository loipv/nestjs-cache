const SLOTS = 16384;

const TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let byte = 0; byte < 256; byte += 1) {
    let crc = byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    table.push(crc);
  }
  return table;
})();

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc = ((crc << 8) & 0xffff) ^ (TABLE[((crc >> 8) ^ byte) & 0xff] ?? 0);
  }
  return crc;
}

/**
 * Redis Cluster hash slot of `key`: CRC16-XMODEM of its UTF-8 bytes (or of the first non-empty
 * `{...}` hash tag) mod 16384.
 */
export function keySlot(key: string): number {
  const bytes = Buffer.from(key, 'utf8');
  const open = bytes.indexOf(0x7b);
  if (open !== -1) {
    const close = bytes.indexOf(0x7d, open + 1);
    if (close > open + 1) return crc16(bytes.subarray(open + 1, close)) % SLOTS;
  }
  return crc16(bytes) % SLOTS;
}
