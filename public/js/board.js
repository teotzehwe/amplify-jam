/* Read-only stage display. Point a TV or a spare laptop at /board. */

import { $, coverageFor, el, pluralize, render, signupsFor, subscribe, upNext } from './common.js';
import { qrSvg } from './qr.js';

const app = $('#app');

subscribe((state) => render(app, board(state)));

/**
 * One layout in every state, so the screen never jumps around mid-set: the
 * sign-up code stays put on the left, Now and Next sit beside it, and the wide
 * space underneath belongs to whichever list matters most right now.
 *
 * That list is the point of the screen. People sign up on their phones and
 * then want to know it landed — seeing their own name up there is the answer,
 * and it is also what the host reads off when picking the band.
 */
function board(state) {
  const current = state.current;
  const onDeck = current ? state.songs.find((s) => s.id === current.songId) : null;
  const next = upNext(state);
  const signupUrl = `${location.origin}/`;

  return el('div', { class: 'board' },
    el('div', { class: 'board__head' },
      el('div', { class: 'board__qr' },
        qrSvg(signupUrl, { size: 240 }),
        el('div', { class: 'board__url mono' }, signupUrl.replace(/^https?:\/\//, '')),
      ),

      titles(state, current, onDeck, next),
    ),

    mainPanel(state, current, onDeck, next),

    el('div', { class: 'callout__foot' },
      el('span', {}, state.jam.name),
      el('span', {}, `${pluralize(state.roundIndex, 'song')} played`),
      el('span', {}, `${pluralize(state.players.filter((p) => p.present).length, 'musician')} here`),
    ),
  );
}

/**
 * The headline is whatever the room most needs to read right now.
 *
 * With a song on deck that is the song. Between songs it is what is coming —
 * not the words "Between songs", which was the largest thing on the screen and
 * told nobody anything. A jam spends most of its night between songs, so that
 * state deserves the better layout, not the leftover one.
 */
function titles(state, current, onDeck, next) {
  if (current) {
    return el('div', { class: 'board__titles' },
      el('div', {},
        el('div', { class: 'board__kicker' }, 'Now'),
        el('div', { class: 'board__now' }, onDeck ? onDeck.title : 'Free jam'),
        detail(onDeck),
      ),
      next
        ? el('div', {},
            el('div', { class: 'board__kicker board__kicker--next' }, 'Next'),
            el('div', { class: 'board__next' }, next.title),
            detail(next, true),
          )
        : null,
    );
  }

  return el('div', { class: 'board__titles' },
    el('div', {},
      el('div', { class: 'board__kicker board__kicker--next' }, next ? 'Up next' : 'Tonight'),
      el('div', { class: 'board__now' }, next ? next.title : state.jam.name),
      next ? detail(next) : el('div', { class: 'board__meta' }, 'Scan the code to get on the list'),
    ),
  );
}

const detail = (song, small = false) => {
  if (!song) return null;
  const text = [song.artist, song.key && `key of ${song.key}`].filter(Boolean).join(' · ');
  return text ? el('div', { class: `board__meta${small ? ' board__meta--small' : ''}` }, text) : null;
};

/**
 * Whichever of the three is most useful right now: the band once the host has
 * picked it, the sign-up sheet for the song being picked, or the sheet for
 * whatever is up next while the room is between songs.
 */
function mainPanel(state, current, onDeck, next) {
  if (current?.picks?.length) return stage(state, current);
  if (current) return signupSheet(state, onDeck, 'Signing up now');
  // The song title is the headline directly above, so the heading does not
  // repeat it back.
  if (next) return signupSheet(state, next, 'Signed up');
  return waitingFor(state);
}

/** The band the host called, big enough to read from behind a drum kit. */
function stage(state, current) {
  const nameOf = (id) => state.players.find((p) => p.id === id)?.name || 'open';

  return el('div', { class: 'board__panel' },
    el('div', { class: 'board__panel-head' }, 'On stage'),
    el('div', { class: `callout__grid${current.picks.length > 5 ? ' callout__grid--split' : ''}` },
      current.picks.map((pick) =>
        el('div', { class: 'callout__row' },
          el('div', { class: 'callout__inst' }, pick.instrument),
          el('div', { class: 'callout__name' }, nameOf(pick.playerId)),
        ),
      ),
    ),
  );
}

/**
 * Everyone who has put their name down, grouped by what they said they would
 * play. Instruments follow the jam's band order so the sheet reads the same
 * way every time, with anything unexpected appended rather than dropped.
 */
function signupSheet(state, song, heading) {
  const signups = signupsFor(state, song?.id);
  if (!signups.length) {
    return el('div', { class: 'board__panel' },
      el('div', { class: 'board__panel-head' }, heading),
      el('div', { class: 'board__idle' },
        el('p', {}, 'Nobody yet — scan the code and add your name'),
      ),
    );
  }

  const key = (name) => String(name || '').trim().toLowerCase();
  const rows = coverageFor(state, song).filter((row) => row.got > 0);

  return el('div', { class: 'board__panel' },
    el('div', { class: 'board__panel-head' },
      heading,
      el('span', { class: 'board__count' }, pluralize(signups.length, 'name')),
    ),
    el('div', { class: `callout__grid${rows.length > 5 ? ' callout__grid--split' : ''}` },
      rows.map((row) => {
        const who = signups.filter((s) => key(s.instrument) === key(row.instrument));
        return el('div', { class: 'callout__row' },
          el('div', { class: 'callout__inst' }, row.instrument),
          // The separator is its own node rather than padding on the name:
          // the row is a flex container, so whitespace inside a name span
          // collapses against the edge and the dot ends up hugging the
          // previous name.
          el('div', { class: 'callout__name callout__name--list' },
            who.map((s, i) => [
              i ? el('span', { class: 'board__sep' }, '·') : null,
              el('span', { class: `board__who${s.present ? '' : ' board__who--away'}` }, s.name),
            ]),
          ),
        );
      }),
    ),
  );
}

/** Nothing queued at all: the space under the titles becomes the sign-up nudge. */
function waitingFor(state) {
  const waiting = state.players.filter((p) => p.present && p.stats.plays === 0);
  return el('div', { class: 'board__idle' },
    el('p', {}, state.players.length ? 'Scan to sign up and get on the list' : 'Scan to get on the list'),
    waiting.length
      ? el('p', { class: 'board__waiting' },
          `Here and not up yet: ${waiting.slice(0, 8).map((p) => p.name).join(' · ')}`)
      : null,
  );
}
