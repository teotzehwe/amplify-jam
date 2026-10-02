/* The host console: put a song on deck, pick the band by hand, call it out. */

import {
  $, api, approvedSongs, busy, confirmButton, coverageFor, el, guard, masthead, pendingSongs,
  playedSongIds, pluralize, render, shake, signupsFor, subscribe, toast, tokens, upNext,
} from './common.js';
import { qrSvg } from './qr.js';

const app = $('#app');
const overlayRoot = $('#overlay');

let state = null;
let authed = false;
let tab = 'now';
let songQuery = '';
/** Held outside render so a live poll cannot wipe a half-typed add. */
const songDraft = { title: '', artist: '' };
let hostKeyDraft = '';
let calloutOpen = false;
let refresh = () => {};

/* -------------------------------------------------------------------- boot */

(async function boot() {
  const url = new URL(location.href);
  const fromLink = url.searchParams.get('k');
  if (fromLink) {
    tokens.host = fromLink;
    history.replaceState({}, '', '/host'); // keep the key out of the address bar
  }

  if (tokens.host) {
    authed = await api('/host/auth', { method: 'POST', body: { token: tokens.host } })
      .then(() => true)
      .catch(() => false);
  }
  refresh = subscribe((next) => {
    state = next;
    draw();
  });
})();

function draw() {
  if (!state) return;
  const active = document.activeElement;
  const focusId = active?.id || null;
  const caret = active && 'selectionStart' in active ? active.selectionStart : null;

  render(app, authed ? console_() : gate());
  render(overlayRoot, calloutOpen && state.current ? callout(state.current, { closable: true }) : null);

  // First paint gets entrance motion; subsequent live rebuilds stay still.
  if (!app.classList.contains('is-live')) {
    requestAnimationFrame(() => app.classList.add('is-live'));
  }

  if (!focusId) return;
  const restored = document.getElementById(focusId);
  if (!restored) return;
  restored.focus({ preventScroll: true });
  if (caret != null && restored.setSelectionRange) {
    try { restored.setSelectionRange(caret, caret); } catch { /* not a text field */ }
  }
}

/* -------------------------------------------------------------------- gate */

function gate() {
  const submit = guard(busy(async () => {
    const key = hostKeyDraft.trim() || $('#hostkey')?.value.trim();
    if (!key) {
      shake($('#hostkey')?.closest('.field') || $('#hostkey'));
      return toast('Paste the host key first', 'error');
    }
    await api('/host/auth', { method: 'POST', body: { token: key } });
    tokens.host = key;
    authed = true;
    refresh(true);
  }));

  return el('div', { class: 'gate stack stack--lg' },
    masthead('Amplify', 'Host console'),
    el('section', { class: 'card stack' },
      el('div', { class: 'field' },
        el('label', { for: 'hostkey' }, 'Host key'),
        el('input', {
          id: 'hostkey',
          type: 'text',
          class: 'mono',
          placeholder: 'Paste the key from the terminal',
          value: hostKeyDraft,
          onInput: (e) => { hostKeyDraft = e.target.value; },
          onKeydown: (e) => e.key === 'Enter' && submit(e),
        }),
      ),
      el('button', { class: 'btn btn--primary btn--block', onClick: submit }, 'Unlock console'),
      el('p', { class: 'section-note' },
        'The server prints this key — and a ready-made link — when it starts up.'),
    ),
  );
}

/* ------------------------------------------------------------------ shell */

const TABS = [
  ['now', 'Now'],
  ['roster', 'Roster'],
  ['songs', 'Songs'],
  ['settings', 'Settings'],
];

function console_() {
  const present = state.players.filter((p) => p.present).length;
  const waiting = pendingSongs(state).length;
  const counts = { roster: state.players.length, songs: approvedSongs(state).length };

  return el('div', { class: 'stack stack--lg' },
    masthead(state.jam.name, `${pluralize(state.roundIndex, 'song')} played · ${present} here now`,
      el('a', { class: 'btn btn--ghost btn--sm', href: '/board', target: '_blank' }, 'Stage display ↗'),
    ),

    el('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Console sections' },
      TABS.map(([id, label]) =>
        el('button', {
          role: 'tab',
          id: `tab-${id}`,
          'aria-selected': String(tab === id),
          'aria-controls': `panel-${id}`,
          // Roving tabindex: the strip is one stop, arrows move within it.
          // Announcing these as tabs without that is worse than not announcing
          // them — it promises a keyboard model that then does not work.
          tabIndex: tab === id ? 0 : -1,
          onKeydown: onTabKey,
          onClick: () => { tab = id; draw(); },
        }, label,
          counts[id] != null ? el('span', { class: 'count' }, counts[id]) : null,
          // Requests waiting on you are the one thing worth pulling attention
          // to across tabs — an unvetted song is invisible to the room.
          id === 'songs' && waiting
            ? el('span', { class: 'count count--alert' }, `${waiting} new`)
            : null,
        ),
      ),
    ),

    el('div', { role: 'tabpanel', id: `panel-${tab}`, 'aria-labelledby': `tab-${tab}` },
      tab === 'now' ? nowTab() : null,
      tab === 'roster' ? rosterTab() : null,
      tab === 'songs' ? songsTab() : null,
      tab === 'settings' ? settingsTab() : null,
    ),
  );
}

