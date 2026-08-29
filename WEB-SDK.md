# Arsmi Games — Web SDK

Everything an HTML5 game needs to talk to the platform. Verified against
`packages/sdk/web/gamehub-sdk.js` on 2026-07-22.

- Package: `@arsmigames/sdk` 2.0.0 · wire protocol 2
- Repo: `https://github.com/Arsmi-17/ArsmiGames_WebSDK`

There is **no npm package**. The SDK is one file, loaded by script tag.

## Setup

```html
<script src="/sdk/gamehub-sdk.js"></script>
<script>
  // Absolute path only resolves when the platform is serving your build. A game hosted
  // anywhere else — Netlify, Cloudflare Pages, file:// — needs the bundled fallback.
  if (!window.GameHubSDK) document.write('<script src="gamehub-sdk.js"><\/script>');
</script>
```

`document.write` is deliberate: it is synchronous, so the SDK is defined before your game runs.
"Eventually loaded" is not good enough.

Two globals: **`window.GameHubSDK`** (the class) and **`window.GameHubBridge`** (an
auto-created instance). There is no `window.ArsmiSDK`.

## Two rules that are not optional

The platform will not publish a game that breaks either.

**Honour the volume button.** **Handle being resized.**

```js
GameHubBridge.on("gamehub:audio:muted", ({ muted, source }) => setAudioMuted(muted));
GameHubBridge.on("gamehub:screen:set", ({ fullscreen }) => relayout());
```

Subscribing is also the proof. The platform can watch what your game *sends*, but a game
receiving a mute instruction and honouring it produces no traffic at all — so from outside, a
game that mutes itself and one that ignores the button look identical. Your subscription is
what answers for you.

When your game mutes itself, tell the platform so its icon agrees:

```js
GameHubBridge.setMuted(true);   // echo-guarded; safe to call on every toggle
GameHubBridge.isMuted();
GameHubBridge.requestPlatformFullscreen("landscape");
```

## Saving progress

The full contract is in
[platform_saving_data_instruction.md](../../../platform_saving_data_instruction.md). In short:

| Rule | What it means in JS |
|---|---|
| R1 | Mirror a complete, self-consistent snapshot. Keys are never independent. |
| R2 | Write nothing until the save arrives. The SDK drops earlier writes and logs why. |
| R3 | Do not create a save for a player with no progress. |
| R4 | When the save arrives, adopt it whole and discard your local copy. |
| R5 | Conflicts resolve to one whole map. The platform decides; never merge by key. |

Requires publishing with **Save progress → "saves data locally and mirrors it to Arsmi Games"**.
Otherwise every write is a no-op and the SDK says so in your console.

```js
await GameHubBridge.init();          // resolves with the save map once it arrives

GameHubBridge.data.getItem(key)      // string | null, synchronous, local copy
GameHubBridge.data.setItem(key, v)   // debounced mirror write
GameHubBridge.data.removeItem(key)
GameHubBridge.data.keys()            // string[]
GameHubBridge.data.getAll()          // { [key]: string }
GameHubBridge.data.clear()
GameHubBridge.data.flush()           // Promise; forces a write now
GameHubBridge.data.isReady()         // boolean
GameHubBridge.data.rev()             // last revision the platform confirmed
GameHubBridge.data.updatedAt()       // ISO-8601 | null
GameHubBridge.data.onChange(fn)      // the platform replaced the save — re-read
GameHubBridge.on("gamehub:data:failed", fn)   // a write was rejected
```

Values are strings. Serialise anything else yourself.

**Limits, enforced server-side and rejected rather than truncated:** 100 KB total, 256 keys,
128-character keys. Mirror progress, not assets.

### The startup order that matters

```js
async function boot() {
  // Never block forever on a round trip that may not come.
  const save = await Promise.race([
    GameHubBridge.init(),
    new Promise(r => setTimeout(() => r(null), 5000)),
  ]);

  if (save && Object.keys(save).length) restoreFrom(save);   // the cloud copy wins, whole
  else restoreFrom(readLocalSave());                         // genuinely new, or offline

  startGame();
}

GameHubBridge.data.onChange(map => restoreFrom(map));        // fires again after a guest signs in
boot();
```

On a browser the player has never used, local storage is empty — a new browser and a new player
are indistinguishable. A game that boots from local state starts fresh and then writes that
fresh state over a real account save. That is the bug this ordering exists to prevent.

## Am I on the platform? (2.1.0)

```js
GameHubBridge.onConnection(function (c) {
  if (c.connected) startOnlineRun(c.gameId);
  else             startOfflineRun();          // c.reason === "standalone"
});
```

