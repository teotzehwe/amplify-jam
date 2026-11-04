/* The musician's phone: sign up, say what you're comfortable with, see when you're up. */

import {
  $, api, approvedSongs, busy, confirmButton, declinedSongs, el, guard, masthead, pendingSongs, pluralize, render,
  shake, subscribe, toast, tokens,
} from './common.js';
import {
  playerTourSteps, startTour, syncTour, tourButton, tourSeen,
} from './tour.js';

const app = $('#app');
const PLAYER_TOUR = 'player';

/** Everything the sign-up form is holding before it is submitted. */
const draft = {
  name: '',
  instruments: new Map(), // name -> level
  stances: {},
};

/** Guest join vs password sign-in on the entry screen. */
let entryMode = 'join'; // 'join' | 'signin'
const loginDraft = { username: '', password: '' };

/**
 * Held outside the render so a live update from anyone else in the room
 * cannot wipe a half-typed suggestion.
 */
const suggestion = { title: '', artist: '' };

let state = null;
/** Instruments are edited in a scratch copy so a live refresh cannot clobber typing. */
let instrumentEdit = null;

const _jamFromUrl = new URL(location.href).searchParams.get('jam');
if (_jamFromUrl) tokens.jam = _jamFromUrl;

const refresh = subscribe((next) => {
  state = next;
  draw();
});

const me = () => (state?.youId ? state.players.find((p) => p.id === state.youId) : null);

/** Collapsible sections the reader opened — kept across live refreshes. */
const openSections = new Set();

function section(id, title, ...children) {
  return el('details', {
    class: 'folio folio--details',
    open: openSections.has(id),
    onToggle: (e) => (e.target.open ? openSections.add(id) : openSections.delete(id)),
  }, ...children.length ? [el('summary', {}, ...[].concat(title)), ...children] : []);
}

/**
 * Re-render, then put the cursor back. The whole view is rebuilt on every
 * change, so without this a live update from the host would yank focus out
 * of whatever someone was typing.
 */
function draw() {
  if (!state) return;
  const activeEl = document.activeElement;
  const focusId = activeEl?.id || null;
  const caret = activeEl && 'selectionStart' in activeEl ? activeEl.selectionStart : null;
  const tourOwnsFocus = Boolean(activeEl?.closest?.('#tour-root'));

  const you = me();
  render(app, you ? youView(you) : signupView());

  // First paint gets entrance motion; live rebuilds stay still.
  if (!app.classList.contains('is-live')) {
    requestAnimationFrame(() => {
      app.classList.add('is-live');
      maybeStartPlayerTour();
    });
  }

  syncTour();

  if (tourOwnsFocus || !focusId) return;
  const restored = document.getElementById(focusId);
  if (!restored) return;
  restored.focus({ preventScroll: true });
  if (caret != null && restored.setSelectionRange) {
    try { restored.setSelectionRange(caret, caret); } catch { /* not a text input */ }
  }
}

function playerSteps() {
  return playerTourSteps({
    you: me,
    entryMode: () => entryMode,
    suggestionsOn: () => Boolean(state?.jam?.allowSuggestions),
  });
}

function maybeStartPlayerTour() {
  if (tourSeen(PLAYER_TOUR)) return;
  startTour(PLAYER_TOUR, playerSteps());
}

/* ------------------------------------------------------------------ shared */

/**
 * Instrument picker as a typographic checklist — hairline rows, not chip chrome.
 * Selected rows use purple ink and a mark; the list should read like a craft menu.
 */
function instrumentPicker(selected, onChange, inputId = 'add-instrument') {
  const custom = [...selected.keys()].filter((n) => !state.presets.includes(n));
  const list = el('div', { class: 'choices', role: 'group', 'aria-label': 'Instruments' });

  for (const name of [...state.presets, ...custom]) {
    const on = selected.has(name);
    list.append(
      el('button', {
        type: 'button',
        class: `choice${on ? ' is-on' : ''}`,
        'aria-pressed': String(on),
        onClick: () => {
          if (selected.has(name)) selected.delete(name);
          else selected.set(name, 'comfortable');
          onChange();
        },
      },
        el('span', { class: 'choice__tick', 'aria-hidden': 'true' }, on ? '✓' : '+'),
        el('span', { class: 'choice__label' }, name),
      ),
    );
  }

  const input = el('input', {
    id: inputId,
    type: 'text',
    placeholder: 'Something else? Type it and hit return',
    'aria-label': 'Add an instrument that is not listed',
    maxLength: 40,
    onKeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      const existing = [...selected.keys(), ...state.presets].find((n) => n.toLowerCase() === name.toLowerCase());
      selected.set(existing || name, selected.get(existing) || 'comfortable');
      input.value = '';
      onChange();
    },
  });

  return el('div', { class: 'stack' }, list, input);
}

