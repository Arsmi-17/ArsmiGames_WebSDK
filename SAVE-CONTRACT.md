# Arsmi Games — Platform Save (Data Mirror) Integration Guide

For game developers shipping a game to Arsmi Games that should keep the player's
progress when they log in on another device or browser.

Last verified against the live SDK and platform on **2026-07-22**.

---

## 1. What the platform save actually is

Your game stays the source of truth. You keep saving locally exactly as you do
today (PlayerPrefs, localStorage, IndexedDB, whatever). On top of that you
**mirror the same values into the SDK**, as a flat `string → string` map.

The platform stores that map against the **player's account** and hands it back
the next time they open the game — on any device, in any browser.

```
   your game            SDK (in the iframe)        platform page        Postgres
  ──────────    setItem   ──────────    postMessage   ─────────   HTTPS  ────────
   progress  ───────────►  save map  ───────────────►  save API  ──────► account row
   restore   ◄───────────  save map  ◄───────────────  save API  ◄──────
```

Two things follow from this design, and both are the cause of nearly every
integration bug:

1. **The mirror is two-way.** Writing to it is only half the job. If the game
   never *reads* the map back on startup, a new browser will always start fresh —
   local storage there is empty, and the game will then overwrite the good cloud
   save with its blank one.
2. **The save arrives asynchronously.** It is not there on frame one. The game
   must wait for it before deciding "this player is new".

---

## 1a. The save contract — five rules

Everything below is detail. These five are the contract, and each one exists because breaking it
destroyed a real player's progress.

**R1 — A save is one atomic snapshot.** The map is a complete, self-consistent picture of the
player. Keys are never independent: counters and the things they count travel together. The
platform therefore never blends two maps — it picks one whole map or the other.

**R2 — Nothing is written before the save arrives.** Until the platform has handed over the
player's save, your game cannot know whether this player is new — and on a browser they have
never used, everything local reads as "new". *Enforced:* both SDKs drop earlier writes and log
why.

**R3 — No save is created for a player with no progress.** "Zero levels, zero stars" is not
progress, it is the absence of it. Writing it creates an account save that exists and counts,
and which then outranks a real one. *Not enforceable by the SDK* — it cannot tell your zero from
your real value without interpreting your keys, which it refuses to do. This one is on you.

**R4 — The platform's map wins on restore, whole.** When the save arrives, adopt it entirely and
discard your local copy. Keeping the higher of two values per key is how a player ends up with a
state that never existed.

**R5 — Conflicts resolve to one map, never a merge.** The account's save wins if it has ever
been written; otherwise a guest's is adopted wholesale. You do not implement this — the platform
does — but you rely on it, which is why R1 matters.

## 2. Requirements — before any code

| Requirement | Detail |
|---|---|
| Publish setting | In the submit/publish wizard, **Save progress** must be set to **"Yes, the game saves data locally and mirrors it to Arsmi Games"** (stored as `game_data_save_preference = 'sdk'`). |
| SDK present | Web: `gamehub-sdk.js` by `<script>` tag. Unity: the UPM package, with a `GameHubBridge` GameObject in the first scene. |
| Player logged in | A guest's save is kept in the platform's own browser storage and **merged into their account automatically** the moment they sign in. Cross-device only starts working once they have an account. |
| Values are strings | The map is `Record<string, string>`. Numbers, bools and objects must be serialised by you. |

If **Save progress** is not set to the mirror option, **every write is silently a
no-op** (the web SDK logs a `console.warn`; Unity just does nothing). This is the
single most common "it isn't saving" report and it is a publish setting, not a
code bug.

### Limits (enforced server-side, rejected — never silently truncated)

| Limit | Value |
|---|---|
| Total size of the map | 100 KB (JSON, UTF-8 bytes) |
| Number of keys | 256 |
| Key length | 128 characters |

Exceeding any of these fails the whole write and fires the error callback. Do not
mirror screenshots, replays or blobs — mirror progress.

---

## 3. Unity (WebGL) integration

### 3.1 The API

```csharp
GameHubBridge.Instance          // the singleton, created by the prefab in scene 0

bool   DataReady                // true once the player's save has arrived
string SaveMode                 // "no" | "sdk" | "backend"
bool   LoggedIn

event Action  OnDataChanged     // fires when the save arrives, AND on later replacement
event Action<string> OnDataError

string GetItem(string key, string fallback = null)
int    GetInt(string key, int fallback = 0)
float  GetFloat(string key, float fallback = 0f)
bool   GetBool(string key, bool fallback = false)
bool   HasItem(string key)
IEnumerable<string> Keys

void SetItem(string key, string value)
void SetInt(string key, int value)
void SetFloat(string key, float value)
void SetBool(string key, bool value)
void RemoveItem(string key)
void ClearData()
void FlushData()                // rarely needed; see 3.4
string SaveUpdatedAt            // ISO-8601 of the last accepted write, or null
```