```js
GameHubBridge.isConnected()    // boolean
GameHubBridge.getConnection()  // { connected, known, reason?, sessionId, gameId, slug, role,
                               //   preview, platformVersion, sdkVersion, protocol }
await GameHubBridge.whenConnected();  // the same answer, as a promise
```

`onConnection` fires once there is an **answer**, and again if it ever changes. That is not the
same as firing immediately: for the first moments of a page load the honest answer is "not yet",
because the platform's handshake lands a few milliseconds after this file runs. Subscribe late
and it fires straight away with the answer already in hand, so there is no race to lose.

Three things follow from that, and they are the reason this exists:

- **Do not use `isConnected()` on the first frame.** It is false before the handshake and false
  for ever off-platform, and those are different facts. `getConnection().known` separates them;
  `onConnection` waits for you.
- **It says no as definitely as it says yes.** If no platform answers within a second and a half,
  the callback fires with `connected: false, reason: "standalone"` — a game opened from disk gets
  a real answer instead of a spinner. A host that answers after that still connects, and your
  handler is called again.
- **It is not `onContext`.** `onContext` fires immediately with a locally guessed context whether
  or not a platform is there, so it cannot tell you where you are. Checking `window.parent`
  cannot either: that is equally true inside anyone else's iframe.

Nothing crosses the iframe for this. It is the SDK reporting a handshake it already had, so
subscribing costs nothing and claims nothing — it is not a compliance check and does not count
towards what your game implements.

## Which way the frame is (2.2.0)

```js
GameHubBridge.onOrientation(function (orientation) {
  relayout(orientation);          // "portrait" | "landscape"
});

GameHubBridge.getOrientation();   // the same value, right now. Never null.
```

On a phone this is **how the player is holding it**, and it changes when they turn it. Fires
immediately with what is known, then again on each rotation.

It is not the orientation you uploaded the game as. The platform used to lock the phone to
that value, so the two could never disagree — a player holding their phone upright had the
screen turned under them and could not turn it back. It no longer does: the frame fills the
screen whichever way the device is held, and your game is the side that adapts.

The value also lives on the context (`getContext().orientation`) and arrives on the wire as
part of `gamehub:screen:set` — the event that already means "the platform resized the frame
around you". So a game that handles resizing at all can read it there instead:

```js
GameHubBridge.on("gamehub:screen:set", function (screen) {
  // { fullscreen, orientation }
});
```

## Identity

```js
GameHubBridge.user.get()
// { loggedIn, userId, playerId, username, displayName, avatarPath, playerCode, email, emailShared }
GameHubBridge.user.onChange(fn);
```

Key your own records on `playerId`: pseudonymous, stable for this player in this game, and
deliberately not comparable across games. `email` is null unless the per-game opt-in was granted
and you save to your own backend — null for most games and every guest. Never build login on it.

## Device

```js
GameHubBridge.onDevice(function (device) {
  if (device.input.touch) showTouchControls();
  else                    showKeyboardHints();
});

GameHubBridge.device.get()
// { type: "mobile" | "tablet" | "desktop",
//   input: { touch, keyboard, mouse, gamepad },
//   source: "platform" | "local" }

GameHubBridge.device.supports(["desktop"]);   // optional; see below
GameHubBridge.device.declared();              // what you declared, [] means every device
```

All of this is optional. A game that never calls it behaves exactly as before, and is treated as
supporting every device.

**Ask the platform, do not sniff.** Your game runs in an iframe the platform sized, so your own
viewport measures the frame and not the device — a desktop browser at a narrow window and a real
phone are identical from in there. The platform decides and tells you.

**`type` and `input` are two different facts, deliberately.** An iPad with a keyboard case is a
tablet that types; a touchscreen laptop is a desktop that taps. Gate features on `type`, choose
controls on `input`. Using one to guess the other is wrong on both of those devices.

`input.keyboard` is the platform's best signal, not a certainty — no browser can tell you whether
a keyboard is attached. `input.gamepad` is a snapshot taken at handshake; use the Gamepad API's
own events for a pad plugged in later.

**`source` tells you who answered.** `"platform"` is the platform's own detection. `"local"` means
no platform was there to ask — you opened the game from disk, or ran it under the local test
harness — and the SDK made a rougher guess so you were not handed `null`. On the platform it is
always `"platform"`.

`type` and `input` do not change during a session. A desktop window dragged narrow is still a
desktop; for rotation and resize, subscribe to `gamehub:screen:set` instead. `onDevice` fires
immediately with what is known, and once more if the platform's answer differs from the SDK's
initial guess — so subscribe rather than reading `device.get()` on your first frame.

### Saying which devices your game is for

