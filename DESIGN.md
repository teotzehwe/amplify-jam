# Amplify — design system

**Intent:** a warm, editorial, poster-like interface for a live music night, legible
from a phone in a dim room and from a TV across that room — on the Impeccable
palette, with zero dependencies and no build step.

Rules use **must** (non-negotiable) and **should** (recommended). Every rule is
anchored to a token, a measured threshold, or an example — never to an adjective.

---

## 1. Context and goals

Three surfaces, one system:

| Surface | Read from | Ground | Job |
|---|---|---|---|
| `/` musician | a phone, held | warm paper | Put your name down |
| `/host` console | a phone or laptop, working | warm paper | Pick the band |
| `/board` stage | a TV, 3–10 m away | `--ink` | Show who is on the list |

The board inverts because a white screen projected into a dim venue is glare. It
is the only dark surface, and it sets the confidence the light surfaces aim for:
large type, high contrast, letterspaced labels, generous scale jumps.

**Non-goals.** No framework, no build step, no runtime dependency, no network
font. The app must start with `node server.js` on a laptop with no internet.

---

## 2. Design tokens and foundations

All tokens live in `public/app.css` `:root`. Components **must** reference tokens,
never raw values.

### 2.1 Palette

Brand hues — used as **fills only**:

`--amber #cc8800` (primary) · `--burnt #c55221` (secondary, section grounds)
· `--amber-lift #d39926` (lifted for the dark board) · `--cream #fdf4e3`
· `--sand #ece0c9` · `--ink #111827`

Semantic: `--success #16a34a` · `--warning #d97706` · `--danger #dc2626`

Text-safe darkenings — for **text on light grounds**. All clear 4.5:1 on
**both** `--surface` and `--cream`:

| Token | Hex | on white | on cream |
|---|---|---|---|
| `--ink-amber` | `#8a5c00` | 5.81 | 5.32 |
| `--ink-burnt` | `#a7451c` | 5.98 | 5.48 |
| `--ink-success` | `#107a37` | 5.44 | 4.98 |
| `--ink-warning` | `#a25904` | 5.29 | 4.85 |
| `--ink-danger` | `#b01e1e` | 6.88 | 6.30 |

> **Rule.** Text **must not** use a raw brand hue on a light ground. Amber as
> text is 2.96:1 on white. Use the matching `--ink-*` variant.
>
> - Do: `color: var(--ink-amber)` on `--surface`
> - Don't: `color: var(--amber)` on `--surface`

> **Rule.** Fills pair one way only, measured:
>
> | Fill | Text | Ratio |
> |---|---|---|
> | `--amber` | `--ink` | 5.99 |
> | `--burnt` | `#fff` | 4.56 |
> | `--danger` | `#fff` | 4.83 |
> | `--success` | `--ink` | 5.38 |
>
> Never invert these. White on amber is 2.96:1; ink on burnt is 3.89:1.

> **Rule.** Semantic hues carry meaning and **must not** be used decoratively:
> success = signed up / covered, warning = needs attention, danger =
> destructive or blocked.

### 2.2 Surfaces

`--bg #faf3e6` · `--surface #fffdf8` · `--surface-2 #f8f0df` · `--surface-3 #f1e6d0`

Two grounds carry meaning:

- **`.card`** (`--surface`) — the working surface. Lists you act on.
- **`.card--cream`** — a second ground that groups related sections into a band.

> **Rule.** `.card--cream` **must** be assigned by meaning, not alternated
> mechanically. Sections render conditionally, so `:nth-child` striping breaks
> the moment one is absent.
>
> - Do: both request-related sections (pending + suggest) share the cream ground
> - Don't: `.card:nth-of-type(even) { background: cream }`

### 2.3 Type

Scale — **12 / 14 / 16 / 20 / 24 / 32**, plus one display step:

| Token | px | Use |
|---|---|---|
| `--text-xs` | 12 | tags, uppercase labels, hints |
| `--text-sm` | 14 | buttons, helper text, meta |
| `--text-md` | 16 | body, inputs |
| `--text-lg` | 20 | card and row titles |
| `--text-xl` | 24 | section headings |
| `--text-2xl` | 32 | stat numbers |
| `--text-display` | 40 | the masthead headline only |