/**
 * The sign-up sheet: one song per submission, as many songs as you like.
 *
 * Each row is its own small form — pick the instrument you'd play it on, hit
 * the button, done. Signing up for one song never commits you to another, and
 * anything you have not signed up for simply is not a sign-up.
 */
function songSignup(you) {
  const songs = approvedSongs(state);
  if (!songs.length) {
    return el('div', { class: 'empty' },
      'No songs on the setlist yet. The moment the host adds one — or waves a request through — it appears here to sign up for.');
  }

  const submit = guard(busy(async (songId, instrument) => {
    await api(`/players/${you.id}`, {
      method: 'PATCH',
      body: { stances: { [songId]: 'in' }, picks: instrument ? { [songId]: instrument } : {} },
    });
    toast("You're on for it");
    await refresh(true);
  }, 'player-signup'));

  const withdraw = guard(busy(async (songId) => {
    await api(`/players/${you.id}`, { method: 'PATCH', body: { clearSongs: [songId] } });
    toast('Taken off that one');
    await refresh(true);
  }, 'player-withdraw'));

  const unsuggest = guard(busy(async (songId) => {
    await api(`/songs/${songId}`, { method: 'DELETE' });
    toast('Suggestion removed');
    await refresh(true);
  }, 'player-unsuggest'));

  const suggesterName = (id) => state.players.find((p) => p.id === id)?.name;

  const list = el('div', {});
  for (const song of songs) {
    const signedUp = you.stances[song.id] === 'in';
    const chosen = you.picks?.[song.id] || you.instruments[0]?.name;
    const mine = song.suggestedBy === you.id;
    const from = !mine && song.suggestedBy ? suggesterName(song.suggestedBy) : null;
    const meta = [song.artist, song.key && `key of ${song.key}`, from && `suggested by ${from}`]
      .filter(Boolean).join(' · ');

    list.append(
      el('div', { class: `signup-row${signedUp ? ' signup-row--in' : ''}` },
        el('div', { class: 'grow' },
          el('div', { class: 'row', style: { gap: '8px' } },
            el('div', { class: 'song-row__title' }, song.title),
            mine ? el('span', { class: 'tag tag--lead' }, 'your suggestion') : null,
          ),
          el('div', { class: 'song-row__meta' }, meta || 'No details'),
          mine
            ? el('button', { class: 'btn btn--link', onClick: () => unsuggest(song.id) }, 'Remove suggestion')
            : null,
        ),

        signedUp
          ? el('div', { class: 'row' },
              el('span', { class: 'tag tag--in' }, `Signed up · ${chosen}`),
              el('button', {
                class: 'btn btn--sm btn--quiet',
                onClick: () => withdraw(song.id),
              }, 'Withdraw'),
            )
          : el('div', { class: 'row row--wrap' },
              // Only ask which instrument when there is actually a choice.
              you.instruments.length > 1
                ? el('select', {
                    'aria-label': `Instrument for ${song.title}`,
                    id: `pick-${song.id}`,
                    value: chosen,
                  }, you.instruments.map((i) =>
                    el('option', { value: i.name, selected: i.name === chosen }, i.name)))
                : null,
              el('button', {
                class: 'btn btn--primary btn--sm',
                onClick: () => submit(
                  song.id,
                  you.instruments.length > 1 ? $(`#pick-${song.id}`)?.value : you.instruments[0]?.name,
                ),
              }, 'Sign up'),
            ),
      ),
    );
  }

  const count = songs.filter((s) => you.stances[s.id] === 'in').length;
  return el('div', { class: 'stack' },
    list,
    el('p', { class: 'section-note' },
      count
        ? `You're signed up for ${pluralize(count, 'song')}. Your name goes up on the stage screen, and the host picks the band from that list.`
        : 'Sign up for one song at a time — as many as you want. Your name goes up on the stage screen.'),
  );
}

/**
 * Requests of yours the host has not looked at yet. Worth showing even though
 * there is nothing to do with them: without this, suggesting a song and then
 * not finding it in the list above reads as the app having lost it.
 */
