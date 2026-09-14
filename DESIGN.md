# Amplify — design system

**Intent:** a Tuscan editorial craft interface for a live music night — warm
parchment paper, olive `#465016`, olive-black ink — legible from a phone in a
dim room and from a TV across that room. Inspired by MONOGRID’s *The Tuscan
Journey Begins* (Weekend Max Mara): craft and atmosphere, not chrome. Zero
dependencies, no build step.


Rules use **must** (non-negotiable) and **should** (recommended). Every rule is
anchored to a token, a measured threshold, or an example — never to an adjective.

---

## 1. Context and goals

Three surfaces, one system:

| Surface | Read from | Ground | Job |
|---|---|---|---|
| `/` musician | a phone, held | parchment | Put your name down |
| `/host` console | a phone or laptop, working | parchment | Pick the band |
| `/board` stage | a TV, 3–10 m away | `--ink` olive night | Show who is on the list |

The board inverts because a light screen projected into a dim venue is glare. It
is the only dark surface, and it sets the confidence the light surfaces aim for:
large type, high contrast, letterspaced labels, generous scale jumps.

**Non-goals.** No framework, no build step, no runtime dependency, no network
font. The app must start with `node server.js` on a laptop with no internet.
No WebGL / GSAP storytelling layer — this is a working jam tool wearing Tuscan
materials, not a brand film.

---

## 2. Design tokens and foundations

All tokens live in `public/app.css` `:root`. Components **must** reference tokens,
never raw values.

### 2.1 Palette

Brand hues — used as **fills only** (or letterspaced kickers via `--ink-*`):

`--amber #465016` (primary olive, Awwwards palette) · `--burnt #5c4033` (warm
earth for live / on-stage) · `--amber-lift #7a8a3a` (lifted olive for dark
stage) · `--cream #f7f2e8` (parchment) · `--sand #e6dcc8` · `--ink #1a1c12`
(olive-black)

Semantic: `--success #3f6b2d` · `--warning #9a6b2f` · `--danger #8f2f2f`

Text-safe darkenings — for **text on light grounds**. All clear 4.5:1 on
**both** `--surface` and `--cream`:

| Token | Hex | Role |
|---|---|---|
| `--ink-amber` | `#3a4212` | olive as text |
| `--ink-burnt` | `#5c4033` | earth as text |
| `--ink-success` | `#2f5420` | success as text |
| `--ink-warning` | `#7a5420` | warning as text |
| `--ink-danger` | `#7a2424` | danger as text |

> **Rule.** Text **must not** use a raw brand hue on a light ground when that
> hue fails 4.5:1. Olive fill is dark enough for cream text; olive as body
> text on parchment **must** use `--ink-amber`.
>
> - Do: `color: var(--ink-amber)` on `--surface`
> - Don't: lighten olive for “soft” labels until contrast slips

> **Rule.** Fills pair one way only, measured:

| Fill | Text | Ratio (approx) |
|---|---|---|
| `--amber` | `--cream` | ≥7.7 |
| `--ink` | `--cream` | ≥12 |
| `--danger` | `#fff` / cream | ≥4.5 |
| `--burnt` | `--cream` | ≥5 |

Never invert these. Cream on olive; not olive wash behind olive text.

> **Rule.** Semantic hues carry meaning and **must not** be used decoratively:
> success = signed up / covered, warning = needs attention, danger =
> destructive or blocked.

Stage-only accents on olive night: `--amber-lift` for instrument labels;
warm earth-lift `#c4a574` for “Next” kickers (not teal).


### 2.2 Surfaces

`--bg #f7f2e8` · `--surface #fbf7ef` · `--surface-2 #f0e9db` · `--surface-3 #e6dcc8`

Text opacities on parchment (alpha-blended, must clear 4.5:1 on `--sand` too):
`--muted` at 0.70 · `--faint` at 0.64. Do not lower either without re-measuring.

Atmosphere (soft olive + earth blooms on parchment) lives on `body` and **must**
stay decorative — never the only cue for meaning.

Two grounds carry meaning:

- **`.card`** — section rhythm via hairline rules on parchment (no nested soft
  cards).
- **`.card--cream`** — reserved for related bands of content when a second
  ground is needed; default is transparent + rule.

> **Rule.** Prefer hairline sectioning over nested cards. If removing a border,
> shadow, background, or radius does not hurt understanding, it should not be a
> card.


### 2.3 Type

Scale — **12 / 14 / 16 / 20 / 24 / 32**, plus one display step:

| Token | px | Use |
|---|---|---|
| `--text-xs` | 12 | uppercase labels, hints |
| `--text-sm` | 14 | buttons, helper text, meta |
| `--text-md` | 16 | body, inputs |
| `--text-lg` | 20 | card and row titles |
| `--text-xl` | 24 | section headings / stats |
| `--text-2xl` | 32 | large stats |
| `--text-display` | 44 | masthead / stage display |

