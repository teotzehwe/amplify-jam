/**
 * In-app product tour. Lives outside #app so live poll redraws cannot wipe it.
 *
 * Screens call `syncTour()` after every paint. The tour re-finds its target by
 * selector, repositions the card, and runs per-step `enter` hooks once.
 */

import { $, el, render } from './common.js';

const VERSION = 2;
const storageKey = (id) => `amplify.tour.${id}.v${VERSION}`;

const TOUR_KICKERS = {
  player: 'Quick tour',
  host: 'Admin tour',
  admin: 'Admin tour',
};

/** @typedef {{
 *   title: string,
 *   body: string,
 *   selector?: string,
 *   tab?: string,
 *   when?: () => boolean,
 *   enter?: () => void,
 * }} TourStep */

/** @type {{ id: string, steps: TourStep[], step: number, entered: number } | null} */
let active = null;
/** Optional host: switch console tab before a step that needs it. */
let tabController = null;
let onPaint = null;
let previouslyFocused = null;
/** Cancel any in-flight highlight tracking after a smooth scroll. */
let highlightTrack = 0;

export function tourSeen(id) {
  try { return localStorage.getItem(storageKey(id)) === 'done'; }
  catch { return false; }
}

export function markTourSeen(id) {
  try { localStorage.setItem(storageKey(id), 'done'); }
  catch { /* private mode */ }
}

export function clearTourSeen(id) {
  try { localStorage.removeItem(storageKey(id)); }
  catch { /* private mode */ }
}

/**
 * Register how the tour asks the host console to change tabs / redraw.
 * @param {{ setTab?: (id: string) => void, paint?: () => void }} ctrls
 */
export function bindTourHost(ctrls) {
  tabController = ctrls.setTab || null;
  onPaint = ctrls.paint || null;
}

export function isTourActive() {
  return Boolean(active);
}

export function startTour(id, steps, { force = false } = {}) {
  const usable = (steps || []).filter((s) => !s.when || s.when());
  if (!usable.length) return false;
  if (!force && tourSeen(id)) return false;
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  active = { id, steps: usable, step: 0, entered: -1 };
  paintTour();
  return true;
}

