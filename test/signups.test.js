/**
 * The sign-up reader, directly.
 *
 * The suite this replaced tested a rotation engine that chose the band. That
 * engine is gone — the host chooses now — so what is left to prove is smaller
 * and blunter: that a sign-up is an explicit act, that nothing reads silence
 * as consent, and that the turn counts the host judges fairness by are right.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  coverageFor, commitRound, instrumentFor, isSignedUp, mayPlay, noteFor, signupsFor, slotsForSong,
} from '../src/signups.js';

/* ------------------------------------------------------------------ fixtures */

let seq = 0;
function player(name, instruments, extra = {}) {
  return {
    id: `u${++seq}`,
    name,
    joinedAt: seq,
    present: true,
    removed: false,
    instruments: instruments.map((n) => (typeof n === 'string' ? { name: n, level: 'comfortable' } : n)),
    stances: {},
    picks: {},
    limits: {},
    notes: '',
    ...extra,
    stats: { plays: 0, lastRound: null, streak: 0, byInstrument: {}, ...(extra.stats || {}) },
  };
}

const song = (id = 's1', extra = {}) => ({ id, title: `Song ${id}`, status: 'approved', slots: null, ...extra });

const settings = {
  slots: [
    { instrument: 'Vocals', count: 1 },
    { instrument: 'Guitar', count: 2 },
    { instrument: 'Bass', count: 1 },
  ],
};

/* -------------------------------------------------------------- signing up */

test('a sign-up is an explicit "in" and nothing else', () => {
  const s = song();
  assert.equal(isSignedUp(player('In', ['Bass'], { stances: { s1: 'in' } }), s), true);
  assert.equal(isSignedUp(player('Maybe', ['Bass'], { stances: { s1: 'maybe' } }), s), false);
  assert.equal(isSignedUp(player('Out', ['Bass'], { stances: { s1: 'out' } }), s), false);
  assert.equal(isSignedUp(player('Silent', ['Bass']), s), false, 'silence is not a sign-up');
  assert.equal(isSignedUp(player('Other', ['Bass'], { stances: { s2: 'in' } }), s), false);
});

test('the instrument is the one they signed up with, else their first', () => {
  const s = song();
  const asked = player('Asked', ['Guitar', 'Keys'], { picks: { s1: 'Keys' } });
  const quiet = player('Quiet', ['Drums', 'Guitar']);
  assert.equal(instrumentFor(asked, s), 'Keys');
  assert.equal(instrumentFor(quiet, s), 'Drums');
});

test('the sheet lists only sign-ups, and drops people who left', () => {
  const s = song();
  const players = [
    player('In', ['Bass'], { stances: { s1: 'in' } }),
    player('Silent', ['Bass']),
    player('Gone', ['Bass'], { stances: { s1: 'in' }, removed: true }),
  ];

  const sheet = signupsFor(players, s);
  assert.deepEqual(sheet.map((x) => x.name), ['In']);
});

test('the sheet leads with whoever has waited longest', () => {
  const s = song();
  const players = [
    player('Played twice', ['Guitar'], { stances: { s1: 'in' }, stats: { plays: 2, lastRound: 5 } }),
    player('Fresh', ['Guitar'], { stances: { s1: 'in' } }),
    player('Played once, long ago', ['Guitar'], { stances: { s1: 'in' }, stats: { plays: 1, lastRound: 1 } }),
    player('Played once, just now', ['Guitar'], { stances: { s1: 'in' }, stats: { plays: 1, lastRound: 4 } }),
  ];

  assert.deepEqual(
    signupsFor(players, s).map((x) => x.name),
    ['Fresh', 'Played once, long ago', 'Played once, just now', 'Played twice'],
  );
});

test('a break does not remove you from the sheet, only flags you', () => {
  const s = song();
  const away = player('Away', ['Bass'], { stances: { s1: 'in' }, present: false });
  const [entry] = signupsFor([away], s);

  assert.equal(entry.name, 'Away');
  assert.equal(entry.present, false);
  assert.ok(noteFor(entry, 0).includes('on a break'));
});

/* ------------------------------------------------------------------ consent */

test('somebody who did not sign up can never be picked', () => {
  const s = song();
  for (const stance of [undefined, 'maybe', 'out']) {
    const p = player('Nope', ['Drums'], { stances: stance ? { s1: stance } : {} });
    const verdict = mayPlay(p, s);
    assert.equal(verdict.ok, false, `stance "${stance}" must not count as a sign-up`);
    assert.match(verdict.why, /did not sign up/);
  }
});

