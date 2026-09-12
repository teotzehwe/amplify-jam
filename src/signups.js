/**
 * Sign-ups: who put their name down, and who the host is allowed to call.
 *
 * This file used to be a rotation engine that built the band itself. It does
 * not pick anybody any more — the host does that, by hand, from the list of
 * people who signed up. Automatic staffing was tried at a real jam night and
 * did not survive it: the room could not see why it chose what it chose, and a
 * host who disagreed had to fight the tool instead of running the night.
 *
 * What is left is the part that earned its place — reading sign-ups, guarding
 * consent, and counting turns so the host can see at a glance who has been
 * waiting. Everything here is pure: state in, answers out.
 *
 * The rule the whole tool exists to keep is now structural rather than
 * enforced: a lineup is built only from `signupsFor()`, so there is no code
 * path that can seat somebody who did not ask to play. See `mayPlay()`.
 */

export const STANCES = ['in', 'maybe', 'out'];
export const LEVELS = ['lead', 'comfortable', 'learning'];

/** Normalise an instrument name so "Bass " and "bass" are the same chair. */
export function normalizeInstrument(name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * A sign-up is an explicit "in" and nothing else.
 *
 * The old model had three stances and a fallback for songs a player had never
 * seen, which meant silence could be read as availability. It cannot be now:
 * anything that is not an explicit "in" is simply not a sign-up.
 */
export function isSignedUp(player, song) {
  if (!song) return false;
  return player.stances?.[song.id] === 'in';
}

/** The instrument someone signed up to play, falling back to their first. */
export function instrumentFor(player, song) {
  const asked = song ? player.picks?.[song.id] : null;
  return asked || player.instruments?.[0]?.name || '';
}

/**
 * Everyone who signed up for a song, in the order they signed the night up:
 * fewest turns first, then whoever has been waiting longest, then arrival.
 *
 * That ordering is a suggestion to the host's eye, not a decision. Nothing
 * downstream acts on it.
 */
export function signupsFor(players, song) {
  return players
    .filter((p) => !p.removed && isSignedUp(p, song))
    .map((p) => ({
      playerId: p.id,
      name: p.name,
      instrument: instrumentFor(p, song),
      present: p.present !== false,
      plays: p.stats?.plays ?? 0,
      lastRound: p.stats?.lastRound ?? null,
      streak: p.stats?.streak ?? 0,
      cap: p.limits?.maxSongs ?? null,
    }))
    .sort((a, b) =>
      a.plays - b.plays ||
      (a.lastRound ?? -1) - (b.lastRound ?? -1) ||
      a.name.localeCompare(b.name));
}

/**
 * May the host seat this person for this song?
 *
 * The only answer that matters is whether they signed up. A personal turn cap
 * or a break is reported so the host can see it, but neither is a refusal —
 * the person signed up for *this* song after setting those, and the host is
 * the one judging fairness now.
 */
export function mayPlay(player, song) {
  if (!player || player.removed) return { ok: false, why: 'not on the roster' };
  if (!isSignedUp(player, song)) return { ok: false, why: 'did not sign up for this song' };
  return { ok: true, why: '' };
}

/** Flags worth showing beside a name — never blocks, only informs. */
export function noteFor(signup, roundIndex) {
  const notes = [];
  if (!signup.present) notes.push('on a break');
  if (signup.cap != null && signup.plays >= signup.cap) notes.push(`at their cap of ${signup.cap}`);
  if (signup.lastRound != null && signup.lastRound === roundIndex - 1) notes.push('played the last song');
  if (signup.plays === 0) notes.push('not up yet tonight');
  return notes;
}

/** The chairs a jam expects to fill: the default band, unless the song overrides it. */
export function slotsForSong(song, settings) {
  const template = (song?.slots?.length ? song.slots : settings.slots) || [];
  return template
    .map((slot) => ({
      instrument: slot.instrument,
      count: Math.max(0, Math.min(12, Number(slot.count) || 0)),
    }))
    .filter((s) => s.instrument && s.count > 0);
}

/**
 * How the sign-ups line up against the band template — purely a readout for
 * the host. A song with nobody on drums is still perfectly callable; the host
 * may know the guitarist drums too, and the tool does not get a vote.
 */
export function coverageFor(signups, song, settings) {
  const counted = new Map();
  for (const s of signups) {
    const key = normalizeInstrument(s.instrument);
    counted.set(key, (counted.get(key) || 0) + 1);
  }

  const rows = slotsForSong(song, settings).map((slot) => {
    const key = normalizeInstrument(slot.instrument);
    const got = counted.get(key) || 0;
    counted.delete(key);
    return { instrument: slot.instrument, want: slot.count, got };
  });

  // Anyone who signed up on an instrument the template does not ask for still
  // belongs on the list — losing them would be worse than an untidy readout.
  for (const [key, got] of counted) {
    const label = signups.find((s) => normalizeInstrument(s.instrument) === key)?.instrument || key;
    rows.push({ instrument: label, want: 0, got });
  }
  return rows;
}

/**
 * Apply a finished song to the roster: turns counted, streaks updated. These
 * numbers exist so the host can be fair on purpose — they no longer feed any
 * automatic decision.
 */
export function commitRound(players, lineup, roundIndex) {
  const played = new Map((lineup.picks || []).map((p) => [p.playerId, p.instrument]));

  for (const player of players) {
    const instrument = played.get(player.id);
    if (instrument === undefined) {
      player.stats.streak = 0;
      continue;
    }
    const backToBack = player.stats.lastRound === roundIndex - 1;
    player.stats.plays += 1;
    player.stats.streak = backToBack ? (player.stats.streak || 0) + 1 : 1;
    player.stats.lastRound = roundIndex;
    const key = normalizeInstrument(instrument);
    if (key) player.stats.byInstrument[key] = (player.stats.byInstrument[key] || 0) + 1;
  }
}