/** Arrow / Home / End across the tab strip, per the ARIA tabs pattern. */
function onTabKey(e) {
  const ids = TABS.map(([id]) => id);
  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];

  let next;
  if (step) next = ids[(ids.indexOf(tab) + step + ids.length) % ids.length];
  else if (e.key === 'Home') next = ids[0];
  else if (e.key === 'End') next = ids[ids.length - 1];
  else return;

  e.preventDefault();
  tab = next;
  draw();
  // The whole console is rebuilt on draw, so the focused button is gone by
  // now. Put focus back where the user just moved it.
  document.getElementById(`tab-${next}`)?.focus();
}

/* -------------------------------------------------------------------- now */

function nowTab() {
  return state.current ? callSheet(state.current) : songChooser();
}

const songById = (id) => state.songs.find((s) => s.id === id) || null;
const playerById = (id) => state.players.find((p) => p.id === id) || null;

const putOnDeck = (songId) => guard(busy(async () => {
  await api('/host/lineup', { method: 'POST', body: { songId } });
  tab = 'now';
  await refresh(true);
}, 'host-deck'))();

/** Song picker, with a live read on how many people have put their name down. */
function songChooser() {
  const songs = approvedSongs(state);

  if (!state.players.length) {
    return el('section', { class: 'card' },
      el('div', { class: 'empty' },
        'Nobody has signed up yet. Share the sign-up link from Settings and the roster will fill in here.'),
    );
  }

  const query = songQuery.trim().toLowerCase();
  const matches = songs.filter((s) => !query || `${s.title} ${s.artist}`.toLowerCase().includes(query));

  return el('div', { class: 'stack' },
    el('section', { class: 'card stack' },
      el('div', { class: 'card__head' },
        el('h2', {}, "What's next?"),
        el('span', { class: 'hint' }, 'You pick the band — Amplify just keeps the list'),
      ),
      songs.length > 4
        ? el('input', {
            id: 'song-filter',
            type: 'search',
            placeholder: 'Filter songs…',
            'aria-label': 'Filter the setlist by title or artist',
            value: songQuery,
            onInput: (e) => { songQuery = e.target.value; draw(); },
          })
        : null,

      songs.length
        ? el('div', { class: 'stack' }, matches.map(songChoice))
        : el('div', { class: 'empty' }, 'No songs on the setlist yet — add a few under the Songs tab.'),

      el('hr', { class: 'divider' }),
      el('button', {
        class: 'btn btn--ghost btn--block',
        onClick: () => putOnDeck(null),
      }, 'Free jam — pick a band with no song set'),
    ),
  );
}

function songChoice(song) {
  const signups = signupsFor(state, song.id);
  const here = signups.filter((s) => s.present).length;

  return el('div', { class: 'song-card song-card--plain song-card--roster' },
    el('div', { class: 'song-card__top' },
      el('div', {},
        el('div', { class: 'song-card__title' }, song.title),
        el('div', { class: 'muted small' },
          [song.artist, song.key && `key of ${song.key}`].filter(Boolean).join(' · ') || '—'),
        el('div', { class: 'readiness' },
          signups.length
            ? el('span', { class: 'tag tag--in' },
                el('i', { class: 'dot dot--in' }), `${signups.length} signed up`)
            : el('span', { class: 'tag' }, 'Nobody signed up yet'),
          signups.length && here < signups.length
            ? el('span', { class: 'tag tag--maybe' }, `${signups.length - here} on a break`)
            : null,
        ),
      ),
      el('button', { class: 'btn btn--primary', onClick: () => putOnDeck(song.id) }, 'Put on deck'),
    ),
    songRoster(song, signups),
  );
}

/** Who put their name down, grouped by instrument — skim before you pick. */
function songRoster(song, signups) {
  if (!signups.length) {
    return el('div', { class: 'song-roster song-roster--empty' },
      'Nobody on this one yet');
  }

  const key = (name) => String(name || '').trim().toLowerCase();
  const rows = coverageFor(state, song).filter((row) => row.got > 0);

  return el('div', { class: 'song-roster', role: 'list', 'aria-label': `Signed up for ${song.title}` },
    rows.map((row, i) => {
      const who = signups.filter((s) => key(s.instrument) === key(row.instrument));
      return el('div', {
        class: 'song-roster__row',
        role: 'listitem',
        style: { animationDelay: `${0.04 + i * 0.04}s` },
      },
        el('span', { class: 'song-roster__inst' }, row.instrument),
        el('span', { class: 'song-roster__who' },
          who.map((s, j) => [
            j ? el('span', { class: 'song-roster__sep' }, '·') : null,
            el('span', {
              class: `song-roster__name${s.present ? '' : ' song-roster__name--away'}`,
              title: s.present ? undefined : 'On a break',
            }, s.name),
          ]),
        ),
      );
    }),
  );
}

