/**
 * Unit tests for the host session report (shareable PDF, no tokens).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPdf, pdfText } from '../src/pdf.js';
import { buildSessionReport } from '../src/report.js';

const baseState = () => ({
  jam: { name: 'Friday Open Jam' },
  players: [
    {
      id: 'p1',
      name: 'Ada',
      instruments: [{ name: 'Bass', level: 'comfortable' }],
      stats: { plays: 2 },
      present: true,
      notes: 'brings amp',
      stances: { s1: 'in' },
      picks: { s1: 'Bass' },
      token: 'secret-player-token',
    },
    {
      id: 'p2',
      name: 'Bo',
      instruments: [{ name: 'Drums', level: 'learning' }],
      stats: { plays: 0 },
      present: false,
      stances: {},
      picks: {},
      token: 'other-secret',
    },
  ],
  songs: [
    {
      id: 's1',
      title: 'Midnight',
      artist: 'The Band',
      key: 'G',
      status: 'approved',
      suggestedBy: 'p1',
    },
    {
      id: 's2',
      title: 'Waiting Song',
      status: 'pending',
      suggestedBy: 'p2',
    },
    {
      id: 's3',
      title: 'Nope',
      status: 'declined',
      suggestedBy: 'p2',
      declineReason: 'Too slow for tonight',
    },
  ],
  rounds: [
    {
      index: 0,
      songId: 's1',
      playedAt: Date.UTC(2026, 9, 2, 20, 15),
      picks: [{ playerId: 'p1', instrument: 'Bass' }],
    },
  ],
  current: { songId: 's1', picks: [] },
  hostToken: 'host-secret-must-not-appear',
});

test('pdfText strips accents and escapes PDF specials', () => {
  assert.equal(pdfText('café'), 'cafe');
  assert.equal(pdfText('a (b) \\ c'), 'a \\(b\\) \\\\ c');
  assert.equal(pdfText('日本語'), '???');
});

test('buildSessionReport summarises the night without tokens', () => {
  const report = buildSessionReport(baseState());
  assert.equal(report.title, 'Friday Open Jam');
  assert.match(report.subtitle, /Session report/);

  const headings = report.sections.map((s) => s.heading);
  assert.deepEqual(headings, [
    'Summary',
    'Roster',
    'Songs played',
    'Setlist',
    'Waiting on approval',
    'Declined requests',
  ]);

  const blob = JSON.stringify(report);
  assert.ok(!blob.includes('secret-player-token'));
  assert.ok(!blob.includes('other-secret'));
  assert.ok(!blob.includes('host-secret'));

  const roster = report.sections.find((s) => s.heading === 'Roster').lines.join('\n');
  assert.match(roster, /Ada — Bass; 2 turns; notes: brings amp/);
  assert.match(roster, /Bo — Drums \(learning\); 0 turns; on a break/);

  const played = report.sections.find((s) => s.heading === 'Songs played').lines[0];
  assert.match(played, /Midnight — The Band/);
  assert.match(played, /Ada \(Bass\)/);

  const setlist = report.sections.find((s) => s.heading === 'Setlist').lines[0];
  assert.match(setlist, /key G/);
  assert.match(setlist, /asked by Ada/);
  assert.match(setlist, /Ada \(Bass\)/);

  const declined = report.sections.find((s) => s.heading === 'Declined requests').lines[0];
  assert.match(declined, /Too slow for tonight/);
});

test('buildPdf emits a multi-page PDF that starts with %PDF', () => {
  const report = buildSessionReport(baseState());
  // Pad enough lines that pagination kicks in.
  report.sections.push({
    heading: 'Notes',
    lines: Array.from({ length: 80 }, (_, i) => `Line ${i + 1}: filler for page break`),
  });
  const pdf = buildPdf(report);
  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.toString('utf8', 0, 8).startsWith('%PDF-1.'));
  assert.ok(pdf.toString('utf8').includes('%%EOF'));
  assert.ok(pdf.toString('utf8').includes('/Type /Pages'));
  assert.match(pdf.toString('utf8'), /\/Count [2-9]/, 'long report should span more than one page');
});
