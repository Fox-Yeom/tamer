// A GIF's frames as pictures (STA-24, #108): the menu bar's party lead plays its cached sprite (PokéAPI's GIF, kept
// on this Mac only — POL-ASSET-01), and Electron's nativeImage gives only a GIF's first frame. A small decoder, no
// package: the blocks, LZW, each frame drawn over the last as the GIF says (transparency, disposal, interlace).
// decode(buffer) → { width, height, frames: [{ rgba: Uint8Array (width × height × 4), delay: ms }] }

// the image data: LZW codes → colour indexes (count of them at most)
function lzw(data, minSize, count) {
  const clear = 1 << minSize, eoi = clear + 1, out = new Uint8Array(count);
  const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; }
  let size = minSize + 1, mask = (1 << size) - 1, avail = eoi + 1, old = -1, firstChar = 0, n = 0, bits = 0, acc = 0, p = 0;
  while (n < count) {
    while (bits < size) { if (p >= data.length) return out; acc |= data[p++] << bits; bits += 8; }
    const code = acc & mask;
    acc >>>= size; bits -= size;
    if (code === clear) { size = minSize + 1; mask = (1 << size) - 1; avail = eoi + 1; old = -1; continue; }
    if (code === eoi) break;
    if (old === -1) { if (code < clear) { out[n++] = code; old = code; firstChar = code; } continue; }
    let c = code, top = 0;
    if (code >= avail) { stack[top++] = firstChar; c = old; } // the entry being made right now
    while (c > eoi) { stack[top++] = suffix[c]; c = prefix[c]; }
    firstChar = suffix[c]; stack[top++] = firstChar;
    if (avail < 4096) { prefix[avail] = old; suffix[avail] = firstChar; avail++; if ((avail & mask) === 0 && avail < 4096) { size++; mask = (1 << size) - 1; } }
    old = code;
    while (top > 0 && n < count) out[n++] = stack[--top];
  }
  return out;
}

function decode(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const sig = String.fromCharCode(...b.subarray(0, 6));
  if (sig !== "GIF87a" && sig !== "GIF89a") throw new Error("not a GIF");
  const u16 = (i) => b[i] | (b[i + 1] << 8);
  const width = u16(6), height = u16(8), packed = b[10];
  let p = 13, gct = null;
  if (packed & 0x80) { const n = 3 * (1 << ((packed & 7) + 1)); gct = b.subarray(p, p + n); p += n; }
  const canvas = new Uint8Array(width * height * 4), frames = [];
  let gce = { disposal: 0, delay: 0, transparent: -1 };
  const blocks = () => { const parts = []; let size; while ((size = b[p++])) { parts.push(b.subarray(p, p + size)); p += size; } return parts; };
  while (p < b.length) {
    const kind = b[p++];
    if (kind === 0x3b) break; // trailer
    if (kind === 0x21) { // an extension
      const label = b[p++];
      if (label === 0xf9 && b[p] === 4) { const f = b[p + 1]; gce = { disposal: (f >> 2) & 7, delay: u16(p + 2) * 10, transparent: f & 1 ? b[p + 4] : -1 }; p += 5; blocks(); }
      else blocks();
      continue;
    }
    if (kind !== 0x2c) break; // not an image: the rest can't be read
    const left = u16(p), top = u16(p + 2), w = u16(p + 4), h = u16(p + 6), ip = b[p + 8];
    p += 9;
    let table = gct;
    if (ip & 0x80) { const n = 3 * (1 << ((ip & 7) + 1)); table = b.subarray(p, p + n); p += n; }
    const minSize = b[p++], parts = blocks();
    const data = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
    let o = 0; for (const x of parts) { data.set(x, o); o += x.length; }
    const idx = lzw(data, minSize, w * h);
    // interlaced rows come 0, 8, 16 … / 4, 12 … / 2, 6 … / 1, 3 …
    const rows = [];
    if (ip & 0x40) for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < h; y += step) rows.push(y);
    else for (let y = 0; y < h; y++) rows.push(y);
    const before = gce.disposal === 3 ? canvas.slice() : null;
    for (let r = 0; r < h; r++) {
      const y = top + rows[r];
      if (y >= height) continue;
      for (let x = 0; x < w; x++) {
        const ci = idx[r * w + x];
        if (ci === gce.transparent || !table || ci * 3 + 2 >= table.length || left + x >= width) continue;
        const d = (y * width + left + x) * 4;
        canvas[d] = table[ci * 3]; canvas[d + 1] = table[ci * 3 + 1]; canvas[d + 2] = table[ci * 3 + 2]; canvas[d + 3] = 255;
      }
    }
    frames.push({ rgba: canvas.slice(), delay: gce.delay > 10 ? gce.delay : 100 }); // 0 / 10 ms: shown at 100 ms, as browsers do
    if (gce.disposal === 2) for (let y = top; y < Math.min(height, top + h); y++) canvas.fill(0, (y * width + left) * 4, (y * width + Math.min(width, left + w)) * 4);
    else if (before) canvas.set(before);
    gce = { disposal: 0, delay: 0, transparent: -1 };
  }
  return { width, height, frames };
}

module.exports = { decode };
