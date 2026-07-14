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

Declare your achievements and leaderboard **after** the handshake. Before it, you are
shouting into a void: there is nobody on the other end of the bridge yet.

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

Coins are **earned** through rewarded ads and achievement claims, both of which the platform
grants after it has *seen* the thing happen. There is no "give the player coins" call, and
there will not be one.

`wallet.set()` still exists and is **deprecated**: it writes an absolute balance and is
trusted as-is, so a game can mint currency with it.

**Never put currency in a save.** Save data lives on the player's machine and is trusted as
written — they can edit it.

## Rewarded ads

The ad is a **platform overlay**, drawn over your game. Your game does not render it, does
not time it, and does not decide whether it was watched — the reward is real currency, so
that call stays outside the iframe.

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

```js
sdk.achievements.define({
  achievements: [{
    key: "quiz_first_correct",
    title: "Bright spark",
    metric: "quiz_correct",
    target: 1,
    rewardFlux: 10,             // must be > 0
    type: "daily",
    shareWithPlatform: true,    // must be true
  }],
});

Platform.achievementProgress("quiz_correct", 1);
```

**Every field is load-bearing.** The platform's importer **skips** any entry missing one —
silently, with no error and no log line. An achievement without `rewardFlux`, or without
`shareWithPlatform: true`, simply never comes into existence, and your game has no way to
find out. Those two are the ones everybody forgets.

The `metric` you pass to `progress()` must match a manifest entry's `metric` **exactly**, or
it counts towards nothing.

Check your manifest in **SDK Assessment** (admin/dashboard): it validates against the real
importer's rules and lists exactly what would be thrown away.

## Leaderboards

```js
sdk.leaderboard.define({
  boards: [{ metricKey: "quiz_score", metricLabel: "Quiz score", sortDirection: "desc" }],
});
sdk.leaderboard.submitScore({ metricKey: "quiz_score", score: 120 });
```

A submit only replaces the stored score when it **beats** it, for that board's sort direction.
The platform keeps the player's best. A game that assumes every submit overwrites will
disagree with the platform about what the player's score is.

## Mute

Two-way, and both directions matter.

```js
sdk.onMute(({ muted, source }) => { audio.muted = muted; });
sdk.setMuted(true);      // the game muted itself; the platform's volume icon follows
```

You **must** honour the platform's `set_mute`, or its volume button is a lie. And you must
send `audio_muted` when the game mutes itself, or the platform shows a speaker icon while the
player hears nothing. The SDK drops no-op updates, so this cannot ping-pong.

## Preview mode

```js
sdk.onContext(({ preview }) => { … });
```

`preview: true` means the dashboard or admin is previewing your game. Nothing persists, and
the user is a **test** user — do not treat them as a real player, and do not write anything
you would not want to undo.

## Testing it

**SDK Assessment** (admin or dashboard) speaks the same bridge protocol the real game window
does. Point it at your game's URL, and it shows you the leaderboard, achievements, wallet and
save your game actually produced — not just the traffic. It also catches the silent failures:
a manifest the importer would drop, a score submitted to a board you never declared, a save
key that never moves.

## Publish checklist

- [ ] The SDK loads, with the local fallback copy shipped next to `index.html`.
- [ ] The game runs with no platform at all, and does not block on one.
- [ ] `set_mute` is honoured; `audio_muted` is sent when the game mutes itself.
- [ ] `data.onChange` re-reads the save rather than keeping the old values.
- [ ] Rewarded ads grant **only** on `rewarded: true`, and the skip path is tested.
- [ ] Wallet uses `spend()`, and grants nothing until it resolves `ok`.
- [ ] Achievement manifest entries all have `shareWithPlatform: true` and `rewardFlux > 0`.
- [ ] Preview mode writes nothing permanent.