Reads are served from an in-memory copy, so `GetItem` in `Update()` is free — it
never crosses into JavaScript.

### 3.2 The correct startup sequence

**Do not read your own PlayerPrefs on frame one.** Gate the boot on `DataReady`.

```csharp
using UnityEngine;

public class SaveBoot : MonoBehaviour
{
    void Start()
    {
        var bridge = GameHubBridge.Instance;
        if (bridge == null) { BootWithLocalSave(); return; }   // running outside the platform

        bridge.OnDataChanged += ApplyCloudSave;
        bridge.OnDataError   += msg => Debug.LogWarning($"save error: {msg}");

        if (bridge.DataReady) ApplyCloudSave();                // it may already be here
        else StartCoroutine(WaitThenBoot(bridge));
    }

    System.Collections.IEnumerator WaitThenBoot(GameHubBridge bridge)
    {
        // Never wait for ever. If the platform is slow or the player is offline,
        // fall through to the local save rather than hanging on the loading screen.
        float deadline = Time.realtimeSinceStartup + 5f;
        while (!bridge.DataReady && Time.realtimeSinceStartup < deadline)
            yield return null;

        if (!bridge.DataReady) BootWithLocalSave();
    }

    void ApplyCloudSave()
    {
        var bridge = GameHubBridge.Instance;

        // Only the cloud copy is authoritative for a signed-in player. If it is
        // empty this really is a new player (or their first session on this account).
        if (bridge.HasItem("CatSlide.SaveVersion"))
        {
            foreach (var key in new System.Collections.Generic.List<string>(bridge.Keys))
                PlayerPrefs.SetString(key, bridge.GetItem(key));
            PlayerPrefs.Save();
        }

        BootWithLocalSave();   // now reads the values we just seeded
    }

    void BootWithLocalSave() { /* your existing load + go to menu */ }
}
```

`OnDataChanged` fires **more than once**. It fires again when a guest signs in and
their progress is merged up, and when another device turns out to be ahead. Make
`ApplyCloudSave` safe to run twice — if the player is already mid-level, apply the
values but do not restart the scene under them.

### 3.3 Mirroring every write

Wherever you write a pref today, write both:

```csharp
void SaveStars(int level, int stars)
{
    PlayerPrefs.SetInt($"CatSlide.LevelStars.{level}", stars);        // local, as before
    GameHubBridge.Instance?.SetInt($"CatSlide.LevelStars.{level}", stars);  // mirror
}
```

The cleanest version is one `SaveKey(key, value)` helper used everywhere, so the
two copies cannot drift. **The mirror must contain everything needed to restore
the player** — a partial mirror restores a partial player.

### 3.4 Flushing

Writes are debounced (~1s) and forced out automatically when the tab is hidden or
closed. `FlushData()` is only for a moment you specifically care about, such as
right after a level completes.

### 3.5 Editor / offline behaviour

Outside WebGL, `SetItem` only `Debug.Log`s and `DataReady` never becomes true.
The timeout in 3.2 is what keeps the game playable in the Editor and when opened
outside the platform.

---

## 4. Web (HTML5) integration

### 4.1 Loading the SDK

```html
<script src="/sdk/gamehub-sdk.js"></script>
<script>
  // Outside the platform /sdk/gamehub-sdk.js does not exist, so ship a copy next
  // to your game as a fallback.
  if (!window.GameHubSDK) {
    document.write('<script src="gamehub-sdk.js"><\/script>');
  }
</script>
```

The globals are **`window.GameHubSDK`** (the class) and **`window.GameHubBridge`**
(an auto-created instance). There is no npm package and no `window.ArsmiSDK`.

### 4.2 The API

```js
await GameHubBridge.init();        // resolves with the save map once it arrives

GameHubBridge.data.getItem(key)    // string | null   (synchronous, local copy)
GameHubBridge.data.setItem(key, v) // debounced mirror write
GameHubBridge.data.removeItem(key)
GameHubBridge.data.keys()          // string[]
GameHubBridge.data.getAll()        // { [key]: string }
GameHubBridge.data.clear()
GameHubBridge.data.flush()         // Promise, forces a write now
GameHubBridge.data.isReady()       // boolean
GameHubBridge.data.updatedAt()     // ISO-8601 | null
GameHubBridge.data.onChange(fn)    // save replaced by the platform — re-read
GameHubBridge.on("gamehub:data:failed", fn)   // a write was rejected
```