/* --------------------------------------------------------------- the picker */

/**
 * Who the host may pick from. For a song that is the sign-up sheet and nothing
 * else — the API refuses anyone not on it, so this list and the rule agree by
 * construction. A free jam has no sheet, so the room itself is the list.
 */
function candidatesFor(current) {
  if (current.songId) return signupsFor(state, current.songId);
  return state.players
    .filter((p) => p.present)
    .map((p) => ({
      playerId: p.id,
      name: p.name,
      instrument: p.instruments[0]?.name || '',
      present: true,
      plays: p.stats.plays,
      lastRound: p.stats.lastRound,
      cap: p.limits?.maxSongs ?? null,
    }))
    .sort((a, b) =>
      a.plays - b.plays ||
      (a.lastRound ?? -1) - (b.lastRound ?? -1) ||
      a.name.localeCompare(b.name));
}

/**
 * What the host needs to know to be fair, in the order they need it. None of
 * this stops anybody being picked — it is the information a person running the
 * room would otherwise be holding in their head.
 */
function notesFor(who) {
  const notes = [];
  if (!who.present) notes.push('on a break');
  if (who.plays === 0) notes.push('not up yet tonight');
  else notes.push(pluralize(who.plays, 'turn'));
  if (who.lastRound != null && who.lastRound === state.roundIndex - 1) notes.push('played the last song');
  if (who.cap != null && who.plays >= who.cap) notes.push(`at their cap of ${who.cap}`);
  return notes;
}

/** The song on deck: who is on it, who else put their name down. */
function callSheet(current) {
  const song = songById(current.songId);
  const candidates = candidatesFor(current);
  const seated = new Map(current.picks.map((p) => [p.playerId, p.instrument]));
  const bench = candidates.filter((c) => !seated.has(c.playerId));

  const pick = guard(busy(async (playerId, instrument) => {
    await api('/host/pick', { method: 'POST', body: { playerId, instrument } });
    await refresh(true);
  }, 'host-pick'));
  const unpick = guard(busy(async (playerId) => {
    await api('/host/unpick', { method: 'POST', body: { playerId } });
    await refresh(true);
  }, 'host-unpick'));

  return el('div', { class: 'stack' },
    el('section', { class: 'card stack' },
      el('div', { class: 'row row--between row--wrap' },
        el('div', {},
          el('div', { class: 'tiny faint', style: { letterSpacing: '0.18em', textTransform: 'uppercase' } }, 'On deck'),
          el('h2', { style: { fontSize: '1.5rem', marginTop: '2px' } }, song ? song.title : 'Free jam'),
          el('div', { class: 'muted small' },
            song ? [song.artist, song.key && `key of ${song.key}`].filter(Boolean).join(' · ') : 'No song set',
          ),
        ),
      ),

      onStage(current, song, unpick),
      coverage(song),
      benchList(bench, current, pick),

      el('div', { class: 'row row--wrap', style: { marginTop: '6px' } },
        el('button', {
          class: 'btn btn--primary btn--lg grow',
          disabled: !current.picks.length,
          onClick: () => { calloutOpen = true; draw(); },
        }, 'Call it out'),
        el('button', {
          class: 'btn btn--lg',
          disabled: !current.picks.length,
          onClick: guard(busy(async () => {
            await api('/host/commit', { method: 'POST' });
            calloutOpen = false;
            toast('Logged — turn counts updated');
            await refresh(true);
          }, 'host-commit')),
        }, 'Played ✓'),
        el('button', {
          class: 'btn btn--ghost btn--lg',
          onClick: guard(busy(async () => {
            await api('/host/skip', { method: 'POST' });
            await refresh(true);
          }, 'host-skip')),
        }, 'Cancel'),
      ),
      el('p', { class: 'section-note' },
        'Played ✓ counts a turn for everyone on stage. Cancel clears the deck without counting anything.'),
    ),
  );
}

/**
 * The band as it stands. Empty until the host starts picking — by design.
 *
 * A pick is a snapshot of a moment. Somebody can withdraw or step out after
 * being seated, and the tool does not quietly drop them — vanishing from the
 * lineup mid-selection would be its own surprise. It says so instead, so the
 * name is never called out cold.
 */
