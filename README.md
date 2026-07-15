# Arsmi Games — Web SDK reference

A complete, working integration of the Arsmi Games platform in a real HTML/JS game.

It is the same Kids Quiz the [Unity package](https://github.com/Arsmi-17/ArsmiGames_SDK)
ships as a sample, so you can put the two side by side: the platform contract is identical,
only the language changes.

```bash
git clone https://github.com/Arsmi-17/ArsmiGames_WebSDK.git
cd ArsmiGames_WebSDK
npx serve .          # or any static server
```

Open it and it plays. There is no build step, no bundler, and no dependency — it is
`<script type="module">` and three files.

## Read these three files, in this order

| File | What it is |
|---|---|
| **`src/platform.js`** | **Every line of platform integration in the project.** Start here. |
| `src/save.js` | One save API over the three published save modes. |
| `src/quiz.js` | The game. Knows nothing about postMessage. Throw this away. |

That separation is the thing to copy. When you port this into your own game, you keep
`platform.js` and `save.js`, and `quiz.js` becomes your game.

## Loading the SDK

```html
<script src="/sdk/gamehub-sdk.js"></script>
<script>
  if (!window.GameHubSDK) {
    document.write('<script src="gamehub-sdk.js"><\/script>');
  }
</script>
```

Two sources, and the order is the whole trick:

1. **`/sdk/gamehub-sdk.js`** — the platform's own copy, always current. The path is
   **absolute**, so it only resolves when the platform is the one serving your game.
2. **`gamehub-sdk.js`** — the copy next to your `index.html`. Needed because a game hosted
   *anywhere else* (a static host, Cloudflare Pages, `file://`) resolves that absolute path
   against **that** host and gets a 404.

`document.write` is deliberate. It is synchronous, so the SDK is defined before your modules
run. "Eventually loaded" is not good enough — the game asks the bridge a question on its
first frame, and if the SDK is not there yet, that call is a silent no-op.

**Ship the fallback copy.** A game with no SDK on the page still loads, still renders, and
still looks completely fine — and cannot reach the platform at all, in either direction, with
no error anywhere. It is a failure with no symptom except silence.

## The two rules

**1. The game must run with no platform at all.** Open `index.html` from the filesystem and
it plays. Every call in `platform.js` is guarded (`sdk?.…`), and none of them block the first
frame. A game that waits for the platform before drawing shows a black screen when the
platform is slow — and shows it forever when there is no platform.

**2. The platform is authoritative about anything worth cheating for.** The wallet balance,
whether an ad was watched, whether your save is current. The game asks and waits. It never
decides.

## Connecting

```js
await Platform.connect();     // resolves when the platform hands over the player's save
```

`init()` resolves immediately with `{}` when there is no platform, so a standalone build does
not hang — which is exactly what would happen if you awaited a message that never arrives.

Declare your leaderboard **after** the handshake. Before it, you are
shouting into a void: there is nobody on the other end of the bridge yet.

## The contract, function by function

Every function is one or both of two directions: the **platform sends** your game something and
expects it honoured, or your **game sends** the platform something. Some checks are required to
publish; the rest you use only if the feature applies.

The platform proves a game handles an inbound message by sending it a real one and waiting for
the SDK's **acknowledgement**. For the inbound checks (mute, fullscreen), *subscribing* is what
acks "handled" — a game that never subscribes is reported as not handling it. Silence never
counts as a pass.

| Function | Publish? | Platform → game (you must) | Game → platform (you may) |
|---|---|---|---|
| **Handshake** | **Required** | `bridge:init` → the SDK auto-replies `bridge:ready` and reports capabilities. Just load the SDK. | — |
| **Mute** | **Required** | `set_mute` → zero **all** audio channels. Ack is automatic once you call `onMute`. | `setMuted(true)` when your own sliders all reach 0; `false` when any rises. Skip if you have no volume UI. |
| **Fullscreen** | **Required** | `set_fullscreen` → ack by subscribing `on("set_fullscreen", …)`; re-fit a fixed canvas. | `requestPlatformFullscreen()` — **only** if your game already has a fullscreen button. Do not add one. |
| **Identity** | Required for **own-backend** save | `user.onChange(({ playerId }) => …)` → key your saves on `playerId`. | `user.get()` to ask for it. |
| **Save (Platform)** | Required if published **Platform save** | `data.onChange` → re-read the save, do not keep stale values. | `data.setItem/getItem/clear`. **Never store currency in a save** — it is on the player's machine and editable. |
| **Wallet (Flux)** | Only if you sell for Flux | `wallet.onChange(balance => …)` → update your HUD. | `wallet.get()` to read; `wallet.spend(n, reason)` to spend, and wait for `ok` before granting. **A game cannot earn Flux** — `wallet.set/add/earn` are refused before they leave the iframe. |
| **Rewarded ad** | Optional | The overlay is drawn by the platform; the resolved result carries `rewarded: true/false`. | `await ads.showRewarded({ … })`. Grant **your own** reward only on `rewarded: true`. **An ad pays no Flux.** |
| **Leaderboard** | Optional | `leaderboard.onSharing(({ enabled }) => …)` → show/hide your share button. | `leaderboard.define(boards)` **first**, then `submitScore({ metricKey, score })` against a declared key. |
| **Achievements** | — | — | **Removed.** No manifest, no progress, **no Flux reward.** Track them in your own game and currency. |

The rest of this file is that table in detail, one section per row.

## Save data — the three modes

These are the three answers to *"Does your game save progress?"* in the publish wizard. A
real game picks one; the demo switches at runtime so you can watch the same game code behave
correctly under all three.

**The local copy is authoritative for reads, in every mode.** The game reads synchronously
and never waits on a network. A slow connection can delay a *sync*; it can never stall
gameplay.

### 1. Local only
`localStorage`, nothing else. Progress dies with the browser profile.

### 2. Platform (local + cloud mirror) — the usual choice
You keep saving locally exactly as you do today. The SDK **also** mirrors the map to the
player's account, so their progress follows them to another device.

```js
const level = Platform.getInt("level", 1);
Platform.setItem("level", 7);        // batched — one write, ~1s later
```

Writes are coalesced, and force-flushed when the tab is hidden or closed, so closing the tab
does not cost the player their last few seconds.

**`data.onChange` is not optional.** It fires when the platform *replaces* your values —
after a guest signs in and their progress is merged into their account, or when the player's
**other device** turns out to be further ahead. You must **re-read**, not keep what you had.
Keeping your copy rolls the player backwards, and they have no idea why.

Guests can play and save without logging in. Their progress is held by the platform and
merged into their account if they sign up; on a conflicting key the account's value wins, so
a throwaway guest session can never clobber a real save.

### 3. Your own backend
The platform stores nothing. It only tells you **who the player is**:

```js
const playerId = Platform.state.playerId;   // null for guests
```

`playerId` is pseudonymous and **per game**: stable forever for this player in this game, but
two games cannot compare ids to work out they have the same person. Key your records on it.
Never use the raw platform user id.

`createBackend()` in `save.js` is a worked example against Supabase. Swap its two `fetch`
calls for your own endpoints and nothing else in the game changes.

> The anon key is public by design, and the demo table's RLS lets anyone holding it read and
> write any row. That is fine for a quiz score keyed by an id that identifies nobody, and
> **not** fine for anything else. A real backend verifies the player server-side rather than
> letting the browser talk to Postgres directly.

To try it: run `supabase/demo_quiz_backend_schema.sql`, then set the credentials and pick
**Own backend**:

```js
localStorage.setItem("arsmi.demo.supabaseUrl", "https://xxx.supabase.co");
localStorage.setItem("arsmi.demo.supabaseAnonKey", "ey…");
```

## Wallet

The balance is whatever the **server** says it is. Read it, and ask to spend from it.

```js
const result = await Platform.spend(5, "quiz-hint");
if (result.ok) giveHint();               // ONLY here
else showMessage(result.error);          // "Not enough Flux Coins."
```

**Do not hand over what the player is buying until `spend()` resolves `ok`.** The server can
refuse — a game that grants first and reconciles later is a game that gives things away.

**There is no "give the player coins" call, and there will not be one.** `wallet.set()` has
been removed — it wrote an absolute balance and was trusted as-is, so any game could mint
unlimited currency with one line. The SDK now refuses to send the message at all:
`sdk.emit("gamehub:wallet:set", …)` is rejected before it leaves your iframe.

Flux Coins go up in three places, none of them a game: the player **buys** them, the player
watches **the platform's own ad** from the platform's UI.

If your game has its own currency — coins, gems, lives — that is yours to grant however you
like. It does not convert to Flux.

**Never put currency in a save.** Save data lives on the player's machine and is trusted as
written — they can edit it.

## Rewarded ads

The ad is a **platform overlay**, drawn over your game. Your game does not render it, does
not time it, and does not decide whether it was watched — a game cannot be trusted to report
that, so the decision stays outside the iframe.

**An ad your game asks for pays no Flux Coins.** It pays whatever *your* game promised — the
hint below, an extra life, a skin — and *your* code grants it when `rewarded` is true.

```js
paused = true;
Platform.setMuted(true);                 // the platform mutes the FRAME; it does not pause YOU

const { rewarded } = await Platform.showRewardedAd("quiz-hint");

paused = false;
Platform.setMuted(false);
if (rewarded) giveHint();                // ONLY here
```

`rewarded: false` means the player skipped it or it failed. **Grant nothing.** Test that path
— skip the ad — because it is the one people forget.

## Achievements

**The platform does not have achievements.** The feature was removed: there is no
`sdk.achievements` object, no manifest to send, and no progress to report. The SDK refuses
`gamehub:achievements:manifest` and `gamehub:achievement:progress` outright — they never leave
your iframe, and you get an error in your console naming the event.

Track achievements **inside your own game**, and reward the player in **your own currency**.
That was already the only thing a game's achievements could do — they were never worth any Flux
Coins — so for most games this changes nothing but where the code lives.

## Leaderboards

Optional — a game with no ranking does not need this. But if you use it, two rules decide
whether it works, and both fail silently.

```js
// 1. DECLARE your boards once, at startup, before any score.
sdk.leaderboard.define({
  boards: [{ metricKey: "quiz_score", metricLabel: "Quiz score", sortDirection: "desc" }],
});

// 2. SUBMIT against a metricKey you declared.
sdk.leaderboard.submitScore({ metricKey: "quiz_score", score: 120 });
```

**Requirement — define before you submit.** A score whose `metricKey` matches no declared
board is **dropped**, and nothing errors. The game goes on submitting into nothing and finds
out never. Declare every board once at startup; then submit as often as you like.

**Requirement — a submit is a "best", not a "set".** The platform keeps the player's best
score for each board's `sortDirection` (`desc` = higher wins, `asc` = lower/faster wins). A
submit only replaces the stored value when it **beats** it. A game that reads its own last
submit back as "the score" will disagree with the platform, which kept the higher earlier one.

**Acknowledgement.** `define` and `submitScore` are outbound — the platform acks each one, and
a misspelt `metricKey` on submit is the one that silently drops, so keep the key identical to
what you declared.

**Platform → game — sharing.** The platform tells you whether its "share your score" UI is
switched on for this embed. Subscribe if you want to show or hide your own share affordance to
match; ignore it otherwise:

```js
sdk.leaderboard.onSharing(({ enabled }) => { shareButton.hidden = !enabled; });
```

You never need `onSharing` to *submit* scores — it only governs a share button, if you have
one.

## Mute

Two-way, and both directions matter. **Your game does not need a mute button** — the platform
provides one. Your job is only to make its button real, and to keep it honest if you have
volume controls of your own.

### Platform → game: silence *everything*

When the platform mutes you, drop **every** audio channel to zero — music, SFX, ambience,
voice, UI clicks, all of it. "Mute" means the player hears nothing, not "the background music
stops but the explosions do not."

```js
sdk.onMute(({ muted }) => {
  // One master tap that every channel passes through — the simplest correct answer.
  masterGain.gain.value = muted ? 0 : savedVolume;
});
```

If your audio does not run through one node, mute each channel by hand — but mute **all** of
them, or the platform's button is a lie:

```js
sdk.onMute(({ muted }) => {
  const level = muted ? 0 : 1;
  musicGain.gain.value   = level * musicVolume;
  sfxGain.gain.value     = level * sfxVolume;
  ambienceGain.gain.value = level * ambienceVolume;
  // …every channel you have. Missing one is the bug this catches.
});
```

The SDK acks the platform's probe for you the moment you call `onMute`, so a game that wires
this up passes the mute check. A game that never calls `onMute` fails it — silence is not
evidence that mute works.

### Game → platform: report when *you* go silent

If your game has its own volume sliders — a music slider, an SFX slider — then **all of them at
zero is the player muting the game**, and the platform's speaker icon should reflect it.
Whenever a slider moves, tell the platform whether everything is now silent:

```js
function onVolumeChanged() {
  const allSilent = musicVolume === 0 && sfxVolume === 0 && ambienceVolume === 0;
  sdk.setMuted(allSilent);   // true when every channel is 0, false as soon as one is raised
}
```

You do not need to guard against spamming this — the SDK drops no-op updates, so calling
`setMuted(false)` twice, or on every slider tick, sends nothing the second time and cannot
ping-pong against the platform's own `set_mute`.

If your game has **no** volume controls, you can skip this direction entirely. Honouring
`onMute` is the only part that is mandatory.

## Fullscreen

**Your game does not need a fullscreen button** — the platform provides one, and clicking it
resizes the frame around your game. All you have to do is *acknowledge* that you heard it:

```js
sdk.on("set_fullscreen", ({ fullscreen }) => {
  // Acknowledged just by subscribing. Nothing else is required.
});
```

Subscribing is what makes the fullscreen check pass — it proves your game is listening, rather
than the platform resizing a frame that will never know it changed.

If your game renders to a fixed-size canvas and needs to re-fit when the frame changes shape,
this is where you do it:

```js
sdk.on("set_fullscreen", ({ fullscreen }) => {
  resizeCanvasToWindow();   // only if your layout is not already CSS-fluid
});
```

A game whose canvas is already `width: 100%; height: 100%` needs no body here at all — the
empty subscription above is enough.

### If your game *has* its own fullscreen button

Then wire it to the platform — do **not** call the browser's `requestFullscreen()` yourself.
Your game is in an iframe; only the platform can size the frame correctly, and doing it
yourself fights its chrome:

```js
myFullscreenButton.onclick = () => sdk.requestPlatformFullscreen();
```

The platform enters fullscreen and then sends you a `set_fullscreen` back — so the same
handler above runs, and your button and the platform's button behave identically. **If your
game has no fullscreen button, do not add one for this** — the platform already provides one.
Acknowledging `set_fullscreen` is all that is required.

## Preview mode

```js
sdk.onContext(({ preview }) => { … });
```

`preview: true` means the dashboard or admin is previewing your game. Nothing persists, and
the user is a **test** user — do not treat them as a real player, and do not write anything
you would not want to undo.

## Testing it

**SDK Assessment** (admin or dashboard) speaks the same bridge protocol the real game window
does. Point it at your game's URL, and it shows you the leaderboard, wallet and
save your game actually produced — not just the traffic. It also catches the silent failures:
a manifest the importer would drop, a score submitted to a board you never declared, a save
key that never moves.

## Publish checklist

- [ ] The SDK loads, with the local fallback copy shipped next to `index.html`.
- [ ] The game runs with no platform at all, and does not block on one.
- [ ] `onMute` silences **every** audio channel, not just some; `setMuted` is sent when the game's own sliders all reach zero.
- [ ] `set_fullscreen` is subscribed to (acknowledged), even if the body is empty.
- [ ] `data.onChange` re-reads the save rather than keeping the old values.
- [ ] Rewarded ads grant **only** on `rewarded: true`, and the skip path is tested.
- [ ] Wallet uses `spend()`, and grants nothing until it resolves `ok`.
- [ ] Preview mode writes nothing permanent.