> **Rule.** New type **must** land on a step. Before this system the app used ten
> ad-hoc sizes (0.74/0.78/0.82/0.85/0.87/0.88/0.9/0.92/1.05/1.15rem) doing the
> work of five, which is a large part of why the screens read busy.
>
> - Do: `font-size: var(--text-sm)`
> - Don't: `font-size: 0.88rem`

Faces — matched to Trackr (`study-planner`), one stack for everything:

```
--font:         -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
                "Inter", "Helvetica Neue", Arial, sans-serif
--font-display: var(--font)
```

> **Rule.** There is **no** separate display face. Hierarchy comes from weight,
> size and tracking alone.
>
> - Do: `font-weight: 700` with negative tracking at `--text-lg` and above
> - Don't: introduce a second family to make a heading feel different

> **Rule.** Every entry **must** be a system font. `-apple-system` resolves to
> SF Pro on Apple hardware; `Inter` is carried for parity with Trackr but is
> never loaded by either app. Adding a face that needs the network breaks the
> offline-first rule — see §1 Non-goals.

### 2.4 Spacing, radius, elevation

Spacing — **4 / 8 / 12 / 16 / 24 / 32** as `--space-1`…`--space-6`. Same rule:
land on a step.

Radius is **two** values, deliberately: `--radius: 10px` for controls,
`--radius-lg: 18px` for sheets. A single 12px everywhere made a chip, a button
and a card read at the same level.

Shadows carry brown, not neutral black, so they sit *in* the paper:
`--shadow-soft` for cards, `--shadow` for lifted things (toasts).

---

## 3. Component rules

### 3.1 Button `.btn`

**Anatomy:** pill, 1px border, `--text-sm`, `--radius: 999px`.

**Variants:** `--primary` (amber fill, ink text — one per screen),
`--ghost`, `--danger`, `--quiet` (destructive, de-emphasised), `--link`,
plus sizes `--lg`, `--sm`, `--icon`, `--block`.

**States — all required:**

| State | Treatment |
|---|---|
| default | `--surface` / token border |
| hover | inverts to `--ink` on `#fff` |
| focus-visible | `outline: 2px solid var(--amber); outline-offset: 2px` |
| active | `transform: translateY(1px)` |
| disabled | `opacity: 0.4`, `cursor: not-allowed`, **and** the `disabled` attribute |

> **Rule.** A screen **must** have exactly one `--primary`. Secondary actions are
> `--ghost` or `--quiet`.

> **Rule.** Destructive actions **must** use `--danger` or `--quiet` and **must**
> be spatially separated from the primary action.

### 3.2 Touch targets

> **Rule.** Every interactive element **must** be ≥44px tall under
> `@media (pointer: coarse)`. Enforced by element type, not by component name:
>
> ```css
> @media (pointer: coarse) {
>   select, input, .toggle { min-height: 44px; }
>   .btn--sm { min-height: 44px; … }
>   .btn--icon { width: 44px; height: 44px; }
>   .btn--link { min-height: 44px; }
>   .tabs button { min-height: 44px; }
> }
> ```
>
> Covering element types is what makes the floor survive a restyle — a local
> `padding` override on a `select` silently took it to 39px once already.

Compact sizes are permitted under a fine pointer. `.chip` is 44px at all widths
because it is the first control every musician touches.

### 3.3 Card `.card`

`--space-5` padding, `--radius-lg`, `--shadow-soft`, 1px `--line`.
`.card__head` holds an `h2` at `--text-lg` with a right-aligned `.hint` that drops
to its own line below 520px.

### 3.4 Tabs (host console)

Full ARIA tabs, not buttons wearing tab roles.

> **Rule.** If `role="tab"` is present, the pattern **must** be complete:
> roving `tabindex` (one stop for the strip), `aria-controls` → a real
> `role="tabpanel"`, `aria-labelledby` back, and Arrow/Home/End with focus
> following selection.
>
> Announcing tabs without arrow-key support is worse than plain buttons: it
> promises a keyboard model that then fails.

Below 400px, horizontal padding tightens so all four fit without scrolling —
primary navigation must not require dragging to discover.

### 3.5 Sign-up row `.signup-row`

Confirmed state uses a warm fill, a `--ink-success` inset edge and an accent title.

> **Rule.** A confirmed state **must not** read as disabled. The original
> blue-grey wash on warm paper looked greyed-out — the wrong feeling for
> "you're on for this one".

### 3.6 Board rows `.callout__row`