function onStage(current, song, unpick) {
  return el('div', { class: 'stack', style: { gap: '8px' } },
    el('div', { class: 'card__head' },
      el('h3', { class: 'sub-head' }, 'On stage'),
      el('span', { class: 'hint' }, pluralize(current.picks.length, 'musician')),
    ),
    current.picks.length
      ? current.picks.map((p) => {
          const player = playerById(p.playerId);
          const withdrawn = player && song && player.stances?.[song.id] !== 'in';
          const away = player && player.present === false;

          return el('div', { class: `slot${withdrawn || away ? ' slot--resting' : ''}` },
            el('div', { class: 'slot__inst' }, p.instrument || '—'),
            el('div', { class: 'slot__who' },
              el('div', { class: 'slot__name' }, player?.name || 'Unknown'),
              withdrawn
                ? el('div', { class: 'slot__why' },
                    'Withdrew from this song — take them off before you call it')
                : away
                  ? el('div', { class: 'slot__why' }, 'On a break now — check before you call it')
                  : null,
            ),
            el('button', {
              class: 'btn btn--sm btn--quiet',
              onClick: () => unpick(p.playerId),
            }, 'Take off'),
          );
        })
      : el('div', { class: 'empty' },
          'Nobody yet. Pick from the sign-ups below — tap a name to put them on.'),
  );
}

/** Sign-ups against the band template. Advice, never a gate. */
function coverage(song) {
  const rows = coverageFor(state, song);
  if (!rows.length) return null;

  return el('div', { class: 'row row--wrap', style: { gap: '6px' } },
    rows.map((row) =>
      el('span', { class: `tag${row.want && row.got < row.want ? ' tag--out' : ' tag--in'}` },
        `${row.instrument} ${row.got}${row.want ? `/${row.want}` : ''}`)),
  );
}

/** Everyone who signed up and is not on stage yet. Tap to seat them. */
function benchList(bench, current, pick) {
  const heading = el('div', { class: 'card__head' },
    el('h3', { class: 'sub-head' }, current.songId ? 'Signed up' : 'In the room'),
    el('span', { class: 'hint' }, `${bench.length} available · fewest turns first`),
  );

  if (!bench.length) {
    return el('div', { class: 'stack', style: { gap: '8px' } },
      heading,
      el('div', { class: 'empty' },
        current.songId
          ? 'Nobody else has signed up for this one. Only people who put their name down can be called.'
          : 'Everybody in the room is already on stage.'),
    );
  }

  return el('div', { class: 'stack', style: { gap: '8px' } },
    heading,
    el('div', { class: 'stack', style: { gap: '6px' } },
      bench.map((who) => {
        const player = playerById(who.playerId);
        const options = player?.instruments?.length ? player.instruments.map((i) => i.name) : [who.instrument];
        const selectId = `inst-${who.playerId}`;

        return el('div', { class: `pick-row${who.present ? '' : ' pick-row--away'}` },
          el('div', { class: 'grow' },
            el('div', { class: 'pick-row__name' }, who.name),
            el('div', { class: 'pick-row__why' }, notesFor(who).join(' · ')),
          ),
          options.length > 1
            ? el('select', {
                id: selectId,
                'aria-label': `Instrument for ${who.name}`,
                value: who.instrument,
              }, options.map((name) =>
                el('option', { value: name, selected: name === who.instrument }, name)))
            : el('span', { class: 'tag' }, who.instrument || '—'),
          el('button', {
            class: 'btn btn--primary btn--sm',
            onClick: () => pick(
              who.playerId,
              options.length > 1 ? $(`#${selectId}`)?.value : who.instrument,
            ),
          }, 'Put on'),
        );
      }),
    ),
  );
}

/* ------------------------------------------------------------------ roster */

/** Roster ordered the way a fair host would read it: longest wait at the top. */
function queueOrder(players) {
  return [...players].sort((a, b) =>
    a.stats.plays - b.stats.plays ||
    (a.stats.lastRound ?? -1) - (b.stats.lastRound ?? -1) ||
    a.joinedAt - b.joinedAt);
}

function rosterTab() {
  if (!state.players.length) {
    return el('section', { class: 'card' },
      el('div', { class: 'empty' }, 'No sign-ups yet. The link lives in Settings.'));
  }

  const maxPlays = Math.max(1, ...state.players.map((p) => p.stats.plays));
  const waiting = state.players.filter((p) => p.present && p.stats.plays === 0).length;

  return el('div', { class: 'stack' },
    el('section', { class: 'card' },
      el('div', { class: 'stat-strip' },
        el('div', { class: 'stat' }, el('b', {}, state.players.length), el('span', {}, 'Signed up')),
        el('div', { class: 'stat' },
          el('b', {}, state.players.filter((p) => p.present).length), el('span', {}, 'Here now')),
        el('div', { class: 'stat' }, el('b', {}, waiting), el('span', {}, 'Still waiting')),
        el('div', { class: 'stat' }, el('b', {}, state.roundIndex), el('span', {}, 'Songs played')),
      ),
      waiting
        ? el('div', { class: 'alert alert--info', style: { marginTop: '14px' } },
            `${pluralize(waiting, 'person', 'people')} ${waiting === 1 ? 'has' : 'have'} not played yet tonight.`)
        : null,
    ),
    el('section', { class: 'card' },
      el('div', { class: 'card__head' },
        el('h2', {}, 'Who has played what'),
        el('span', { class: 'hint' }, 'Longest wait first'),
      ),
      el('div', { class: 'roster' }, queueOrder(state.players).map((p) => personCard(p, maxPlays))),
    ),
  );
}