export function stopTour({ markSeen = true } = {}) {
  if (!active) return;
  if (markSeen) markTourSeen(active.id);
  active = null;
  highlightTrack += 1;
  setPageInert(false);
  removeTourDom();
  const restore = previouslyFocused;
  previouslyFocused = null;
  if (restore?.isConnected) {
    try { restore.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
}

export function tourButton(id, stepsOrFn, label = 'Tour') {
  return el('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm',
    'aria-label': `Start the ${label.toLowerCase()} walkthrough`,
    onClick: (e) => {
      // Re-rendering the overlay under the cursor must not also hit Skip/scrim.
      e.preventDefault();
      e.stopPropagation();
      const steps = typeof stepsOrFn === 'function' ? stepsOrFn() : stepsOrFn;
      startTour(id, steps, { force: true });
    },
  }, label);
}

/** Re-attach after a live redraw. Safe to call when no tour is running. */
export function syncTour() {
  if (!active) return;
  const step = currentStep();
  if (!step) {
    stopTour();
    return;
  }
  if (active.entered !== active.step) {
    active.entered = active.step;
    try { step.enter?.(); } catch { /* step hooks must not kill the tour */ }
  }
  // Host steps may need another tab's markup. Switch, then ask for a paint
  // once this call stack unwinds so we do not recurse inside draw().
  if (step.tab && tabController) {
    const changed = tabController(step.tab);
    if (changed) {
      paintTour();
      queueMicrotask(() => {
        if (active) onPaint?.();
      });
      return;
    }
  }
  paintTour();
}

function currentStep() {
  if (!active) return null;
  return active.steps[active.step] || null;
}

function go(delta) {
  if (!active) return;
  const next = active.step + delta;
  if (next < 0) return;
  if (next >= active.steps.length) {
    stopTour({ markSeen: true });
    return;
  }
  active.step = next;
  active.entered = -1;
  // Defer paint so the same click that pressed Next cannot land on the
  // freshly mounted scrim and dismiss the tour immediately.
  requestAnimationFrame(() => {
    if (!active) return;
    if (onPaint) onPaint();
    else syncTour();
  });
}

function removeTourDom() {
  document.getElementById('tour-root')?.remove();
  document.documentElement.classList.remove('tour-active');
}

/** Keep the underlying page out of the tab order while the tour is open. */
function setPageInert(on) {
  const app = document.getElementById('app');
  if (!app) return;
  if (on) app.setAttribute('inert', '');
  else app.removeAttribute('inert');
}

function tourFocusables(root) {
  return [...root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((node) => node instanceof HTMLElement && node.offsetParent !== null);
}

function ensureRoot() {
  let root = document.getElementById('tour-root');
  if (root) return root;
  root = el('div', { id: 'tour-root', class: 'tour' });
  document.body.append(root);
  document.documentElement.classList.add('tour-active');
  setPageInert(true);
  return root;
}

function applyHighlight(root, target) {
  const hole = root.querySelector('.tour__hole');
  const card = root.querySelector('.tour__card');
  if (!card) return;
  const rect = target?.getBoundingClientRect?.();
  const hasTarget = Boolean(rect && rect.width > 0 && rect.height > 0);
  if (hasTarget && hole) {
    hole.style.top = `${Math.max(8, rect.top - 8)}px`;
    hole.style.left = `${Math.max(8, rect.left - 8)}px`;
    hole.style.width = `${rect.width + 16}px`;
    hole.style.height = `${rect.height + 16}px`;
    hole.hidden = false;
  } else if (hole) {
    hole.hidden = true;
  }
  placeCard(card, hasTarget ? rect : null);
}

function trackHighlight(root, target) {
  const token = ++highlightTrack;
  if (!target) {
    applyHighlight(root, null);
    return;
  }
  applyHighlight(root, target);
  let frames = 0;
  const tick = () => {
    if (!active || token !== highlightTrack) return;
    applyHighlight(root, target);
    frames += 1;
    // Smooth scroll can take a few hundred ms; keep the hole glued on.
    if (frames < 45) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const onScrollEnd = () => {
    target.removeEventListener('scrollend', onScrollEnd);
    if (active && token === highlightTrack) applyHighlight(root, target);
  };
  try { target.addEventListener('scrollend', onScrollEnd, { once: true }); } catch { /* older browsers */ }
}

function paintTour() {
  if (!active) {
    setPageInert(false);
    removeTourDom();
    return;
  }
  const step = currentStep();
  if (!step) {
    stopTour();
    return;
  }

  const root = ensureRoot();
  setPageInert(true);
  const target = step.selector ? document.querySelector(step.selector) : null;
  const last = active.step === active.steps.length - 1;
  const n = active.steps.length;

  if (target) {
    try {
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    } catch {
      target.scrollIntoView(true);
    }
  }

  const rect = target?.getBoundingClientRect?.();
  const hasTarget = Boolean(rect && rect.width > 0 && rect.height > 0);

  const card = el('div', {
    class: 'tour__card',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'tour-title',
    'aria-describedby': 'tour-body',
  },
    el('div', { class: 'tour__meta' },
      el('span', { class: 'tour__kicker' }, TOUR_KICKERS[active.id] || 'Tour'),
      el('span', { class: 'tour__progress', 'aria-hidden': 'true' }, `${active.step + 1} / ${n}`),
    ),
    el('h2', { id: 'tour-title', class: 'tour__title' }, step.title),
    el('p', { id: 'tour-body', class: 'tour__body' }, step.body),
    el('div', { class: 'tour__actions' },
      el('button', {
        type: 'button',
        class: 'btn btn--quiet btn--sm',
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          stopTour({ markSeen: true });
        },
      }, 'Skip'),
      el('span', { class: 'spacer' }),
      el('button', {
        type: 'button',
        class: 'btn btn--sm',
        disabled: active.step === 0,
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          go(-1);
        },
      }, 'Back'),
      el('button', {
        type: 'button',
        class: 'btn btn--primary btn--sm',
        id: 'tour-next',
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          go(1);
        },
      }, last ? 'Done' : 'Next'),
    ),
  );

  const hole = el('div', {
    class: 'tour__hole',
    hidden: !hasTarget,
    style: hasTarget ? {
      top: `${Math.max(8, rect.top - 8)}px`,
      left: `${Math.max(8, rect.left - 8)}px`,
      width: `${rect.width + 16}px`,
      height: `${rect.height + 16}px`,
    } : undefined,
    'aria-hidden': 'true',
  });

  // Scrim dims the page and blocks clicks, but does not dismiss — phones in a
  // busy room miss the Next button easily, and a tap on the dark area used to
  // abort the whole tour.
  render(root,
    el('div', { class: 'tour__scrim', 'aria-hidden': 'true' }),
    hole,
    card,
  );

  placeCard(card, hasTarget ? rect : null);
  trackHighlight(root, target);

  const nextBtn = $('#tour-next', root);
  nextBtn?.focus({ preventScroll: true });
}

