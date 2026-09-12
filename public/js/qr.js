/**
 * A small QR encoder — byte mode, error-correction level M, versions 1–10.
 *
 * Amplify ships no dependencies and has to work with the venue's wifi down,
 * so the sign-up code is generated here rather than fetched from a service.
 * Ten versions is plenty: level M at version 10 holds 213 bytes, and the
 * longest URL this ever encodes is something like
 * "http://192.168.1.24:8080/".
 *
 * Verified against an independent decoder — see test/qr.test.js.
 */

/* ------------------------------------------------------------ code tables */

// version: [ec codewords per block, [[block count, data codewords per block], ...]]
const EC_BLOCKS = {
  1: [10, [[1, 16]]],
  2: [16, [[1, 28]]],
  3: [26, [[1, 44]]],
  4: [18, [[2, 32]]],
  5: [24, [[2, 43]]],
  6: [16, [[4, 27]]],
  7: [18, [[4, 31]]],
  8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
};

const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// Pre-computed BCH version info, only needed from version 7 up.
const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

const capacityOf = (version) =>
  EC_BLOCKS[version][1].reduce((sum, [count, data]) => sum + count * data, 0);

/* --------------------------------------------------------- GF(256) maths */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed-Solomon generator polynomial of the given degree. */
function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** The EC codewords for one block of data. */
function ecCodewords(data, count) {
  const gen = generatorPoly(count);
  const rem = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < count; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

/* ------------------------------------------------------------- bit stream */

/**
 * Mode indicator, length, payload, terminator and padding — then split into
 * blocks, add error correction, and interleave the way the spec requires.
 */
function encodeData(bytes, version) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16); // length field widens at v10

  for (const b of bytes) push(b, 8);

  const capacity = capacityOf(version) * 8;
  push(0, Math.min(4, capacity - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  }
  for (let i = 0; codewords.length < capacityOf(version); i++) {
    codewords.push(i % 2 === 0 ? 0xec : 0x11); // the specified pad bytes
  }

  // Split into blocks and give each its own error correction.
  const [ecPerBlock, groups] = EC_BLOCKS[version];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const block = codewords.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(ecCodewords(block, ecPerBlock));
    }
  }

  // Interleave: one codeword from each block in turn.
  const out = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
}

/* ---------------------------------------------------------------- matrix */

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Finder squares, separators, timing lines, alignment blocks, dark module. */
function drawFunctionPatterns(size, version, set) {
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(rr, cc, edge || core, true);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0, true);
    set(i, 6, i % 2 === 0, true);
  }

  const centers = ALIGNMENT[version];
  for (const r of centers) {
    for (const c of centers) {
      // Skip the three that would sit on top of a finder.
      const onFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1, true);
        }
      }
    }
  }

  set(size - 8, 8, true, true); // the always-dark module

  // Reserve the format areas; real values are written after masking.
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      set(8, i, false, true);
      set(i, 8, false, true);
    }
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, false, true);
    if (i < 7) set(size - 1 - i, 8, false, true);
  }

  if (version >= 7) {
    const info = VERSION_INFO[version];
    for (let i = 0; i < 18; i++) {
      const bit = ((info >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      set(b, a, bit, true);
      set(a, b, bit, true);
    }
  }
}

/** Zigzag the data codewords up and down the two-module-wide columns. */
function placeData(size, codewords, isFunction, setModule) {
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // column 6 is the timing line
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (isFunction(row, col)) continue;
        const byte = codewords[bitIndex >> 3];
        const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
        setModule(row, col, bit === 1);
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

/** The four penalty rules; lower is a more scannable symbol. */
function penalty(grid, size) {
  let score = 0;

  const runScore = (line) => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  };
  for (let r = 0; r < size; r++) runScore(grid[r]);
  for (let c = 0; c < size; c++) runScore(grid.map((row) => row[c]));

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }

  const finderish = [true, false, true, true, true, false, true, false, false, false, false];
  const hasPattern = (line, at) => {
    for (let i = 0; i < 11; i++) if (line[at + i] !== finderish[i]) return false;
    return true;
  };
  for (let r = 0; r < size; r++) {
    const row = grid[r];
    const col = grid.map((x) => x[r]);
    for (let c = 0; c + 11 <= size; c++) {
      if (hasPattern(row, c)) score += 40;
      if (hasPattern(col, c)) score += 40;
      // The pattern also counts when it reads the other way round.
      if (hasPattern([...row.slice(c, c + 11)].reverse(), 0)) score += 40;
      if (hasPattern([...col.slice(c, c + 11)].reverse(), 0)) score += 40;
    }
  }

  const dark = grid.flat().filter(Boolean).length;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/** BCH-protected format info for level M and the chosen mask. */
function formatBits(mask) {
  const data = (0b00 << 3) | mask; // 00 = error correction level M
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

/* ------------------------------------------------------------------ public */

/**
 * Encode text as a QR symbol.
 * @returns {boolean[][]} square grid, true = dark module
 */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];

  const version = Number(
    Object.keys(EC_BLOCKS).find((v) => {
      const headerBytes = Number(v) < 10 ? 2 : 3; // mode + length field
      return bytes.length + headerBytes <= capacityOf(Number(v));
    }),
  );
  if (!version) throw new Error('Too much data for a version 10 QR code');

  const size = 17 + 4 * version;
  const base = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));

  drawFunctionPatterns(size, version, (r, c, on, isFn) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    base[r][c] = on;
    fixed[r][c] = isFn;
  });

  const codewords = encodeData(bytes, version);
  placeData(size, codewords, (r, c) => fixed[r][c], (r, c, on) => { base[r][c] = on; });

  // Try every mask, keep the least penalised.
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = base.map((row, r) =>
      row.map((cell, c) => (fixed[r][c] ? cell : cell !== MASKS[mask](r, c))),
    );

    const bits = formatBits(mask);
    for (let i = 0; i < 15; i++) {
      const on = ((bits >> i) & 1) === 1;
      if (i < 6) grid[8][i] = on;
      else if (i === 6) grid[8][7] = on;
      else if (i === 7) grid[8][8] = on;
      else if (i === 8) grid[7][8] = on;
      else grid[14 - i][8] = on;

      if (i < 8) grid[8][size - 1 - i] = on;
      else grid[size - 15 + i][8] = on;
    }
    grid[size - 8][8] = true; // dark module survives the format write

    const score = penalty(grid, size);
    if (!best || score < best.score) best = { grid, score };
  }
  return best.grid;
}

/**
 * Render text as a crisp SVG QR code. One path for every dark module keeps it
 * sharp at any size and adds the quiet zone scanners need.
 */
export function qrSvg(text, { size = 160, quiet = 4, dark = '#0b0909', light = '#ffffff' } = {}) {
  const grid = qrMatrix(text);
  const n = grid.length;
  const span = n + quiet * 2;

  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${span} ${span}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `QR code for ${text}`);
  svg.innerHTML =
    `<rect width="${span}" height="${span}" fill="${light}"/><path d="${path}" fill="${dark}"/>`;
  return svg;
}
