# Amplify

A sign-up queue for open jam nights.

People add their name and instruments once, then put their name down for songs
one at a time as the setlist fills in. Every sign-up goes up on the stage
screen, grouped by instrument, and **the host picks the band from that list**.
Amplify keeps the queue and shows who has played what; it does not choose
anybody.

That is deliberate. An earlier version built the lineup itself, and it did not
survive a real jam night — the room could not see why it chose what it chose,
and a host who disagreed had to fight the tool instead of running the night. A
person with the room in front of them is better at fair than a ranking function
is, so the tool's job is to give them the list and get out of the way.

```bash
node server.js
```

No install step, no dependencies, no internet. Node 18 or newer.

```
♪  Amplify — Open Jam Night

   Players sign up   http://192.168.1.24:3000/
   Host console      http://192.168.1.24:3000/host?k=6f2a…
   Stage display     http://192.168.1.24:3000/board
```

Share the sign-up link. The host console's Settings tab shows it as a QR code
you can print for the stage, and the stage display shows the same code between
songs. Keep the host link to yourself — it carries the key that unlocks the
console.

## Three screens

| Screen | Who it is for | What it does |
| --- | --- | --- |
| `/` | Musicians, on their phones | Sign in, sign up for songs, request songs |
| `/host` | Whoever is running the night | Vet requests, pick the band by hand, call the song, log it |
| `/board` | A TV or spare laptop | Sign-up code, **Now** and **Next**, and who has signed up, in room-sized type |

Everything updates live. A name added on a phone appears on the stage screen
immediately; a musician marking themselves on a break shows as struck through
on the sheet without anyone saying a word.

## Signing up, one song at a time

Signing in to the jam and signing up for a song are two separate things. You
give your name and instruments once. After that, every song on the setlist gets
its own **Sign up** button on your phone — one song per sign-up, as many songs
as you like, whenever you like. New songs appear the moment the host adds them.

If you play more than one instrument, each sign-up asks which one you want for
*that* song. Sign up for the ballad on keys and the blues on guitar; that is
what goes up beside your name. **Withdraw** takes you off a single song and
leaves your other sign-ups alone.

**Not signing up is a complete answer.** Nobody can be called for a song they
did not sign up for — the host's list *is* the sign-up sheet, and the server
refuses any pick that is not on it. If a song cannot be staffed, the chair stays
open rather than somebody being put on stage who did not put themselves there.

One thing people set for themselves: **on a break**. You stay on the sheet and
are shown struck through, so the host can see you are on the list but not in the
room this minute. It does not block a pick — it is shown to the host beside your
name, because the person weighing it is the one running the room.

## Requesting a song

Anyone signed in can **request songs**, as many as they want. A request does not
go straight onto the setlist: it waits in the host's **Songs** tab until they
approve it, and nobody can sign up for it in the meantime. The person who asked
sees it on their own phone marked *Pending*, so it never looks lost.

This is enforced server-side, not just hidden in the UI — a sign-up naming an
unapproved song is dropped, and an unapproved song cannot be put on deck.

Approving puts it on the setlist and it behaves like any other song from then
on. Declining removes it. You can take back your own request any time before
it is approved, and your own suggestion afterwards until somebody else has
signed up for it — after that it is the host's to remove, so nobody loses a song
they were counting on.

Turn all of this off with **Approve requests before they go up** if you trust
the room; anything already waiting is let through when you do.

## Picking a band

The host picks. Amplify shows the sign-up sheet and what it knows about each
person, and stays out of it.

1. **Now** → **Put on deck**. Each song shows how many people have signed up.
   The **Songs** tab is the queue: reorder with the arrows, or **Play next** to
   jump a song to the front. The top song not yet played is marked *up next*,
   which is what the stage display shows as **Next**.
2. **Tap names to put them on.** The sheet leads with whoever has waited longest
   — fewest turns tonight, then longest since they last played — and each row
   carries what you need to be fair with it: turns so far, *played the last
   song*, *on a break*. None of that stops you picking anybody. It is ordering
   and information, not a decision.
3. **Watch the coverage strip** — `Vocals 1/1 · Guitar 1/2 · Bass 0/1`. It
   counts sign-ups against the band you set in Settings, and it is advice only.
   A song with nobody on bass is still perfectly callable; you may well know the
   guitarist covers it.
4. **Call it out** — full-screen names, readable from across the room.
5. **Played ✓** logs a turn for everyone on stage. **Cancel** clears the deck
   without counting anything.