function pendingMine(you) {
  const mine = pendingSongs(state).filter((s) => s.suggestedBy === you.id);
  if (!mine.length) return null;

  const unsuggest = guard(busy(async (songId) => {
    await api(`/songs/${songId}`, { method: 'DELETE' });
    toast('Request withdrawn');
    await refresh(true);
  }, 'player-unsuggest-pending'));

  return el('section', { class: 'folio' },
    el('div', { class: 'folio__rule' },
      el('h2', {}, 'Waiting on the host'),
      el('span', { class: 'hint' }, pluralize(mine.length, 'request')),
    ),
    el('div', { class: 'stack' },
      mine.map((song) =>
        el('div', { class: 'signup-row' },
          el('div', { class: 'grow' },
            el('div', { class: 'song-row__title' }, song.title),
            el('div', { class: 'song-row__meta' },
              [song.artist, song.key && `key of ${song.key}`].filter(Boolean).join(' · ') || 'No details'),
          ),
          el('div', { class: 'row' },
            el('span', { class: 'tag tag--maybe' }, 'Pending'),
            el('button', {
              class: 'btn btn--sm btn--quiet',
              onClick: () => unsuggest(song.id),
            }, 'Withdraw'),
          ),
        ),
      ),
      el('p', { class: 'section-note' },
        'The host waves these through before anyone can sign up for them. Once approved it joins the setlist above.'),
    ),
  );
}

/** Host said no — keep the title so it does not look like the app lost it. */
function declinedMine(you) {
  const mine = declinedSongs(state).filter((s) => s.suggestedBy === you.id);
  if (!mine.length) return null;

  const dismiss = guard(busy(async (songId) => {
    await api(`/songs/${songId}`, { method: 'DELETE', as: 'player' });
    toast('Removed');
    await refresh(true);
  }, 'player-dismiss-declined'));

  return el('section', { class: 'folio' },
    el('div', { class: 'folio__rule' },
      el('h2', {}, 'Not this time'),
      el('span', { class: 'hint' }, pluralize(mine.length, 'request')),
    ),
    el('div', { class: 'stack' },
      mine.map((song) =>
        el('div', { class: 'signup-row' },
          el('div', { class: 'grow' },
            el('div', { class: 'song-row__title' }, song.title),
            el('div', { class: 'song-row__meta' },
              song.declineReason
                ? `Host: ${song.declineReason}`
                : 'The host passed on this one'),
          ),
          el('div', { class: 'row' },
            el('span', { class: 'tag' }, 'Declined'),
            el('button', {
              class: 'btn btn--sm btn--quiet',
              onClick: () => dismiss(song.id),
            }, 'Dismiss'),
          ),
        ),
      ),
    ),
  );
}

/**
 * Suggest a song. No limit on how many — a jam runs on what the room wants
 * to play, and the host can still turn suggestions off or remove any of them.
 */
function suggestSong(you) {
  const add = guard(busy(async () => {
    if (!suggestion.title.trim()) {
      shake(document.getElementById('suggest-title'));
      return toast('It needs a title', 'error');
    }
    if (!suggestion.artist.trim()) {
      shake(document.getElementById('suggest-artist'));
      return toast('Add the artist too', 'error');
    }
    const res = await api('/songs', {
      method: 'POST',
      // Never send the host key with a room request — same phone often holds
      // both tokens, and that used to put songs on the sign-up sheet unvetted.
      as: 'player',
      body: { title: suggestion.title, artist: suggestion.artist },
    });
    suggestion.title = '';
    suggestion.artist = '';
    toast(res.status === 'pending' ? 'Sent to the host' : 'Added — sign up for it above');
    await refresh(true);
    document.getElementById('suggest-title')?.focus();
  }));

  const field = (id, key, placeholder, style) => el('input', {
    id,
    type: 'text',
    placeholder,
    'aria-label': placeholder,
    value: suggestion[key],
    maxLength: 80,
    style,
    onInput: (e) => { suggestion[key] = e.target.value; },
    onKeydown: (e) => e.key === 'Enter' && add(),
  });

  const mine = state.songs.filter((s) => s.suggestedBy === you.id);
  const gated = state.jam.requireApproval;

  return el('section', { class: 'folio', dataset: { tour: 'player-suggest' } },
    el('div', { class: 'folio__rule' },
      el('h2', {}, 'Suggest a song'),
      el('span', { class: 'hint' }, 'As many as you like'),
    ),
    el('div', { class: 'stack' },
      field('suggest-title', 'title', 'Song title'),
      field('suggest-artist', 'artist', 'Artist'),
      el('button', { class: 'btn btn--primary btn--block', onClick: add },
        gated ? 'Send it to the host' : 'Add to the setlist'),
      el('p', { class: 'section-note' },
        gated
          ? `The host checks requests before they join the setlist.${mine.length ? ` You have sent ${pluralize(mine.length, 'song')}.` : ''}`
          : `It shows up on everyone else's phone straight away.${mine.length ? ` You have suggested ${pluralize(mine.length, 'song')}.` : ''}`),
    ),
  );
}

