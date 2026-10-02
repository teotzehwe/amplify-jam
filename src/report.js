/**
 * Build a host-facing session report from the live night.
 *
 * Never includes host or player tokens — this is a shareable day-of summary,
 * not a restore backup.
 */

import { signupsFor } from './signups.js';

const fmtWhen = (ms) => {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      hour12: false,
    });
  } catch {
    return new Date(ms).toISOString();
  }
};

const instrumentList = (player) =>
  (player.instruments || [])
    .map((i) => (i.level && i.level !== 'comfortable' ? `${i.name} (${i.level})` : i.name))
    .filter(Boolean)
    .join(', ') || '—';

const playerName = (players, id) => players.find((p) => p.id === id)?.name || id || '—';

/**
 * @param {object} state live jam state (store.state)
 * @returns {{ title: string, subtitle: string, sections: { heading: string, lines: string[] }[] }}
 */
export function buildSessionReport(state) {
  const jam = state.jam || {};
  const players = (state.players || []).filter((p) => !p.removed);
  const songs = state.songs || [];
  const rounds = state.rounds || [];
  const byStatus = (status) => songs.filter((s) => s.status === status);

  const approved = byStatus('approved');
  const pending = byStatus('pending');
  const declined = byStatus('declined');
  const playedIds = new Set(rounds.map((r) => r.songId));

  const sections = [];

  sections.push({
    heading: 'Summary',
    lines: [
      `Musicians on the roster: ${players.length}`,
      `Songs on the setlist: ${approved.length}`,
      `Songs played tonight: ${rounds.length}`,
      `Requests still waiting: ${pending.length}`,
      `Requests declined: ${declined.length}`,
      `On deck now: ${state.current?.songId
        ? (songs.find((s) => s.id === state.current.songId)?.title || state.current.songId)
        : 'nothing'}`,
    ],
  });

  sections.push({
    heading: 'Roster',
    lines: players.length
      ? players
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => {
          const plays = p.stats?.plays ?? 0;
          const breakNote = p.present === false ? '; on a break' : '';
          const notes = p.notes ? `; notes: ${p.notes}` : '';
          return `${p.name} — ${instrumentList(p)}; ${plays} turn${plays === 1 ? '' : 's'}${breakNote}${notes}`;
        })
      : ['Nobody has signed up yet.'],
  });

  sections.push({
    heading: 'Songs played',
    lines: rounds.length
      ? rounds.map((r, i) => {
        const song = songs.find((s) => s.id === r.songId);
        const title = song ? [song.title, song.artist].filter(Boolean).join(' — ') : r.songId;
        const band = (r.picks || [])
          .map((pick) => `${playerName(players, pick.playerId)} (${pick.instrument})`)
          .join(', ') || 'no picks recorded';
        return `${i + 1}. ${title} · ${fmtWhen(r.playedAt)} · ${band}`;
      })
      : ['No songs marked played yet.'],
  });

  sections.push({
    heading: 'Setlist',
    lines: approved.length
      ? approved.map((song, i) => {
        const signups = signupsFor(players, song);
        const who = signups.length
          ? signups.map((s) => `${s.name} (${s.instrument}${s.present === false ? ', break' : ''})`).join(', ')
          : 'no sign-ups';
        const from = song.suggestedBy ? ` · asked by ${playerName(players, song.suggestedBy)}` : '';
        const played = playedIds.has(song.id) ? ' · played' : '';
        const key = song.key ? ` · key ${song.key}` : '';
        return `${i + 1}. ${song.title}${song.artist ? ` — ${song.artist}` : ''}${key}${from}${played} · ${who}`;
      })
      : ['The setlist is empty.'],
  });

  if (pending.length) {
    sections.push({
      heading: 'Waiting on approval',
      lines: pending.map((song) => {
        const from = song.suggestedBy ? playerName(players, song.suggestedBy) : 'unknown';
        return `${song.title}${song.artist ? ` — ${song.artist}` : ''} · asked by ${from}`;
      }),
    });
  }

  if (declined.length) {
    sections.push({
      heading: 'Declined requests',
      lines: declined.map((song) => {
        const from = song.suggestedBy ? playerName(players, song.suggestedBy) : 'unknown';
        const reason = song.declineReason ? ` · “${song.declineReason}”` : '';
        return `${song.title}${song.artist ? ` — ${song.artist}` : ''} · asked by ${from}${reason}`;
      }),
    });
  }

  return {
    title: jam.name || 'Amplify Open Jam',
    subtitle: `Session report · ${fmtWhen(Date.now())} · generated for the host`,
    sections,
  };
}
