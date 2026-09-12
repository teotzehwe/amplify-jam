/**
 * QR encoder tests.
 *
 * The fixtures below were produced by this encoder and then confirmed to
 * decode correctly by an independent library (jsQR) — versions 1, 2, 3, 5, 7,
 * 9 and 10 all round-tripped, including UTF-8 payloads. jsQR is not a
 * dependency of this project, so what is checked in is the verified output
 * plus the structural rules of the format. If a change here breaks a fixture,
 * the symbol has changed and needs re-verifying against a real scanner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { qrMatrix } from '../public/js/qr.js';

const serialize = (grid) => grid.map((row) => row.map((c) => (c ? '#' : '.')).join('')).join('\n');
const digest = (grid) => createHash('sha256').update(serialize(grid)).digest('hex').slice(0, 16);
const versionOf = (grid) => (grid.length - 17) / 4;

test('encodes a version 1 symbol exactly as verified', () => {
  const expected = [
    '#########..#.########', '#.....#..####.#.....#', '#.###.#.#.#.#.#.###.#',
    '#.###.#.##.##.#.###.#', '#.###.#..###..#.###.#', '#.....#.##.##.#.....#',
    '#########.#.#########', '#.....#.##.##.#.....#', '##.#..##..###.#..#.##',
    '.#.##..#.#.####..#...', '##..###.##.#.....##.#', '#.##.#.....#..#####..',
    '#..####..#..#..#..#..', '#.....#.#.##..#..#..#', '#########..##..#.#...',
    '#.....#.##.....##.##.', '#.###.#..##.#####...#', '#.###.#.####..######.',
    '#.###.#.#.#.#.##.....', '#.....#...#..#.#..#.#', '#########....#..#....',
  ];
  assert.deepEqual(serialize(qrMatrix('A')).split('\n'), expected);
});

test('encodes verified symbols for real sign-up URLs', () => {
  assert.equal(digest(qrMatrix('http://192.168.1.24:3000/')), 'e73ca83d14bad566');
  assert.equal(digest(qrMatrix('https://amplifyforyouth.cc/')), '9fd18260ebfe15fd');
  assert.equal(digest(qrMatrix('x'.repeat(200))), '4b8412f98e499a89');
});

test('picks the smallest version that fits the payload', () => {
  assert.equal(versionOf(qrMatrix('A')), 1);
  assert.equal(versionOf(qrMatrix('http://192.168.1.24:3000/')), 2);
  assert.equal(versionOf(qrMatrix('x'.repeat(200))), 10);
});

test('grows through every supported version without gaps', () => {
  let previous = 0;
  for (let length = 1; length <= 210; length += 7) {
    const version = versionOf(qrMatrix('y'.repeat(length)));
    assert.ok(version >= previous, 'version must not shrink as data grows');
    assert.ok(version >= 1 && version <= 10, `version ${version} out of range`);
    previous = version;
  }
});

test('refuses payloads larger than a version 10 symbol holds', () => {
  assert.throws(() => qrMatrix('z'.repeat(300)), /Too much data/);
});

test('the symbol is square and sized to the spec', () => {
  for (const text of ['A', 'http://10.0.0.7:8080/', 'x'.repeat(120)]) {
    const grid = qrMatrix(text);
    const size = 17 + 4 * versionOf(grid);
    assert.equal(grid.length, size);
    for (const row of grid) assert.equal(row.length, size);
  }
});

test('all three finder patterns are present and correctly formed', () => {
  const grid = qrMatrix('http://192.168.1.24:3000/');
  const size = grid.length;

  const finderAt = (top, left) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (grid[top + r][left + c] !== (edge || core)) return false;
      }
    }
    return true;
  };
  assert.ok(finderAt(0, 0), 'top-left finder');
  assert.ok(finderAt(0, size - 7), 'top-right finder');
  assert.ok(finderAt(size - 7, 0), 'bottom-left finder');
});

test('timing patterns alternate, and the dark module is dark', () => {
  const grid = qrMatrix('http://192.168.1.24:3000/');
  const size = grid.length;
  for (let i = 8; i < size - 8; i++) {
    assert.equal(grid[6][i], i % 2 === 0, `horizontal timing at ${i}`);
    assert.equal(grid[i][6], i % 2 === 0, `vertical timing at ${i}`);
  }
  assert.equal(grid[size - 8][8], true, 'the module beside the bottom-left finder is always dark');
});

test('the same text always produces the same symbol', () => {
  const a = qrMatrix('http://192.168.1.24:3000/');
  const b = qrMatrix('http://192.168.1.24:3000/');
  assert.equal(serialize(a), serialize(b));
});

test('different text produces different symbols', () => {
  assert.notEqual(
    serialize(qrMatrix('http://192.168.1.24:3000/')),
    serialize(qrMatrix('http://192.168.1.25:3000/')),
  );
});

test('multi-byte characters are encoded as UTF-8 bytes', () => {
  // "café" is 5 bytes, so it must not be measured as 4 characters.
  const grid = qrMatrix('café');
  assert.equal(versionOf(grid), 1);
  assert.notEqual(serialize(grid), serialize(qrMatrix('cafe')));
});