/* ------------------------------------------------------------------ signup */

function signupView() {
  const redraw = () => draw();
  const showSignIn = Boolean(state.hasUsers);

  const submitJoin = guard(busy(async () => {
    if (!draft.name.trim()) {
      shake(document.getElementById('name')?.closest('.field') || document.getElementById('name'));
      return toast('Add your name first', 'error');
    }
    if (!draft.instruments.size) {
      shake(document.querySelector('.choices'));
      return toast('Pick at least one instrument', 'error');
    }

    const res = await api('/join', {
      method: 'POST',
      body: {
        name: draft.name,
        instruments: [...draft.instruments].map(([name, level]) => ({ name, level })),
        stances: draft.stances,
      },
    });
    tokens.player = res.token;
    tokens.playerId = res.id;
    toast("You're on the list");
    refresh(true);
  }));

  const submitLogin = guard(busy(async () => {
    if (!loginDraft.username.trim()) {
      shake(document.getElementById('login-username')?.closest('.field') || $('#login-username'));
      return toast('Enter your username', 'error');
    }
    if (!loginDraft.password) {
      shake(document.getElementById('login-password')?.closest('.field') || $('#login-password'));
      return toast('Enter your password', 'error');
    }
    const res = await api('/auth/login', {
      method: 'POST',
      as: 'player',
      body: {
        username: loginDraft.username.trim(),
        password: loginDraft.password,
      },
    });
    tokens.player = res.token;
    tokens.playerId = res.id;
    loginDraft.password = '';
    toast(`Welcome back, ${res.username}`);
    refresh(true);
  }, 'player-login'));

  const mode = showSignIn ? entryMode : 'join';

  return el('div', { class: 'stack stack--lg' },
    masthead(state.jam.name, 'Hey! Jump in and tell us who you are.',
      tourButton(PLAYER_TOUR, playerSteps),
    ),

    showSignIn
      ? el('div', { class: 'row row--wrap', role: 'tablist', 'aria-label': 'How to join' },
          el('button', {
            type: 'button',
            role: 'tab',
            class: `btn btn--sm${mode === 'join' ? ' btn--primary' : ' btn--ghost'}`,
            'aria-selected': String(mode === 'join'),
            onClick: () => { entryMode = 'join'; draw(); },
          }, 'Join as guest'),
          el('button', {
            type: 'button',
            role: 'tab',
            class: `btn btn--sm${mode === 'signin' ? ' btn--primary' : ' btn--ghost'}`,
            'aria-selected': String(mode === 'signin'),
            onClick: () => { entryMode = 'signin'; draw(); },
          }, 'Sign in'),
        )
      : null,

    mode === 'signin'
      ? el('section', { class: 'folio', dataset: { tour: 'player-signin' } },
          el('p', { class: 'section-note' },
            'Use the username and password the host set up for you.'),
          el('div', { class: 'field' },
            el('label', { for: 'login-username' }, 'Username'),
            el('input', {
              id: 'login-username',
              type: 'text',
              autocomplete: 'username',
              spellcheck: 'false',
              maxLength: 32,
              value: loginDraft.username,
              onInput: (e) => { loginDraft.username = e.target.value; },
            }),
          ),
          el('div', { class: 'field' },
            el('label', { for: 'login-password' }, 'Password'),
            el('input', {
              id: 'login-password',
              type: 'password',
              autocomplete: 'current-password',
              maxLength: 72,
              value: loginDraft.password,
              onInput: (e) => { loginDraft.password = e.target.value; },
              onKeydown: (e) => e.key === 'Enter' && submitLogin(e),
            }),
          ),
          el('div', { class: 'sticky-bar' },
            el('button', { class: 'btn btn--primary btn--lg btn--block', onClick: submitLogin }, 'Sign in'),
          ),
        )
      : el('section', { class: 'folio', dataset: { tour: 'player-join' } },
          el('div', { class: 'field' },
            el('label', { for: 'name' }, 'Your name'),
            el('input', {
              id: 'name',
              type: 'text',
              maxLength: 60,
              autocomplete: 'name',
              placeholder: 'What should we call you?',
              value: draft.name,
              onInput: (e) => { draft.name = e.target.value; },
            }),
          ),

          el('div', { class: 'folio__rule' }, el('span', { class: 'kicker' }, 'What do you play?')),

          el('p', { class: 'section-note' }, 'Tap everything you might grab tonight — no wrong answers.'),
          instrumentPicker(draft.instruments, redraw),

          el('div', { class: 'sticky-bar' },
            el('button', { class: 'btn btn--primary btn--lg btn--block', onClick: submitJoin }, "I'm in!"),
          ),
        ),
  );
}