function placeCard(card, rect) {
  const pad = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Measure after mount.
  const cw = card.offsetWidth || 320;
  const ch = card.offsetHeight || 200;

  let top;
  let left;

  if (!rect) {
    top = Math.max(pad, (vh - ch) / 2);
    left = Math.max(pad, (vw - cw) / 2);
  } else {
    // Prefer below the target; if the hole is huge (or near the fold), pin the
    // card to the lower third of the viewport so Next stays clickable.
    const below = rect.bottom + 14;
    const above = rect.top - ch - 14;
    if (rect.height > vh * 0.45) {
      top = Math.max(pad, vh - ch - pad);
    } else if (below + ch + pad < vh) {
      top = below;
    } else {
      top = Math.max(pad, above);
    }
    left = Math.min(Math.max(pad, rect.left), vw - cw - pad);
  }

  // Final clamp — never leave Next under the fold.
  top = Math.min(Math.max(pad, top), Math.max(pad, vh - ch - pad));
  left = Math.min(Math.max(pad, left), Math.max(pad, vw - cw - pad));

  card.style.top = `${Math.round(top)}px`;
  card.style.left = `${Math.round(left)}px`;
}

// Keep the hole aligned on rotate / resize while a tour is open.
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    if (active) paintTour();
  }, { passive: true });
  window.addEventListener('keydown', (e) => {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      stopTour({ markSeen: true });
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(1);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(-1);
      return;
    }
    if (e.key !== 'Tab') return;
    const root = document.getElementById('tour-root');
    if (!root) return;
    const focusables = tourFocusables(root);
    if (!focusables.length) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const current = document.activeElement;
    if (!root.contains(current)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus({ preventScroll: true });
      return;
    }
    if (e.shiftKey && current === first) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!e.shiftKey && current === last) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    }
  });
}

/* ------------------------------------------------------------- step lists */

/** Musician phone (`/`). `ctx` supplies live predicates. */
export function playerTourSteps(ctx) {
  const signedIn = () => Boolean(ctx.you?.());
  const signingIn = () => ctx.entryMode?.() === 'signin';
  return [
    {
      title: 'Welcome to Amplify',
      body: 'Put your name down for songs from your phone. The host picks who plays — Amplify never volunteers you.',
    },
    {
      title: 'Tell us who you are',
      body: 'Add your name and tap every instrument you might grab tonight. You only do this once.',
      selector: '[data-tour="player-join"]',
      when: () => !signedIn() && !signingIn(),
    },
    {
      title: 'Sign in with your account',
      body: 'Use the username and password the host set up for you. You land on the same seat if you were already here tonight.',
      selector: '[data-tour="player-signin"]',
      when: () => !signedIn() && signingIn(),
    },
    {
      title: 'You’re on the list',
      body: 'This is your spot for the night. Turn “I’m here” off when you take a break — you keep your place in the queue.',
      selector: '[data-tour="player-profile"]',
      when: signedIn,
    },
    {
      title: 'Sign up, one song at a time',
      body: 'Each song has its own Sign up button. Pick an instrument if you play more than one. Not signing up is a complete answer.',
      selector: '[data-tour="player-songs"]',
      when: signedIn,
    },
    {
      title: 'Suggest a song',
      body: 'Send titles to the host. Pending requests wait for approval before anyone can sign up for them.',
      selector: '[data-tour="player-suggest"]',
      when: () => signedIn() && Boolean(ctx.suggestionsOn?.()),
    },
    {
      title: 'That’s the loop',
      body: 'Your name goes up on the stage screen. The host picks the band from that list. Nobody gets called for a song they did not sign up for.',
    },
  ];
}