function personCard(person, maxPlays) {
  const signedUp = Object.values(person.stances || {}).filter((s) => s === 'in').length;
  const save = guard((patch) => api(`/players/${person.id}`, { method: 'PATCH', body: patch }));

  return el('div', { class: `person${person.present ? '' : ' person--away'}` },
    el('div', { class: 'person__top' },
      el('span', { class: `dot dot--${person.present ? 'in' : 'out'}` }),
      el('span', { class: 'person__name grow truncate' }, person.name),
      el('span', { class: 'turns' }, pluralize(person.stats.plays, 'turn')),
    ),
    el('div', { class: 'queue-bar' },
      el('i', { style: { width: `${(person.stats.plays / maxPlays) * 100}%` } })),
    el('div', { class: 'row row--wrap', style: { gap: '6px' } },
      person.instruments.map((i) =>
        el('span', { class: `tag${i.level === 'lead' ? ' tag--lead' : ''}` }, i.name)),
    ),
    el('div', { class: 'row row--wrap tiny faint', style: { gap: '10px' } },
      el('span', {}, person.stats.lastRound == null
        ? 'Not up yet tonight'
        : `Last played song ${person.stats.lastRound + 1}`),
      el('span', {}, `· signed up for ${signedUp}`),
      person.limits?.maxSongs ? el('span', {}, `· caps at ${person.limits.maxSongs}`) : null,
    ),
    person.notes ? el('div', { class: 'small muted' }, `“${person.notes}”`) : null,
    el('div', { class: 'row', style: { marginTop: '2px' } },
      el('button', {
        class: 'btn btn--sm btn--ghost',
        onClick: () => save({ present: !person.present }),
      }, person.present ? 'Mark on a break' : 'Mark back'),
      el('span', { class: 'spacer' }),
      confirmButton({
        key: `remove-player:${person.id}`,
        label: 'Remove',
        title: `Remove ${person.name} from tonight`,
        onConfirm: () => api(`/players/${person.id}`, { method: 'DELETE' }),
        onChange: draw,
      }),
    ),
  );
}

/* ------------------------------------------------------------------- songs */

function songsTab() {
  const add = guard(busy(async () => {
    const title = songDraft.title.trim();
    if (!title) {
      shake($('#s-title')?.closest('.field') || $('#s-title'));
      return toast('A title, at least', 'error');
    }
    await api('/songs', {
      method: 'POST',
      body: {
        title,
        artist: songDraft.artist.trim(),
        // Marks this as a host setlist add so it skips the request queue —
        // even if this browser also has a player session open.
        hostAdd: true,
      },
    });
    songDraft.title = '';
    songDraft.artist = '';
    toast('Added to the setlist');
    await refresh(true);
    document.getElementById('s-title')?.focus();
  }, 'host-add-song'));

  const queue = approvedSongs(state);

  return el('div', { class: 'stack' },
    requests(),

    el('section', { class: 'card stack' },
      el('div', { class: 'card__head' }, el('h2', {}, 'Add a song')),
      el('div', { class: 'row row--wrap' },
        el('input', { id: 's-title', type: 'text', placeholder: 'Title', class: 'grow',
          'aria-label': 'Song title', value: songDraft.title,
          onInput: (e) => { songDraft.title = e.target.value; },
          onKeydown: (e) => e.key === 'Enter' && add() }),
        el('input', { id: 's-artist', type: 'text', placeholder: 'Artist', class: 'grow',
          'aria-label': 'Artist', value: songDraft.artist,
          onInput: (e) => { songDraft.artist = e.target.value; },
          onKeydown: (e) => e.key === 'Enter' && add() }),
        el('button', { class: 'btn btn--primary', onClick: add }, 'Add'),
      ),
      el('p', { class: 'section-note' },
        'Anything you add here goes straight onto the setlist — you are the one doing the vetting.'),
    ),

    el('section', { class: 'card stack' },
      el('div', { class: 'card__head' },
        el('h2', {}, 'The setlist'),
        el('span', { class: 'hint' },
          `${pluralize(queue.length, 'song')} · the top one not yet played is up next`),
      ),
      queue.length
        ? el('div', { class: 'stack', style: { gap: '10px' } }, queue.map(songAdminCard))
        : el('div', { class: 'empty' }, 'Nothing here yet. Add the songs you expect to call tonight.'),
    ),
  );
}

/**
 * Song requests from the room, waiting on a yes or no.
 *
 * These sit above everything else on the tab because a request nobody has
 * looked at is invisible to the person who made it — they can see it on their
 * own phone marked pending, and nowhere else.
 */
