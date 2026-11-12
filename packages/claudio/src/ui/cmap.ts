/**
 * The code points a TrueType/OpenType font maps, read from its `cmap` table. Enough of the
 * format to answer "does this font draw these icons": formats 4 (BMP) and 12 (full range).
 */
export function codePoints(font: Buffer): Set<number> {
  const out = new Set<number>();
  const tables = font.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const rec = 12 + i * 16;
    if (font.toString("latin1", rec, rec + 4) === "cmap") cmap = font.readUInt32BE(rec + 8);
  }
  if (cmap < 0) return out;
  const subtables = font.readUInt16BE(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = font.readUInt16BE(rec);
    const encoding = font.readUInt16BE(rec + 2);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const at = cmap + font.readUInt32BE(rec + 4);
    const format = font.readUInt16BE(at);
    if (format === 12) {
      const groups = font.readUInt32BE(at + 12);
      for (let g = 0; g < groups; g++) {
        const start = font.readUInt32BE(at + 16 + g * 12);
        const end = font.readUInt32BE(at + 20 + g * 12);
        for (let c = start; c <= end; c++) out.add(c);
      }
    } else if (format === 4) {
      const segs = font.readUInt16BE(at + 6) / 2;
      const ends = at + 14;
      const starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2;
      const offsets = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        const end = font.readUInt16BE(ends + s * 2);
        const start = font.readUInt16BE(starts + s * 2);
        const delta = font.readInt16BE(deltas + s * 2);
        const offAt = offsets + s * 2;
        const off = font.readUInt16BE(offAt);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          const glyph = off === 0 ? (c + delta) & 0xffff : font.readUInt16BE(offAt + off + (c - start) * 2);
          if (glyph !== 0) out.add(c);
        }
      }
    }
  }
  return out;
}