/* -------------------------------------------------------------- your card */

function youView(you) {
  const onDeck = state.current;
  const yourSlot = onDeck?.picks.find((p) => p.playerId === you.id);
  const song = onDeck ? state.songs.find((s) => s.id === onDeck.songId) : null;

  const save = guard(async (patch) => {
    await api(`/players/${you.id}`, { method: 'PATCH', body: patch });
    toast('Saved');
  });

  const waited = you.stats.lastRound == null ? state.roundIndex : state.roundIndex - you.stats.lastRound;

  return el('div', { class: 'stack stack--lg' },
    masthead(state.jam.name, `Nice — you're in as ${you.name}.`,
      tourButton(PLAYER_TOUR, playerSteps),
    ),

    yourSlot
      ? el('section', { class: 'onstage' },
          el('div', { class: 'kicker' }, "You're up!"),
          el('div', { class: 'what' }, `${yourSlot.instrument} · ${song ? song.title : 'Next song'}`),
          el('p', { class: 'muted small', style: { marginTop: '6px' } },
            "Okay! You're in the queue, stay tuned for when the host calls everyone up!"),
        )
      : null,

    el('section', { class: 'folio', dataset: { tour: 'player-profile' } },
      el('div', { class: 'row row--between row--wrap' },
        el('div', {},
          el('h2', { class: 'folio__name' }, you.name),
          el('p', { class: 'folio__instruments' },
            you.instruments.map((i) => i.name).join(' · ')),
        ),
        el('span', { class: `tag tag--${you.present ? 'in' : 'out'}` }, you.present ? 'Here' : 'On a break'),
      ),
      el('p', { class: 'meta-line' },
        you.stats.lastRound == null ? 'Not up yet' : `${waited} since last`),
      el('label', { class: 'toggle' },
        el('input', {
          type: 'checkbox',
          checked: you.present,
          onChange: (e) => save({ present: e.target.checked }),
        }),
        el('span', { class: 'toggle__track' }),
        el('span', { class: 'toggle__text' }, "I'm here and ready",
          el('small', {}, 'Turn this off for a break — you keep your place in the queue.')),
      ),
    ),

    el('section', { class: 'folio', dataset: { tour: 'player-songs' } },
      el('div', { class: 'folio__rule' },
        el('span', { class: 'kicker' }, 'Pick some songs'),
        el('span', { class: 'hint' }, 'As many as you want'),
      ),
      songSignup(you),
    ),

    pendingMine(you),
    declinedMine(you),
    state.jam.allowSuggestions ? suggestSong(you) : null,

    section('instruments', 'My Instruments',
      instrumentPicker(
        (instrumentEdit ||= new Map(you.instruments.map((i) => [i.name, i.level]))),
        draw,
        'edit-instrument',
      ),
      el('button', {
        class: 'btn btn--sm',
        onClick: guard(busy(async () => {
          if (!instrumentEdit?.size) {
            shake(document.querySelector('.choices'));
            return toast('Keep at least one instrument', 'error');
          }
          await api(`/players/${you.id}`, {
            method: 'PATCH',
            body: { instruments: [...instrumentEdit].map(([name, level]) => ({ name, level })) },
          });
          instrumentEdit = null;
          toast('Instruments updated');
        })),
      }, 'Save instruments'),
    ),

    el('div', { class: 'center' },
      confirmButton({
        key: 'leave-jam',
        label: 'Leave the jam',
        class: 'btn btn--danger btn--sm',
        confirmClass: 'btn btn--danger btn--sm',
        title: 'Leave the jam? Your sign-up will be removed.',
        onConfirm: async () => {
          await api(`/players/${you.id}`, { method: 'DELETE' });
          tokens.player = '';
          tokens.playerId = '';
          location.reload();
        },
        onChange: draw,
      }),
    ),
  );
}