function requests() {
  const waiting = pendingSongs(state);
  if (!waiting.length) return null;

  const approve = guard(busy(async (song) => {
    await api(`/host/songs/${song.id}/approve`, { method: 'POST' });
    toast(`“${song.title}” is on the setlist`);
    await refresh(true);
  }, 'host-approve'));

  const decline = guard(busy(async (song) => {
    const reason = window.prompt(
      `Optional note for ${song.suggestedBy ? (playerById(song.suggestedBy)?.name || 'whoever asked') : 'whoever asked'} (Cancel leaves no note)`,
      '',
    );
    // prompt Cancel → null: still decline, just without a reason.
    await api(`/host/songs/${song.id}/decline`, {
      method: 'POST',
      body: { reason: reason == null ? '' : reason },
    });
    toast('Declined — they can see it on their phone');
    await refresh(true);
  }, 'host-decline'));

  return el('section', { class: 'card stack card--alert' },
    el('div', { class: 'card__head' },
      el('h2', {}, 'Requests'),
      el('span', { class: 'hint' }, `${pluralize(waiting.length, 'song')} waiting on you`),
    ),
    el('div', { class: 'stack', style: { gap: '10px' } },
      waiting.map((song) => {
        const from = song.suggestedBy ? playerById(song.suggestedBy) : null;
        return el('div', { class: 'song-card song-card--plain' },
          el('div', {},
            el('div', { class: 'song-card__title' }, song.title),
            el('div', { class: 'muted small' },
              [song.artist, song.key && `key of ${song.key}`, from && `asked for by ${from.name}`]
                .filter(Boolean).join(' · ') || '—'),
          ),
          el('div', { class: 'row row--wrap' },
            el('button', { class: 'btn btn--primary btn--sm', onClick: () => approve(song) }, 'Approve'),
            confirmButton({
              key: `decline-song:${song.id}`,
              label: 'Decline',
              title: `Decline “${song.title}”? They will see it marked declined.`,
              onConfirm: () => decline(song),
              onChange: draw,
            }),
          ),
        );
      }),
    ),
    el('p', { class: 'section-note' },
      'Nobody can sign up for a request until you approve it. Declining leaves a note on their phone instead of vanishing.'),
  );
}

/** Rewrite the whole queue order from a moved song. */
const reorder = (songId, toIndex) => guard(busy(async () => {
  const ids = approvedSongs(state).map((s) => s.id).filter((id) => id !== songId);
  ids.splice(Math.max(0, Math.min(ids.length, toIndex)), 0, songId);
  // Pending songs are not in the queue, so they are appended untouched — the
  // server keeps anything the client left out, in its existing order.
  await api('/host/songs/order', { method: 'POST', body: { order: ids } });
  await refresh(true);
}, 'host-reorder'))();

function songAdminCard(song, index) {
  const queue = approvedSongs(state);
  const signups = signupsFor(state, song.id);
  const suggester = song.suggestedBy ? playerById(song.suggestedBy) : null;
  const played = playedSongIds(state).has(song.id);
  const onDeck = state.current?.songId === song.id;
  const isNext = upNext(state)?.id === song.id;

  return el('div', {
    class: `song-card${isNext ? ' song-card--next' : ''}${onDeck ? ' song-card--deck' : ''}${played && !onDeck ? ' song-card--played' : ''}`,
  },
    el('div', { class: 'queue-move' },
      // The glyph alone announces as "black up-pointing triangle", which says
      // neither what it does nor to which song.
      el('button', {
        class: 'btn btn--icon btn--ghost',
        title: 'Move up',
        'aria-label': `Move ${song.title} up the queue`,
        disabled: index === 0,
        onClick: () => reorder(song.id, index - 1),
      }, '▲'),
      el('button', {
        class: 'btn btn--icon btn--ghost',
        title: 'Move down',
        'aria-label': `Move ${song.title} down the queue`,
        disabled: index === queue.length - 1,
        onClick: () => reorder(song.id, index + 1),
      }, '▼'),
    ),
    el('div', {},
      el('div', { class: 'row', style: { gap: '8px' } },
        el('div', { class: 'song-card__title' }, song.title),
        onDeck ? el('span', { class: 'tag tag--out' }, 'on deck') : null,
        isNext ? el('span', { class: 'tag tag--lead' }, 'up next') : null,
        played ? el('span', { class: 'tag' }, 'played') : null,
      ),
      el('div', { class: 'muted small' },
        [song.artist, song.key && `key of ${song.key}`, suggester && `asked for by ${suggester.name}`]
          .filter(Boolean).join(' · ') || '—'),
      el('div', { class: 'readiness' },
        signups.length
          ? el('span', { class: 'tag tag--in' }, `${signups.length} signed up`)
          : el('span', { class: 'tag' }, 'Nobody signed up yet'),
      ),
    ),
    el('div', { class: 'row row--wrap' },
      index > 0
        ? el('button', {
            class: 'btn btn--sm btn--ghost',
            title: 'Jump to the front of the queue',
            onClick: () => reorder(song.id, 0),
          }, 'Play next')
        : null,
      el('button', { class: 'btn btn--sm', onClick: () => putOnDeck(song.id) }, 'On deck'),
      confirmButton({
        key: `remove-song:${song.id}`,
        label: 'Remove',
        title: `Remove “${song.title}” from the setlist`,
        onConfirm: () => api(`/songs/${song.id}`, { method: 'DELETE' }),
        onChange: draw,
      }),
    ),
  );
}