### 4.3 The correct startup sequence

```js
async function boot() {
  // Never block the game for ever on a round trip that may not come.
  const save = await Promise.race([
    GameHubBridge.init(),
    new Promise(r => setTimeout(() => r(null), 5000)),
  ]);

  if (save && Object.keys(save).length) {
    restoreFrom(save);              // cloud copy wins for a signed-in player
  } else {
    restoreFrom(readLocalSave());   // genuinely new, or offline
  }

  startGame();
}

// Fires when a guest's progress merges up on login, or another device was ahead.
GameHubBridge.data.onChange(map => restoreFrom(map));

boot();
```

### 4.4 Mirroring

```js
function saveKey(key, value) {
  localStorage.setItem(key, String(value));         // as before
  GameHubBridge.data.setItem(key, String(value));   // mirror
}
```

---

## 5. What happens on the platform side (so you know what to expect)

- **Guest plays, then signs in.** Their local progress is merged into the account
  automatically. On a conflicting key **the account copy wins**; keys only the
  guest had are carried up. A returning player on level 40 who pokes at the game
  logged out keeps level 40.
- **Two devices at once.** Every write carries a revision number. A write that is
  behind is rejected, and the platform pushes the authoritative map back —
  `OnDataChanged` / `data.onChange` fires with it. Adopt it; do not re-send your
  own copy or you roll the player back.
- **Game not published with the mirror on.** Writes no-op. `SaveMode` /
  `mode` reads `"no"`.
- **Nothing is interpreted.** The platform stores the map verbatim. Key names,
  formats and versioning are entirely yours — so include your own
  `Game.SaveVersion` key and handle migrating old shapes.

---

## 6. Test checklist before you send the build back

Run all of these signed in with a **real account**, not as a guest:

1. Play, make progress, wait ~2 seconds, **hard-refresh** → progress is there.
2. Play, make progress, close the tab immediately → reopen → progress is there
   (this tests the flush-on-hide path).
3. Play in Chrome, then **sign in on a different browser or a private window** and
   open the game → **progress is there.** ← *this is the one that currently fails*
4. Play logged out as a guest, then sign in without reloading → guest progress
   appears on the account.
5. Open the browser console while playing: no
   `"This game is not published with platform save enabled"` warnings, and no
   `save error:` lines.
6. A brand-new account sees a genuinely fresh game (you are not restoring a
   half-empty map over a new player).

Test 3 is the acceptance test. Tests 1 and 2 can pass on a build that never reads
the save back — they are served by your local copy.

---

## 7. Common mistakes

| Symptom | Cause |
|---|---|
| Progress saves on this browser, **fresh start on another** | The game mirrors writes but reads its own local storage on boot and never applies the SDK map. Fix per §3.2 / §4.3. |
| Fresh start, then the old save "appears" a second later, then is lost again | The game booted before `DataReady`, started a new game, and its blank state flushed over the cloud copy. Gate the boot. |
| Nothing is stored at all | **Save progress** is not set to the mirror option on the published game, or the write happens before the SDK reports `sdk` mode. |
| Some things restore, some do not | Partial mirror — a value is written to local storage but never to `SetItem`. |
| Write rejected with a size/key error | Over the limits in §2. Mirror progress, not assets. |
| Works on the platform, breaks when opened directly | No local fallback copy of `gamehub-sdk.js`, or no timeout around `init()`. |

---

## 8. What to send back with the build

So the integration can be verified without guesswork:

1. **The key list** you mirror, and which of them are required to restore a player
   (e.g. `Game.SaveVersion`, `Game.LevelStars.<n>`, `Game.Coins`).
2. **Roughly how large** the map gets at 100% completion (must stay under 100 KB / 256 keys).
3. **Confirmation that test 3 in §6 passes** on your build, ideally with a short
   screen recording of the second browser.
4. **The save version scheme** you use, and what the game does when it meets a map
   written by an older build.
5. Any keys that are intentionally *not* mirrored (device-local settings, for
   example) and why.

Questions on the platform side of this go to the Arsmi Games team — the save API,
the merge rules and the revision handling are ours; the key names, the restore
logic and the boot ordering are yours.
