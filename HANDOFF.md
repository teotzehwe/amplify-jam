# Amplify — handoff

Written for whoever picks this up next, human or agent. The README covers what
the software does and how to run it; this covers **why it is the way it is**,
what is deliberately unfinished, and what not to break.

---

## Where things are

- **Repo:** `teotzehwe/amplify`
- **Branch:** `claude/jam-signup-queue-ocvyrw` — all work is here, not on the
  default branch. There is no open PR.

```bash
git clone https://github.com/teotzehwe/amplify
cd amplify && node server.js     # no install step, no dependencies
npm test                          # 69 tests
```

Read the commit messages before the code. They carry the reasoning for every
non-obvious decision, including two concurrency bugs and why the QR encoder is
hand-written.

---

## What it is, in one paragraph

Open jam nights: musicians sign up from their phones, their names go up on a TV,
and the host picks each band off that list by hand. Three screens off one
server — `/` for musicians, `/host` for whoever runs the night, `/board` for the
TV. Sign in once with your name and instruments; then each song has its own
sign-up button, one song per submission. Songs the room requests wait for the
host before anyone can sign up for them. The host reorders the queue, puts a
song on deck, taps names onto it, calls it out, marks it played.

---

## The rule that must not be broken

**Nobody is called for a song they did not sign up for.** Not to fill an empty
chair, not to staff a half-empty band, not by the host adding someone by hand.
If a song cannot be staffed, the chair stays open.

This used to be a check inside a scheduler (`hardBlock()`). It is now
structural: a lineup is built only by tapping names on the sign-up sheet, and
`POST /api/host/pick` refuses any player whose `stances[songId]` is not `'in'`.
The refusal lives in `src/app.js`, not in the console, so no future screen and
no stray API call can volunteer somebody. `mayPlay()` in `src/signups.js` is the
predicate; `test/signups.test.js` and `test/api.test.js` both pin it.

It is the whole point of the tool. The organisation it was built for
(amplifyforyouth.cc) runs on "you don't have to be the best to belong", and a
tool that quietly volunteers people undermines exactly that. It is also the
first thing that gets dropped when someone optimises for "efficiency" — an
auto-fill for empty chairs, a default-everyone-in setting. **Do not add those.**
If a future requirement seems to need it, push back before implementing.

There is no longer a softening of any kind. The old rest-gap exception is gone
with the scheduler that needed it.

---

## Why the scheduler was removed

The first version built the band itself: a ranking engine over consent, rest
gaps, scarcity, per-instrument fairness and a repair pass, with ~350 lines of
tests behind it. It worked as specified. It was taken out anyway, after the tool
was used at a real jam night, for two reasons that no amount of tuning fixes:

- **The room could not see why it chose what it chose.** Every pick carried a
  printed reason and it still read as arbitrary from the floor. Fairness people
  cannot audit does not feel like fairness.
- **A host who disagreed had to fight it.** Overriding one chair reshuffled the
  others. The person with the whole room in front of them — who knows who just
  arrived, who is nervous, who has been waiting all night — was arguing with a
  ranking function instead of running their night.

What replaced it is smaller on purpose: `src/signups.js` reads the sheet, orders
it longest-wait-first as a *suggestion to the eye*, and counts turns. Nothing
downstream acts on that order.

**Do not reintroduce automatic staffing.** If it comes back it will come back as
"just a suggested lineup the host can edit", which is the same thing with an
extra step. The old engine is in git history at `a8c2779` if it is ever genuinely
wanted back.

The retired settings (`restSongs`, `maxConsecutive`, `maybeCountsAsAvailable`)
are stripped from state on load — see `RETIRED_SETTINGS` in `src/store.js`.
`maybeCountsAsAvailable` in particular was the switch that could turn sign-ups
into decoration; it no longer exists in any form.

---

## Architecture

```
server.js            local listener — `node server.js`
api/[...path].js     the same app as a serverless function (Vercel)
src/app.js           routing, validation, REST API
src/signups.js       who signed up, who may be picked — pure functions, no I/O
src/store.js         file + key-value backends, per-request isolation
public/js/qr.js      QR encoder (no dependencies, works offline)
public/              three screens; no build step, no framework
test/                signups, API, QR, key-value backend, host key
```

**Zero dependencies, on purpose.** A jam night should start with `node
server.js` on whatever laptop is nearest, with no install and no internet.
Adding a dependency is a real decision, not a convenience — weigh it.

### Two ways it runs

| | Laptop | Vercel |
|---|---|---|
| State | `data/jam.json` | Redis blob at `amplify:state` |
| Updates | server-sent events | polling, ~2.5s |
| Writes | direct | compare-and-set with replay |

The backend is chosen from the environment: set `KV_REST_API_URL` and
`KV_REST_API_TOKEN` and it uses the key-value store, otherwise the file. Deploy
to Vercel *without* those and the API returns 503 explaining why, rather than
giving each serverless instance its own private jam.

---

## Decisions worth knowing before you change things

**Per-request state isolation (`src/store.js`).** Each request gets its own
view of the night through `AsyncLocalStorage`. This is not decoration. Holding
the loaded state on the shared store instance meant two concurrent requests
overwrote each other's snapshot between load and save — both sign-ups returned
200, one silently vanished. If you refactor the store, keep the isolation.