Instrument label in `--amber-lift`, letterspaced uppercase, fixed min-width. Names in
`--cream` at `clamp()` sizes so they scale with the screen rather than a
breakpoint.

Away musicians: `line-through` **and** reduced opacity.

> **Rule.** State **must not** be carried by colour alone. The strike-through is
> what conveys "on a break"; the dimming is reinforcement.

### 3.7 Empty states

Every list **must** have one, and it **must** say what will fill it — a jam
starts empty, so this is a normal state, not an error. Solid border, not dashed.

- Do: *"Nobody yet — scan the code and add your name"*
- Don't: a blank panel, or a dashed box that reads as a validation failure

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
  const bgOf = n => { for (let e=n; e; e=e.parentElement) { const c=parse(getComputedStyle(e).backgroundColor); if (c.length>=3 && (c[3]===undefined||c[3]>0.9)) return c.slice(0,3); } return [255,255,255]; };
  // Blending the text colour's own alpha matters: skip it and every rgba()
  // colour reports as fully opaque, hiding real failures on the board.
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
> re-measured. `--faint` passed at 4.59:1 on white and slipped to 4.46:1 the
> moment sections gained a cream ground — a restyle silently broke a token that
> had been correct.

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

> **Rule.** Labels **must** be unambiguous even when short. "Turns tonight" and
> "Songs played" are kept at full length and given a uniform two-line box rather
> than shortened to "Turns" and "Songs", which would blur whose count is whose.

> **Rule.** Error text **must** state the cause and the recovery.
> *"Mei Lin did not sign up for this song"* — not *"Forbidden"*.

---

## 6. Anti-patterns

Prohibited outright:

- **Emoji as structural icons.** Font-dependent, untintable, inconsistent across
  platforms. (Emoji in `<link rel="icon">` data-URIs is fine — that is a favicon,
  not UI.)
- **Raw hex or rem in components.** Use tokens.
- **Text in a raw brand hue on a light ground.** See §2.1.
- **Placeholder as the only label.**
- **`outline: none`** without an equally visible replacement.
- **A webfont from a CDN.** Breaks the offline-first requirement. Self-hosting a
  file is the only acceptable route.
- **`role="tab"` without the keyboard model.** See §3.4.
- **Colour as the only carrier of state.**
- **Auto-staffing the band.** Out of scope for design, but the rule the product
  exists to keep: see `HANDOFF.md`.

---

## 7. Migration notes

Existing UI predating this system:

1. **Off-scale sizes** — all converted; `body { font-size: 16px }` is the only
   raw value left, and it is the root definition.
2. **Aileron is gone.** It was referenced in `--font` with no `@font-face` and
   no font file, so it never resolved on any machine. Dropped when the stack was
   matched to Trackr. `--font-display` no longer names a condensed face either.
3. **`board.css` uses `clamp()` rather than the scale.** Intentional: the stage
   display scales with viewport, not breakpoints. Keep it that way.
4. **Impeccable's palette is adopted in full; Chakra Petch is not.** The face
   needs a network font or a vendored binary, both of which conflict with
   offline-first, so the Trackr system stack stands in. If Chakra Petch is
   ever wanted, self-host a `woff2` and set `--font-display` — do not add a CDN.
5. **The amplifyforyouth.cc palette is gone.** Retired tokens: `--coral`,
   `--orange`, `--honey`, `--lavender`, `--dusty-blue`, `--near-black`,
   `--ink-coral`, `--ink-blue`, `--ink-plum`, `--ink-honey`. Anything still
   referencing them is dead code.

---

## 8. QA checklist

Run in code review:

- [ ] No raw hex or raw rem in the diff; tokens only
- [ ] Any new font-size lands on a `--text-*` step; any new gap on a `--space-*` step
- [ ] Sweep (§4) returns `contrast: OK` on all three screens, light and dark grounds
- [ ] Sweep at 375px returns `targets: OK` and `hScroll: false`
- [ ] New interactive element: default / hover / focus-visible / active / disabled all defined
- [ ] Icon-only control has an `aria-label` naming its object
- [ ] New input has a `<label for>` or an `aria-label`
- [ ] One `--primary` per screen; destructive action visually separated
- [ ] New list has an empty state saying what will fill it
- [ ] State is not carried by colour alone
- [ ] Checked at 375px **and** ≥1280px; board checked at 1920×1080
- [ ] `npm test` passes