Turn counts are what you read to judge fairness, so log songs as they happen.

A pick is a snapshot. If somebody withdraws or goes on a break after you seated
them, the row flags it before the names get read out — they are not silently
dropped, because vanishing mid-selection is its own surprise.

## Settings

- **The band** — which chairs you usually want filled (2 guitars, 1 bass, 1
  drums…). A readout on the sign-up sheet, not a limit. Songs can override it.
- **Let the room request songs** — on by default.
- **Approve requests before they go up** — on by default. Off means requests
  land straight on the setlist.
- **Reset turn counts** for a second set, or **clear the night** entirely.

## Going live on Vercel

Amplify runs two ways from the same code.

**On a laptop** it is a long-lived server: state in `data/jam.json`, live
updates pushed over an event stream. Nothing to configure.

**On Vercel** there is no disk and every request may hit a fresh instance, so
it needs somewhere shared to keep the night:

1. In your Vercel project, add a Redis store — Storage → Marketplace → **Upstash
   for Redis** (`upstash/upstash-kv`), not QStash, which is a message queue and
   sets none of the variables below. Vercel fills in `KV_REST_API_URL` and
   `KV_REST_API_TOKEN`; `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
   are accepted too.
2. Set `HOST_KEY` to a secret of your choosing. Skip this and the host key is
   generated per instance, printed to a log you cannot read, and stripped from
   every response — leaving no way to open the host console.
3. Deploy. `vercel.json` is already here — no build step, no dependencies.

Amplify picks its backend from the environment: a key-value store when one is
configured, the local file otherwise. Deploy without one and the API answers
503 with an explanation rather than quietly giving each instance its own jam.

Two differences worth knowing when it is hosted:

- **Updates arrive by polling** every couple of seconds, because a serverless
  function cannot hold an event stream open. The server tells the page which
  to use, so this needs no configuration.
- **Writes are compare-and-set.** If two people sign up in the same instant,
  the second write is refused and replayed against the newer state rather than
  overwriting it. A whole room tapping at once is fine; the round trip is a
  few milliseconds longer.

A hosted deploy is on the public internet, so anyone with the link can sign up
and suggest songs. The host key still gates everything under `/api/host/*`.

## Data and privacy

On a laptop everything lives in `data/jam.json` next to the server — no
database, no accounts, no third parties. Delete the file and the night is gone.
Hosted, the same JSON lives in your key-value store under `amplify:state`.

That file holds the host key and each player's session token, so it is
gitignored; do not commit or share it. The public API never returns either: the
host key stays server-side, and player tokens are stripped from published state
so one phone cannot act as another.

Amplify has no transport security of its own. Run it on the venue's local
network, not the open internet.

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where `jam.json` is written |
| `KV_REST_API_URL` | — | Redis REST endpoint. Set it and the file store is not used |
| `KV_REST_API_TOKEN` | — | Token for that endpoint |
| `KV_PREFIX` | `amplify` | Key prefix, so two jams can share one store |
| `HOST_KEY` | — | Fixes the host key instead of generating one. Hosted deploys never print theirs, so set this to a secret you choose |

## Tests

```bash
npm test
```

Covers the sign-up reader directly — what counts as a sign-up, that nothing
reads silence as consent, coverage, and turn counts — plus API-level tests that
boot the real server and check auth, validation, vetting and a full round trip.
The key-value backend is tested against a stand-in that speaks the same REST
protocol, including eight people signing up in the same instant, so the hosted
path is exercised without needing an account.

## Layout

```
server.js            local listener — `node server.js`
api/[...path].js     the same app as a serverless function
src/app.js           routing, validation, the REST API
src/signups.js       who signed up and who may be picked — pure, no I/O
src/store.js         file and key-value backends, per-request isolation
public/js/qr.js      QR encoder, so the sign-up code works with the wifi down
public/              the three screens; no build step, no framework
DESIGN.md            tokens, component rules, the a11y sweep, QA checklist
```

## Design

`DESIGN.md` carries the visual system: the palette and why text never uses a raw
brand hue, the 12/14/16/20/24/32 type scale, the 44px touch floor, component
states, and a console sweep that checks contrast and target sizes on any screen.
Read it before changing anything visual — a restyle has already silently broken
a contrast token once.

Type is matched to Trackr: a single Apple-system stack (`-apple-system` →
SF Pro on Apple hardware) for both body and headings, with hierarchy carried by
weight and size rather than a second typeface. Everything in the stack is a
system font, so nothing here needs the network — which matters, because the app
has to work with the venue wifi down.