**One `MGET`, not two `GET`s.** State and version must be read atomically. Read
separately, a writer landing between them hands you an old state carrying a new
version number, whose compare-and-set then passes and clobbers the newer write.
Same class of silent loss. The comment in `load()` says so; do not "simplify" it
back into two round trips.

**A sign-up is an explicit `'in'` and nothing else.** The `stances` field still
holds three values for storage compatibility, but only `'in'` is read. The old
`unknownStance` fallback — which let *silence* be interpreted — is gone. If you
are tempted to collapse `stances` into a boolean, that is a fine change; just
migrate the field rather than reinterpreting it.

**Vetting is server-side.** `onlyPlayable()` in `src/app.js` filters sign-ups
against approved songs on both join and patch, and `/api/host/lineup` refuses an
unapproved song. Hiding pending songs in the UI alone would leave the API open.

**Turn counts are advisory now.** `commitRound()` still tracks plays, streaks
and per-instrument tallies, but nothing consumes them except the host's eyes.
Keep them accurate anyway — they are the only fairness signal left.

**"Up next" is derived, not stored.** It is the first *approved* song not yet
played and not on deck. That keeps it correct when a song is called out of
order, replayed, or the queue is reordered mid-song. Resist adding a stored
pointer.

**The QR encoder is hand-written** (`public/js/qr.js`, byte mode, EC level M,
versions 1–10). Every QR service needs internet, and the wifi going down is
exactly when people still need to get on the list. It was verified by decoding
its output with an independent library across versions 1, 2, 3, 5, 7, 9 and 10
plus UTF-8, and by decoding it back out of real browser screenshots. What is
committed is that verified output as fixtures — `test/qr.test.js` — because the
decoder is not a dependency. **If a fixture breaks, the symbol changed and needs
re-verifying against a real scanner, not updating to match.**

**The stage display is dark; everything else is light.** The palette is the
Impeccable design system — amber primary, burnt orange as a section ground,
cream and warm paper — and it replaced the amplifyforyouth.cc palette wholesale.
Two rules hold it together, both measured: brand hues are fills only (amber as
text is 2.96:1 on white, so text uses the darkened `--ink-*` variants), and
fills pair one way only — ink on amber, white on burnt. The board inverts to ink
and cream (16.2:1) because a white screen projected into a dim venue is glare.
`DESIGN.md` carries the full system and a console sweep that re-checks it; run
it after any visual change, because a restyle has already broken a contrast
token twice.

---

## Known gaps and deliberate omissions

- **Fairness is now a human's job.** That is the point, but it means the tool
  cannot stop an inattentive host calling the same four people all night. The
  mitigation is information: turn counts, last-played, and longest-wait-first
  ordering on every row. If someone asks for a warning when the spread gets
  lopsided, that is a reasonable thing to add — a nudge, not a veto.
- **No jam code on the public URL.** Anyone with the link can sign up and
  request songs; this was an explicit choice, not an oversight. The host key
  still gates everything under `/api/host/*`.
- **No transport security of its own.** Fine behind HTTPS on Vercel. On a
  laptop, run it on the venue LAN, not the open internet.
- **Single event per deployment.** State is one blob under one key. Multi-event
  would start at `KV_PREFIX`.
- **Vocabulary is hardcoded** — "song", "instrument", "jam". Adapting to
  another domain means a vocabulary layer plus renaming those fields.
- **Turn counts reset each night.** No season-long fairness.
- **A declined request is gone, with no note to whoever asked.** They see it
  disappear from their pending list. A one-line reason would be kinder.
- **The Vercel deployment has not been run in production yet.** The hosted path
  is tested against a stand-in speaking the real Upstash REST protocol, and
  driven end-to-end in a browser, but nobody has yet pointed it at a live Redis.

---

## Testing

```bash
npm test
```

- `test/signups.test.js` — the sign-up reader directly: what counts as a
  sign-up, that silence never does, caps and breaks informing rather than
  blocking, coverage, turn counts and streaks.
- `test/api.test.js` — boots the real server; auth, validation, vetting, the
  refusal to seat anyone who did not sign up, round trips.
- `test/kv.test.js` — the hosted path against a stand-in speaking the Upstash
  REST protocol, including the compare-and-set script. **The eight-simultaneous-
  sign-ups test is the one that found both concurrency bugs. Keep it.** It is
  probabilistic; if you touch the store, run it 10+ times, not once.
- `test/qr.test.js` — verified fixtures plus the format's structural rules.
- `test/hostkey.test.js` — `HOST_KEY` overriding stored and generated keys.

`api.test.js` and `hostkey.test.js` each pick a random port (3400–3799 and
3900–4199). They run in parallel and occasionally collide with each other or
with something already listening, which shows up as a `fetch failed`. Re-run
before investigating.

Browser verification was done against a real Chromium: sign-up, request,
approve, put on deck, pick a band, withdraw-while-seated, commit, and the stage
display in each state. Those scripts were throwaway and are not committed;
rebuild as needed.

---

## A note on how this was built

Every non-trivial claim in the commit history was verified rather than asserted:
the QR codes were decoded, the concurrency fixes were run repeatedly to catch a
flake, the consent refusal was exercised over the wire and not just unit-tested.
Two bugs in this codebase were found only because a test pushed eight writers at
one key at the same instant. If you extend the store, keep that habit — the
failure mode there is silent and looks like "the app randomly forgets people".

And the biggest change so far — deleting a working, well-tested scheduler —
came from watching the thing run in a room, not from reading the code. Weight
that kind of evidence accordingly.