/* ---------------------------------------------------------------- settings */

function settingsTab() {
  const jam = state.jam;
  const save = guard((patch) => api('/host/settings', { method: 'PATCH', body: patch }));
  const signupUrl = `${location.origin}/`;

  const copy = (text) => async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Copy failed — select the link by hand', 'error');
    }
  };

  return el('div', { class: 'stack' },
    el('section', { class: 'card' },
      el('div', { class: 'card__head' },
        el('h2', {}, 'Share the sign-up'),
        el('span', { class: 'hint' }, 'Point a phone camera at the code'),
      ),
      el('div', { class: 'share' },
        el('div', { class: 'share__qr' }, qrSvg(signupUrl, { size: 190 })),
        el('div', { class: 'stack grow' },
          el('div', { class: 'row row--wrap' },
            el('input', { type: 'text', readOnly: true, class: 'mono grow', value: signupUrl,
              'aria-label': 'Sign-up link', onFocus: (e) => e.target.select() }),
            el('button', { class: 'btn', onClick: copy(signupUrl) }, 'Copy link'),
          ),
          el('p', { class: 'section-note' },
            'Anyone on the same wifi can scan this or type the link. The stage display shows the same code.'),
          el('button', {
            class: 'btn btn--ghost btn--sm',
            onClick: () => window.print(),
          }, 'Print a card for the stage'),
        ),
      ),
    ),

    el('section', { class: 'card stack stack--lg' },
      el('div', { class: 'card__head' }, el('h2', {}, 'The band')),
      el('p', { class: 'section-note' },
        'The chairs you usually want filled. This is a readout on the sign-up sheet, not a limit — pick whoever you like.'),
      slotEditor(jam.slots, (slots) => save({ slots })),
    ),

    el('section', { class: 'card stack stack--lg' },
      el('div', { class: 'card__head' }, el('h2', {}, 'Song requests')),
      el('label', { class: 'toggle' },
        el('input', {
          type: 'checkbox',
          checked: jam.allowSuggestions,
          onChange: (e) => save({ allowSuggestions: e.target.checked }),
        }),
        el('span', { class: 'toggle__track' }),
        el('span', { class: 'toggle__text' }, 'Let the room request songs'),
      ),
      el('label', { class: 'toggle' },
        el('input', {
          type: 'checkbox',
          checked: jam.requireApproval,
          onChange: (e) => save({ requireApproval: e.target.checked }),
        }),
        el('span', { class: 'toggle__track' }),
        el('span', { class: 'toggle__text' }, 'Approve requests before they go up',
          el('small', {},
            'On, a request waits in the Songs tab until you say yes and nobody can sign up for it. Off, it lands straight on the setlist — and anything already waiting is let through.')),
      ),
    ),

    el('section', { class: 'card stack' },
      el('div', { class: 'card__head' }, el('h2', {}, 'Jam name')),
      el('div', { class: 'row row--wrap' },
        el('input', {
          id: 'jam-name', type: 'text', class: 'grow', value: jam.name, maxLength: 60,
          'aria-label': 'Jam name',
          onChange: (e) => save({ name: e.target.value }),
        }),
      ),
    ),

    el('section', { class: 'card stack' },
      el('div', { class: 'card__head' }, el('h2', {}, 'Backup')),
      el('p', { class: 'section-note' },
        'Download the whole night (roster, songs, tokens) so you can restore if Redis hiccups or someone clears too soon.'),
      el('div', { class: 'row row--wrap' },
        el('button', {
          class: 'btn btn--primary',
          onClick: guard(busy(async () => {
            const dump = await api('/host/export');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const name = (jam.name || 'amplify-night').replace(/[^\w.-]+/g, '-').slice(0, 40);
            downloadJson(`${name}-${stamp}.json`, dump);
            sessionStorage.setItem('amplify.backupAt', String(Date.now()));
            toast('Backup downloaded');
          })),
        }, 'Download backup'),
        el('label', { class: 'btn btn--ghost', style: { cursor: 'pointer' } },
          'Restore backup…',
          el('input', {
            type: 'file',
            accept: 'application/json,.json',
            style: { display: 'none' },
            onChange: guard(async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              let dump;
              try {
                dump = JSON.parse(await file.text());
              } catch {
                return toast('That file is not valid JSON', 'error');
              }
              if (!confirm(`Replace the live night with “${dump.night?.jam?.name || dump.jam?.name || 'this backup'}”? Everyone’s current sheet will change.`)) {
                return;
              }
              await api('/host/import', { method: 'POST', body: dump });
              toast('Night restored');
              refresh(true);
            }),
          }),
        ),
      ),
    ),

    el('section', { class: 'card stack' },
      el('div', { class: 'card__head' }, el('h2', {}, 'Start over')),
      el('p', { class: 'section-note' },
        'Clearing the night needs a fresh backup download first — there is no undo.'),
      el('div', { class: 'row row--wrap' },
        confirmButton({
          key: 'reset-turns',
          label: 'Reset turn counts',
          class: 'btn btn--danger',
          confirmClass: 'btn btn--danger',
          title: 'Reset turn counts? The roster and setlist stay.',
          onConfirm: async () => {
            await api('/host/reset', { method: 'POST', body: { mode: 'turns' } });
            toast('Turns reset');
          },
          onChange: draw,
        }),
        confirmButton({
          key: 'clear-night',
          label: 'Clear the night',
          class: 'btn btn--danger',
          confirmClass: 'btn btn--danger',
          title: 'Clear the whole night — every sign-up and song?',
          onConfirm: async () => {
            const backedUpAt = Number(sessionStorage.getItem('amplify.backupAt') || 0);
            if (!backedUpAt || Date.now() - backedUpAt > 15 * 60 * 1000) {
              const dump = await api('/host/export');
              const stamp = new Date().toISOString().replace(/[:.]/g, '-');
              const name = (jam.name || 'amplify-night').replace(/[^\w.-]+/g, '-').slice(0, 40);
              downloadJson(`${name}-${stamp}.json`, dump);
              sessionStorage.setItem('amplify.backupAt', String(Date.now()));
              toast('Backup downloaded — tap Clear again to wipe the night');
              return;
            }
            await api('/host/reset', { method: 'POST', body: { mode: 'night', confirmBackup: true } });
            sessionStorage.removeItem('amplify.backupAt');
            toast('Fresh night');
          },
          onChange: draw,
        }),
      ),
    ),
  );
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Add, remove and re-count the chairs in the band. */
function slotEditor(slots, onSave) {
  const rows = slots.map((slot, i) =>
    el('div', { class: 'row' },
      el('input', {
        type: 'text', value: slot.instrument, class: 'grow',
        'aria-label': `Instrument for chair ${i + 1}`,
        onChange: (e) => {
          const next = slots.map((s, j) => (j === i ? { ...s, instrument: e.target.value } : s));
          onSave(next);
        },
      }),
      el('input', {
        type: 'number', min: '0', max: '12', value: slot.count, style: { maxWidth: '92px' },
        'aria-label': `How many on ${slot.instrument}`,
        onChange: (e) => {
          const next = slots.map((s, j) => (j === i ? { ...s, count: Number(e.target.value) } : s));
          onSave(next);
        },
      }),
      el('button', {
        class: 'btn btn--icon btn--ghost',
        title: `Remove ${slot.instrument}`,
        'aria-label': `Remove the ${slot.instrument} chair`,
        onClick: () => onSave(slots.filter((_, j) => j !== i)),
      }, '×'),
    ),
  );

  return el('div', { class: 'stack' },
    ...rows,
    el('button', {
      class: 'btn btn--sm btn--ghost',
      onClick: () => onSave([...slots, { instrument: 'Percussion', count: 1 }]),
    }, '+ Add a chair'),
  );
}