/**
 * Admin dashboard tour for the host console (`/host`).
 * Needs bindTourHost({ setTab }) so tab-scoped steps can find their targets.
 */
export function adminTourSteps() {
  return [
    {
      title: 'Admin dashboard',
      body: 'This console runs the night: share the join link, vet requests, staff each song by hand, call it out, and back up the sheet.',
    },
    {
      title: 'Five tabs',
      body: 'Now is the live song. Roster is fairness at a glance. Songs is the setlist and waiting requests. Users is accounts and passwords. Settings is share, band, backups, and start-over.',
      selector: '[data-tour="host-tabs"]',
      tab: 'now',
    },
    {
      title: 'Stage display',
      body: 'Open the TV view in another window. It shows Now, Next, the sheet, and the same sign-up QR between songs.',
      selector: '[data-tour="host-stage"]',
      tab: 'now',
    },
    {
      title: 'Run the live song',
      body: 'Put a title on deck, tap musicians who signed up, call it out fullscreen, then Played to log turns — or Cancel to clear the deck.',
      selector: '[data-tour="host-now"]',
      tab: 'now',
    },
    {
      title: 'Roster & fairness',
      body: 'Longest wait first. Turns, last played, and on-a-break flags inform you — they never block a pick. Fairness stays a human job.',
      selector: '[data-tour="host-roster"]',
      tab: 'roster',
    },
    {
      title: 'Song requests',
      body: 'Room suggestions wait here until you approve them. Until then, nobody can sign up for that title — enforced on the server, not just hidden in the UI.',
      selector: '[data-tour="host-requests"]',
      tab: 'songs',
    },
    {
      title: 'Build the setlist',
      body: 'Add songs yourself, reorder with the arrows, or Play next to jump one to the front. Up next is derived — not a stored pointer.',
      selector: '[data-tour="host-setlist"]',
      tab: 'songs',
    },
    {
      title: 'Share the sign-up',
      body: 'Show this QR (or print it) so phones can join. Keep the host link to yourself — it carries the key that unlocks this dashboard.',
      selector: '[data-tour="host-share"]',
      tab: 'settings',
    },
    {
      title: 'The band template',
      body: 'Chairs you usually want filled (two guitars, bass, drums…). A readout on the sheet, not a hard limit — empty chairs stay empty if nobody signed up.',
      selector: '[data-tour="host-band"]',
      tab: 'settings',
    },
    {
      title: 'Request gates',
      body: 'Turn room requests on or off, and require approval before titles hit the setlist. Switching approval off lets through anything already waiting.',
      selector: '[data-tour="host-gates"]',
      tab: 'settings',
    },
    {
      title: 'Reports & backups',
      body: 'Session PDF is shareable (no tokens). Night backup includes session tokens — treat it like a password. Download one before Clear the night; there is no undo.',
      selector: '[data-tour="host-ops"]',
      tab: 'settings',
    },
    {
      title: 'The hard rule',
      body: 'Nobody is called for a song they did not sign up for. The API refuses any pick that is not on the sheet — even if you try from this console.',
    },
  ];
}

/** @deprecated Use adminTourSteps — kept as an alias for older imports/tests. */
export const hostTourSteps = adminTourSteps;
