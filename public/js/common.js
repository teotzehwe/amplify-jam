/* Shared plumbing: tiny DOM builder, API client, live-state subscription. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Build an element. Children are set as text nodes unless they are already
 * nodes — user-entered names and song titles never reach innerHTML.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(3)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  for (const c of children.flat(3)) if (c != null && c !== false) f.append(c instanceof Node ? c : String(c));
  return f;
};

/** Replace a container's contents in one shot. */
export function render(container, ...children) {
  container.replaceChildren(...frag(...children).childNodes);
}

/* ------------------------------------------------------------------ tokens */

const KEYS = { host: 'amplify.hostKey', player: 'amplify.playerToken', playerId: 'amplify.playerId' };

export const tokens = {
  get host() { return localStorage.getItem(KEYS.host) || new URL(location.href).searchParams.get('k') || ''; },
  set host(v) { v ? localStorage.setItem(KEYS.host, v) : localStorage.removeItem(KEYS.host); },
  get player() { return localStorage.getItem(KEYS.player) || ''; },
  set player(v) { v ? localStorage.setItem(KEYS.player, v) : localStorage.removeItem(KEYS.player); },
  get playerId() { return localStorage.getItem(KEYS.playerId) || ''; },
  set playerId(v) { v ? localStorage.setItem(KEYS.playerId, v) : localStorage.removeItem(KEYS.playerId); },
};