/* ----------------------------------------------------------------- callout */

/**
 * The full-screen call sheet — big enough to read from behind a drum kit.
 * Shared shape with the /board stage display.
 */
function callout(current, { closable = false, songs = state.songs, players = state.players } = {}) {
  const song = songs.find((s) => s.id === current.songId) || null;
  const name = (id) => players.find((p) => p.id === id)?.name || 'open';

  const view = el('div', { class: `callout${closable ? ' callout--overlay' : ' callout--inline'}` },
    el('div', { class: 'callout__head' },
      el('div', { class: 'callout__kicker' }, 'Up next'),
      el('div', { class: 'callout__song' }, song ? song.title : 'Free jam'),
      song && (song.artist || song.key)
        ? el('div', { class: 'callout__meta' },
            [song.artist, song.key && `key of ${song.key}`].filter(Boolean).join(' · '))
        : null,
    ),
    el('div', { class: `callout__grid${current.picks.length > 5 ? ' callout__grid--split' : ''}` },
      current.picks.map((p) =>
        el('div', { class: 'callout__row' },
          el('div', { class: 'callout__inst' }, p.instrument || '—'),
          el('div', { class: 'callout__name' }, name(p.playerId)),
        ),
      ),
    ),
    el('div', { class: 'callout__foot' },
      el('span', {}, `${pluralize(state?.roundIndex ?? 0, 'song')} played`),
      el('span', {}, `${current.picks.length} on stage`),
    ),
  );

  if (!closable) return view;

  return el('div', {},
    view,
    el('div', { class: 'callout__close row' },
      el('button', {
        class: 'btn btn--primary',
        onClick: guard(async () => {
          await api('/host/commit', { method: 'POST' });
          calloutOpen = false;
          toast('Logged');
        }),
      }, 'Played ✓'),
      el('button', {
        class: 'btn',
        onClick: () => { calloutOpen = false; draw(); },
      }, 'Close'),
    ),
  );
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && calloutOpen) {
    calloutOpen = false;
    draw();
  }
});