> **Rule.** New type **must** land on a step.

Face — one self-hosted family for everything (offline-first):

```
--font:         "PP Neue Montreal", ui-sans-serif, system-ui, sans-serif
--font-display: var(--font)
```

Files live in `public/fonts/` as `woff2`. Hierarchy comes from weight (often
500), size, and modest tracking — not a second family, not a CDN.

> **Rule.** Do **not** load fonts from the network. Do **not** list Inter,
> Roboto, or marketing system stacks as the primary face.

> **Rule.** Editorial kickers (`.kicker`, field labels, board instrument labels)
> use uppercase with tracking ≤ `0.08em`. Display titles around `-0.02em` to
> `-0.025em`. Wide letterspacing on body copy is out.


### 2.4 Spacing, radius, elevation, motion

Spacing — **4 / 8 / 12 / 16 / 24 / 32 / 48** as `--space-1`…`--space-7`.

Radius is **two** values, deliberately tight: `--radius: 2px`,
`--radius-lg: 4px`. No pills, no soft-glass sheets.

Shadows are off by default (`--shadow-soft` / `--shadow: none`). Presence comes
from type, olive fills, and parchment atmosphere.

Motion — intentional, few:

1. Soft `rise` entrance on `.shell` children
2. Mark hover scale
3. Button / chip color transitions and toast slide

> **Rule.** `prefers-reduced-motion` **must** collapse durations and disable
> entrance animation.

---

## 3. Component rules

### 3.1 Button `.btn`

**Anatomy:** rectangular, 1px olive border, `--text-sm`, tight radius.

**Variants:** `--primary` (olive fill, cream text — one per screen), default
outline olive, `--ghost`, `--danger`, `--quiet`, `--link`, plus sizes.

**States — all required:**

| State | Treatment |
|---|---|
| default | transparent / olive border / `--ink-amber` |
| hover | olive fill, cream text |
| focus-visible | `outline: 2px solid var(--amber); outline-offset: 2px` |
| active | slight opacity drop |
| disabled | `opacity: 0.4`, `cursor: not-allowed`, **and** the `disabled` attribute |

> **Rule.** A screen **must** have exactly one `--primary`. Secondary actions are
> outline / `--ghost` / `--quiet`.

> **Rule.** Destructive actions **must** use `--danger` or `--quiet` and **must**
> be spatially separated from the primary action.

### 3.2 Touch targets

> **Rule.** Every interactive element **must** be ≥44px tall under
> `@media (pointer: coarse)`. Enforced by element type, not by component name.

### 3.3 Card `.card`

Hairline bottom rule, no fill by default. `.card__head` holds an `h2` at
`--text-lg` weight 500 with a right-aligned `.hint`.

### 3.4 Tabs (host console)

Full ARIA tabs. Selected tab uses `--ink-amber` text and an olive underline.

### 3.5 Sign-up row `.signup-row`

Confirmed state keeps title weight and success ink — **must not** read as disabled.

### 3.6 Board rows `.callout__row`

Instrument label in `--amber-lift`, letterspaced uppercase. Names in `--cream`
at `clamp()` sizes. Away musicians: `line-through` **and** reduced opacity.

### 3.7 Empty states

Every list **must** have one that says what will fill it.

---

## 4. Accessibility — testable acceptance criteria

| # | Criterion | How to test |
|---|---|---|
| A1 | Text ≥4.5:1; large text (≥24px, or ≥18.66px at 700) ≥3:1 | sweep below, **alpha-blended** |
| A2 | Interactive elements ≥44px under `pointer: coarse` | sweep below at 375px |
| A3 | No horizontal scroll at 375px | `scrollWidth > innerWidth` |
| A4 | Visible focus on every interactive element | Tab through; `:focus-visible` global |
| A5 | Icon-only controls carry `aria-label` naming the object | `▲` → "Move Treasure up the queue" |
| A6 | Every input has a label or `aria-label` | no placeholder-only fields |
| A7 | Tabs support Arrow/Home/End with focus following | keyboard walk |
| A8 | `prefers-reduced-motion` honoured | global rule caps durations at 0.01ms |
| A9 | Body/input text ≥16px so iOS does not zoom on focus | computed style |

### The sweep

Paste into the console on each screen, at 375px and at desktop:

```js
(() => {
  const lin = c => { c/=255; return c<=0.03928 ? c/12.92 : ((c+0.055)/1.055)**2.4; };
  const L = ([r,g,b]) => 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
  const parse = s => (s.match(/[\d.]+/g)||[]).map(Number);
  const ratio = (f,b) => { const a=L(f),c=L(b); const hi=Math.max(a,c),lo=Math.min(a,c); return (hi+0.05)/(lo+0.05); };
  const bgOf = n => { for (let e=n; e; e=e.parentElement) { const c=parse(getComputedStyle(e).backgroundColor); if (c.length>=3 && (c[3]===undefined||c[3]>0.9)) return c.slice(0,3); } return [247,242,232]; };
  const flat = (col,bg) => { const a = col[3]===undefined?1:col[3]; return col.slice(0,3).map((v,i)=>Math.round(v*a+bg[i]*(1-a))); };
  const fails = [];
  for (const n of document.querySelectorAll('body *')) {
    const txt = [...n.childNodes].filter(c=>c.nodeType===3).map(c=>c.textContent.trim()).join('');
    if (!txt) continue;
    const cs = getComputedStyle(n);
    if (cs.visibility==='hidden'||cs.display==='none'||+cs.opacity<0.99) continue;
    const size = parseFloat(cs.fontSize), weight = +cs.fontWeight||400;
    const need = (size>=24 || (size>=18.66 && weight>=700)) ? 3 : 4.5;
    const bg = bgOf(n);
    const r = ratio(flat(parse(cs.color), bg), bg);
    if (r < need) fails.push(`${r.toFixed(2)}:1 (need ${need}) ${Math.round(size)}px "${txt.slice(0,30)}"`);
  }
  const small = [...document.querySelectorAll('button,a,select,[role=tab],.toggle')]
    .filter(n => { const r=n.getBoundingClientRect(); return r.width>0&&r.height>0&&r.height<44; })
    .map(n => `${Math.round(n.getBoundingClientRect().height)}px "${(n.textContent||'').trim().slice(0,20)}"`);
  return { coarse: matchMedia('(pointer: coarse)').matches,
           hScroll: document.documentElement.scrollWidth > innerWidth,
           contrast: fails.length ? fails : 'OK',
           targets: small.length ? small : 'OK' };
})()
```

> **Rule.** Any change to a surface, a text colour or a font size **must** be
> re-measured.

---

## 5. Content and tone

Plain, warm, second person. Say the thing, then say what happens next.
Never blame the reader.

| Do | Don't |
|---|---|
| "Your name goes up on the stage screen, and the host picks the band from that list." | "Submission recorded." |
| "Nobody can sign up for a request until you approve it. Declining removes it." | "Pending items require moderation." |
| "Withdrew from this song — take them off before you call it" | "Invalid lineup state" |
| "Nobody yet. Pick from the sign-ups below — tap a name to put them on." | "No data" |

---

## 6. Anti-patterns

Prohibited outright:

- **Emoji as structural icons.**
- **Raw hex or rem in components.** Use tokens (stage `clamp()` and measured
  alpha blends on the board are the known exceptions).
- **Text in a raw brand hue on a light ground** when it fails contrast.
- **Placeholder as the only label.**
- **`outline: none`** without an equally visible replacement.
- **A webfont from a CDN.**
- **`role="tab"` without the keyboard model.**
- **Colour as the only carrier of state.**
- **Auto-staffing the band.**
- **AI-slop chrome:** purple gradients, cream+terracotta cliché overload, glass
  morphism, mesh noise, pill clusters, nested soft cards, gold glow.

---

## 7. Migration notes

1. **Signal (cool stone / electric gold / teal) is retired.** Olive + parchment
   replaces it. Retired Signal fills: electric gold `#c4a000` / `#e0a800`, live
   teal `#0f766e`, cool mist grounds, board teal-lift `#5eead4`.
2. **PP Neue Montreal remains.** Self-hosted `woff2` under `/fonts`.
3. **`board.css` uses `clamp()` rather than the scale.** Intentional for TV.
4. **Cards are hairlines, not sheets.** Matches the de-slop pass; Tuscan adds
   olive and parchment without bringing chrome back.

---

## 8. QA checklist

Run in code review:

- [ ] No raw hex or raw rem in the diff; tokens only (board exceptions OK)
- [ ] Any new font-size lands on a `--text-*` step; any new gap on a `--space-*` step
- [ ] Sweep (§4) returns `contrast: OK` on all three screens
- [ ] Sweep at 375px returns `targets: OK` and `hScroll: false`
- [ ] New interactive element: default / hover / focus-visible / active / disabled
- [ ] Icon-only control has an `aria-label`
- [ ] New input has a `<label for>` or an `aria-label`
- [ ] One `--primary` per screen; destructive action visually separated
- [ ] New list has an empty state
- [ ] State is not carried by colour alone
- [ ] Checked at 375px **and** ≥1280px; board checked at 1920×1080
- [ ] `npm test` passes