test('signing up is the only thing that unlocks a pick', () => {
  const s = song();
  const p = player('Yes', ['Drums'], { stances: { s1: 'in' } });
  assert.equal(mayPlay(p, s).ok, true);
});

test('a personal cap and a break inform the host, they do not block', () => {
  const s = song();
  const capped = player('Capped', ['Guitar'], {
    stances: { s1: 'in' },
    limits: { maxSongs: 2 },
    present: false,
    stats: { plays: 2, lastRound: 3 },
  });

  // Still allowed — they signed up for this song after setting that cap, and
  // the host is the one weighing it now.
  assert.equal(mayPlay(capped, s).ok, true);

  const notes = noteFor(signupsFor([capped], s)[0], 4);
  assert.ok(notes.includes('at their cap of 2'));
  assert.ok(notes.includes('on a break'));
  assert.ok(notes.includes('played the last song'));
});

test('someone who left the roster is refused even with a sign-up on file', () => {
  const s = song();
  const gone = player('Gone', ['Bass'], { stances: { s1: 'in' }, removed: true });
  assert.equal(mayPlay(gone, s).ok, false);
  assert.equal(mayPlay(null, s).ok, false);
});

/* ----------------------------------------------------------------- coverage */

test('coverage counts sign-ups against the band, in the band’s own order', () => {
  const s = song();
  const players = [
    player('V', ['Vocals'], { stances: { s1: 'in' }, picks: { s1: 'Vocals' } }),
    player('G1', ['Guitar'], { stances: { s1: 'in' }, picks: { s1: 'Guitar' } }),
    player('G2', ['Guitar'], { stances: { s1: 'in' }, picks: { s1: 'Guitar' } }),
  ];

  assert.deepEqual(coverageFor(signupsFor(players, s), s, settings), [
    { instrument: 'Vocals', want: 1, got: 1 },
    { instrument: 'Guitar', want: 2, got: 2 },
    { instrument: 'Bass', want: 1, got: 0 },
  ]);
});

test('somebody on an instrument the band does not list is still counted', () => {
  const s = song();
  const players = [player('Sax', ['Sax'], { stances: { s1: 'in' }, picks: { s1: 'Sax' } })];
  const rows = coverageFor(signupsFor(players, s), s, settings);

  assert.deepEqual(rows.at(-1), { instrument: 'Sax', want: 0, got: 1 });
});

test('instrument names match regardless of case or stray spaces', () => {
  const s = song();
  const players = [player('B', ['bass '], { stances: { s1: 'in' }, picks: { s1: 'bass ' } })];
  const rows = coverageFor(signupsFor(players, s), s, settings);

  assert.equal(rows.find((r) => r.instrument === 'Bass').got, 1);
  assert.equal(rows.length, 3, 'no phantom extra row for the same instrument');
});

test('a song can override the band template', () => {
  const custom = song('s2', { slots: [{ instrument: 'Drums', count: 1 }] });
  assert.deepEqual(slotsForSong(custom, settings), [{ instrument: 'Drums', count: 1 }]);
  assert.equal(slotsForSong(song(), settings).length, 3);
});

/* -------------------------------------------------------------- turn counts */

test('committing a song advances turns, streaks and per-instrument tallies', () => {
  const a = player('A', ['Guitar']);
  const b = player('B', ['Bass']);
  const players = [a, b];

  commitRound(players, { picks: [{ playerId: a.id, instrument: 'Guitar' }] }, 0);

  assert.equal(a.stats.plays, 1);
  assert.equal(a.stats.lastRound, 0);
  assert.equal(a.stats.streak, 1);
  assert.equal(a.stats.byInstrument.guitar, 1);
  assert.equal(b.stats.plays, 0, 'nobody off stage gains a turn');
});

test('back-to-back songs raise the streak, a gap resets it', () => {
  const p = player('Busy', ['Keys']);
  const on = { picks: [{ playerId: p.id, instrument: 'Keys' }] };

  commitRound([p], on, 0);
  commitRound([p], on, 1);
  assert.equal(p.stats.streak, 2);

  commitRound([p], { picks: [] }, 2); // sat one out
  assert.equal(p.stats.streak, 0);

  commitRound([p], on, 3);
  assert.equal(p.stats.streak, 1, 'a fresh run, not a continuation');
  assert.equal(p.stats.plays, 3);
});

test('an empty lineup commits nothing', () => {
  const p = player('Nobody', ['Guitar'], { stats: { plays: 4, streak: 2, lastRound: 3 } });
  commitRound([p], { picks: [] }, 4);
  assert.equal(p.stats.plays, 4);
  assert.equal(p.stats.streak, 0);
});