```js
GameHubBridge.device.supports(["desktop"]);          // desktop only
GameHubBridge.device.supports(["desktop", "tablet"]); // not phones
GameHubBridge.device.supports([]);                    // every device (the default)
```

This only ever restricts your own game, which is why the platform takes your word for it.

When you upload, the platform reads this during preview and pre-fills the **Supported devices**
field for you; you can override it, and the value in the upload form is what gets stored. Players
on other devices see a note above the play button — **they are not blocked, and the game still
loads**. Device detection is never perfect, and a hard block would leave a wrongly-detected player
with a game they could not start.

Declaring nothing is completely fine and is what most games should do. It has no effect on whether
your game can be published.

## Flux Coins

```js
GameHubBridge.wallet.get()                    // { fluxCoins, currency, rate }; fluxCoins null until first reply
await GameHubBridge.wallet.fetch()            // { ok, fluxCoins }
await GameHubBridge.wallet.spend(50, "extra life")   // { ok, error? }
GameHubBridge.wallet.onChange(fn);
GameHubBridge.wallet.onError(fn);
```

**A game can never add Flux Coins.** `wallet.set`, `wallet.add` and `wallet.earn` are refused
inside the SDK — they never leave the iframe, even if you call `emit()` directly. Do not hand
over what was bought until `spend` resolves `ok`; the server checks the balance and it can fail.

## Rewarded ads

```js
const { rewarded, reason } = await GameHubBridge.ads.showRewarded({ placement: "continue" });
if (rewarded) grantYourOwnReward();
GameHubBridge.ads.onStarted(fn);
GameHubBridge.ads.onFinished(fn);
```

The platform renders the ad; your game asks and pauses. It pays out in *your* currency, never
Flux.

## Leaderboards

```js
GameHubBridge.leaderboard.define({ metricKey: "score", metricLabel: "Score", sortDirection: "desc" });
GameHubBridge.leaderboard.submitScore({ score: 1200, metricKey: "score" });
GameHubBridge.leaderboard.onSharing(fn);
```

There is no way to read entries back — the platform renders the board.

## Pocket Console

Phones as controllers. Web-only in practice: Unity receives these but has no C# events for them.

```js
GameHubBridge.pocket.ready({ maxPlayers: 4, layout: "dpad-buttons" });
GameHubBridge.pocket.setControllerSchema({ /* your layout */ });
GameHubBridge.pocket.onInput(fn);
GameHubBridge.pocket.onPlayerJoined(fn);
GameHubBridge.pocket.onPlayerReconnected(fn);
GameHubBridge.pocket.onPlayerLeft(fn);
```

## Challenge

```js
GameHubBridge.challenge.ready({ maxPlayers: 2 });
GameHubBridge.challenge.updateState({ /* live state */ });
GameHubBridge.challenge.submitResult({ /* final */ });
GameHubBridge.challenge.onStart(fn);
GameHubBridge.challenge.onLeaderboard(fn);
GameHubBridge.challenge.onEnd(fn);
```

## Casino

Only for games an admin has registered as casino-class. Every other game's `round()` is refused,
which is why the module being present for everyone is harmless.

```js
const r = await GameHubBridge.casino.round({ mode: "slot", bet: 10, roundKey });
// { ok, outcome, multiplier, bet, payout, balance, nonce, roll, serverSeedHash }
await GameHubBridge.casino.seed();
await GameHubBridge.casino.rotateSeed(clientSeed);
```

**You send a bet. You never send a payout.** There is no parameter for an outcome or a
multiplier — not validated away, simply absent. The server owns the paytable and settles in one
transaction; your game renders a result that has already happened. `roundKey` is an idempotency
key: retry with the same one and you get the same result, not a second spin.

`{ ok: false, code: "insufficient" }` is an answer, not an error. Show a top-up; do not retry.

## Escape hatches

```js
GameHubBridge.on(eventName, handler);   // returns an unsubscribe function
GameHubBridge.emit(eventName, payload); // returns the id the platform will ack, or null if refused
GameHubBridge.onAck(({ id, event, handled }) => {});
GameHubBridge.log("info", "message", data);
```

If the platform acks `handled: false`, it received your event and did nothing with it — almost
always a misspelt name. The SDK warns in your console rather than letting you emit into a void.

## Publishing checklist

1. Mute handled and audible silence actually achieved.
2. Fullscreen/resize handled.
3. If you save: boot gated on `init()`, writes after it, complete snapshots.
4. Bundled `gamehub-sdk.js` fallback present, and a timeout around `init()`.
5. Console clean — no "not published with platform save enabled", no "called before the player's
   save arrived", no unhandled-ack warnings.