/* --------------------------------------------------------------------- api */

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(tokens.host ? { 'x-host-token': tokens.host } : {}),
      ...(tokens.player ? { 'x-player-token': tokens.player } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------------------------------------------- toast */

let toastTimer;
let toastLeaveTimer;
export function toast(message, kind = '') {
  let node = $('.toast');
  if (!node) document.body.append((node = el('div', { class: 'toast' })));
  clearTimeout(toastTimer);
  clearTimeout(toastLeaveTimer);
  node.className = `toast is-shown${kind ? ` toast--${kind}` : ''}`;
  node.replaceChildren(
    el('span', { class: 'toast__msg' }, message),
    el('span', { class: 'toast__tick', 'aria-hidden': 'true' }),
  );
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  toastTimer = setTimeout(() => {
    node.classList.add('is-leaving');
    node.classList.remove('is-shown');
    toastLeaveTimer = setTimeout(() => {
      node.classList.remove('is-leaving', 'toast--error', 'toast--success');
      node.replaceChildren();
    }, 220);
  }, 2600);
}

/** Flash a field (or choices group) with a shake + invalid border. */
export function shake(target) {
  if (!target) return;
  target.classList.remove('is-invalid');
  // reflow so re-adding restarts the animation
  void target.offsetWidth;
  target.classList.add('is-invalid');
  const clear = () => target.classList.remove('is-invalid');
  target.addEventListener('animationend', clear, { once: true });
  setTimeout(clear, 400);
}

/** Run an async click handler with a busy spinner on the triggering button. */
export function busy(fn) {
  return async (event, ...rest) => {
    const btn = event?.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
    if (btn) {
      if (btn.classList.contains('is-busy') || btn.disabled) return;
      btn.classList.add('is-busy');
      btn.setAttribute('aria-busy', 'true');
    }
    try {
      await fn(event, ...rest);
    } finally {
      if (btn) {
        btn.classList.remove('is-busy');
        btn.removeAttribute('aria-busy');
      }
    }
  };
}

/** Wrap an async handler so failures surface as a toast instead of a dead click. */
export function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

/* -------------------------------------------------------- two-step confirm */

/**
 * Pending "Sure?" clicks, keyed so they survive a full re-render.
 *
 * The host console rebuilds on every poll (~2.5s) without reloading the page.
 * Native window.confirm() is suppressed by browsers after a few uses on the
 * same load ("Prevent this page from creating additional dialogs"), which
 * silently returns false forever — Remove buttons looked dead mid-jam. An
 * in-app arm/confirm on the button itself has no such limit, but the armed
 * state must live outside the DOM or the next poll wipes it.
 */
const pendingConfirms = new Map(); // key -> timeout id
const CONFIRM_MS = 3000;

/**
 * Destructive control: first click arms ("Sure?"), second click within ~3s
 * runs `onConfirm`. `onChange` fires when the armed state flips so the
 * caller can re-render.
 */
export function confirmButton({
  key,
  label,
  confirmLabel = 'Sure?',
  class: className = 'btn btn--sm btn--quiet',
  confirmClass = 'btn btn--sm btn--danger',
  title,
  onConfirm,
  onChange,
}) {
  const armed = pendingConfirms.has(key);
  return el('button', {
    type: 'button',
    class: armed ? confirmClass : className,
    title: title || undefined,
    'aria-label': title || undefined,
    onClick: guard(async () => {
      if (!pendingConfirms.has(key)) {
        const timer = setTimeout(() => {
          pendingConfirms.delete(key);
          onChange?.();
        }, CONFIRM_MS);
        pendingConfirms.set(key, timer);
        onChange?.();
        return;
      }
      clearTimeout(pendingConfirms.get(key));
      pendingConfirms.delete(key);
      onChange?.();
      await onConfirm();
    }),
  }, armed ? confirmLabel : label);
}

/* ------------------------------------------------------------- live state */

/**
 * Fetch state now, then again whenever it changes.
 *
 * A long-lived server pushes an event stream and this only polls as a
 * backstop for flaky venue wifi. A serverless host cannot hold a stream open,
 * so there it polls briskly instead. The server says which it is.
 */
export function subscribe(onState) {
  let last = -1;
  let busy = false;
  let queued = false;

  // `force` matters right after signing up: the version may already have been
  // consumed by an SSE refresh that started before our token was stored. Such a
  // refresh is also likely to be in flight, so a forced pull that arrives while
  // one is running has to be re-run rather than dropped.
  async function pull(force = false) {
    if (busy) {
      queued = queued || force;
      return;
    }
    busy = true;
    try {
      const state = await api('/state');
      connect(state.realtime);
      if (force || state.version !== last) {
        last = state.version;
        onState(state);
      }
    } catch (err) {
      console.warn('state refresh failed', err);
    } finally {
      busy = false;
      if (queued) {
        queued = false;
        await pull(true);
      }
    }
  }

  let events = null;
  let poll = null;

  /** Wire up live updates once the server has told us what it supports. */
  function connect(mode) {
    if (poll) return; // already connected
    if (mode === 'sse') {
      events = new EventSource('/api/events');
      events.onmessage = () => pull();
      events.onerror = () => {}; // EventSource retries on its own
      poll = setInterval(pull, 10000); // backstop if the stream dies quietly
    } else {
      poll = setInterval(pull, 2500);
    }
  }

  pull();
  window.addEventListener('beforeunload', () => {
    events?.close();
    clearInterval(poll);
  });
  return pull;
}

/* ------------------------------------------------------------------ pieces */

/** Songs already played tonight. A song can be called twice, so this is a set. */
export const playedSongIds = (state) => new Set(state.rounds.map((r) => r.songId).filter(Boolean));

/** The setlist proper: requests the host has let through. */
export const approvedSongs = (state) => state.songs.filter((s) => s.status === 'approved');

/** Requests still waiting on the host. Nobody can sign up for these yet. */
export const pendingSongs = (state) => state.songs.filter((s) => s.status === 'pending');

/** Who put their name down for a song, fewest turns tonight first. */
export const signupsFor = (state, songId) => state.signups?.[songId] || [];

/**
 * The next song in the queue: the first approved one not yet played and not
 * already on deck. Queue order is simply the order of `state.songs`, which the
 * host can rearrange.
 */
export function upNext(state) {
  const played = playedSongIds(state);
  return approvedSongs(state).find((s) => !played.has(s.id) && s.id !== state.current?.songId) || null;
}

/**
 * Sign-ups measured against the band the jam expects. Advisory only — a song
 * with nobody on bass is still callable, and the host may well know the
 * guitarist covers it.
 */
export function coverageFor(state, song) {
  const signups = signupsFor(state, song?.id);
  const counted = new Map();
  for (const s of signups) {
    const key = s.instrument.trim().toLowerCase();
    counted.set(key, (counted.get(key) || 0) + 1);
  }

  const template = song?.slots?.length ? song.slots : state.jam.slots;
  const rows = (template || []).filter((s) => s.instrument && s.count > 0).map((slot) => {
    const key = slot.instrument.trim().toLowerCase();
    const got = counted.get(key) || 0;
    counted.delete(key);
    return { instrument: slot.instrument, want: slot.count, got };
  });

  for (const [key, got] of counted) {
    const label = signups.find((s) => s.instrument.trim().toLowerCase() === key)?.instrument || key;
    rows.push({ instrument: label, want: 0, got });
  }
  return rows;
}

/** Yellow Amplify mark — never the hero; the jam name is. */
export function logoMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path d="M4 13v-2m4 6V7m4 13V4m4 13V7m4 6v-2" stroke="#030303" stroke-width="2.4" stroke-linecap="round"/>';
  return el('div', { class: 'mark mark--quiet', title: 'Amplify' }, svg);
}

/**
 * Friendly opening: brand mark, bold jam title, plain warm lede.
 * Optional actions sit opposite on wide screens, below on narrow ones.
 */
export function masthead(title, subtitle, ...extra) {
  return el('header', { class: 'masthead' },
    el('div', { class: 'masthead__open grow' },
      el('div', { class: 'masthead__brand' },
        logoMark(),
        el('p', { class: 'kicker' }, 'Amplify'),
      ),
      el('h1', {}, title),
      subtitle && el('p', { class: 'lede' }, subtitle),
    ),
    extra.length ? el('div', { class: 'masthead__actions' }, ...extra) : null,
  );
}

export const pluralize = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
