/**
 * One save API over the three published save modes.
 *
 * This is the web counterpart of ArsmiSave.cs in the Unity package, and it makes the same
 * bet: **the local copy is authoritative for reads, in every mode.** The game reads
 * synchronously and never waits on a network. A slow connection can delay a *sync*; it can
 * never stall gameplay.
 *
 * The three modes are the three answers to "Does your game save progress?" in the publish
 * wizard. A real game picks one. The demo switches at runtime so you can watch the same game
 * code behave correctly under all three.
 */

const PREFIX = "arsmi.save.";

export const SaveTarget = {
  /** PlayerPrefs equivalent. Progress dies with the browser profile. */
  LocalOnly: 0,
  /** Local, plus mirrored to the player's Arsmi account so it follows them to another device. */
  PlatformMirror: 1,
  /** The platform stores nothing; it only tells you WHO the player is. You store the rest. */
  OwnBackend: 2,
};

export function createSave(platform, backend) {
  let target = SaveTarget.PlatformMirror;
  const local = new Map();
  const listeners = [];

  const notify = () => listeners.forEach((fn) => fn());

  const readLocal = () => {
    local.clear();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) local.set(k.slice(PREFIX.length), localStorage.getItem(k));
    }
  };
  readLocal();

  /**
   * The platform spoke. Adopt what it says, over the top of anything local.
   *
   * This is not optional and it is not a merge. It fires when a guest signs in and their
   * progress is merged into their account, or when the player's OTHER DEVICE is further
   * ahead. Keeping our copy in either case rolls the player backwards, which is how progress
   * gets lost — and the player has no idea why.
   */
  platform.on("save", () => {
    if (target !== SaveTarget.PlatformMirror) return;
    for (const key of ["quiz_index", "quiz_score", "quiz_best"]) {
      const value = platform.getItem(key);
      if (value === null) continue;
      local.set(key, value);
      localStorage.setItem(PREFIX + key, value);
    }
    platform.log("adopted the platform's save (it is authoritative)", "in");
    notify();
  });

  return {
    get target() {
      return target;
    },

    onExternalChange: (fn) => listeners.push(fn),

    setTarget(next) {
      target = next;
      platform.log(`save mode → ${["LocalOnly", "PlatformMirror", "OwnBackend"][next]}`);

      if (next === SaveTarget.OwnBackend && backend?.isConfigured()) {
        // Own-backend mode: the platform gives you a playerId and nothing else. Key your
        // records on it. It is stable for this player in this game, and two games cannot
        // compare ids to work out they have the same person — so never use the raw platform
        // user id for this.
        const playerId = platform.state.playerId;
        if (!playerId) {
          platform.log("own-backend: no playerId — the player is a guest. Staying local.", "warn");
          return;
        }
        void backend.load(playerId).then((map) => {
          if (!map) return;
          for (const [k, v] of Object.entries(map)) {
            local.set(k, v);
            localStorage.setItem(PREFIX + k, v);
          }
          platform.log(`own-backend: loaded ${Object.keys(map).length} keys`, "in");
          notify();
        });
      }
      notify();
    },

    /** Synchronous, always. Reads never touch the network, in any mode. */
    getString: (key, fallback = "") => local.get(key) ?? fallback,
    getInt(key, fallback = 0) {
      const n = Number(local.get(key));
      return Number.isFinite(n) ? n : fallback;
    },

    setString(key, value) {
      const v = String(value);
      // Local first, always. If the mirror fails, the player still has their progress.
      local.set(key, v);
      localStorage.setItem(PREFIX + key, v);

      if (target === SaveTarget.PlatformMirror) {
        // Batched by the SDK — a burst of setItem becomes one write about a second later,
        // and it is force-flushed when the tab is hidden or closed.
        platform.setItem(key, v);
      } else if (target === SaveTarget.OwnBackend && backend?.isConfigured()) {
        const playerId = platform.state.playerId;
        if (playerId) backend.saveDebounced(playerId, Object.fromEntries(local));
      }
    },

    setInt(key, value) {
      this.setString(key, String(Math.round(value)));
    },

    clear() {
      for (const key of [...local.keys()]) localStorage.removeItem(PREFIX + key);
      local.clear();
      if (target === SaveTarget.PlatformMirror) platform.clearSave();
      notify();
    },

    entries: () => [...local.entries()],
  };
}

/**
 * Example "your own backend" client — Supabase over REST.
 *
 * Swap the two fetches for your own endpoints and nothing else in the game changes. That is
 * the point of keeping it behind this interface.
 *
 * NOTE the anon key is public by design, and the demo table's RLS lets anyone holding it read
 * and write any row. That is fine for a quiz score keyed by an id that identifies nobody, and
 * NOT fine for anything else. A real backend verifies the player server-side rather than
 * letting the browser talk to Postgres directly.
 */
export function createBackend({ url, anonKey, table = "game_platform_demo_quiz_saves" }) {
  let timer = null;

  const headers = () => ({
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    "Content-Type": "application/json",
  });

  return {
    isConfigured: () => !!(url && anonKey),

    async load(playerId) {
      if (!url || !anonKey) return null;
      const endpoint = `${url}/rest/v1/${table}?player_id=eq.${encodeURIComponent(playerId)}&select=data`;
      const res = await fetch(endpoint, { headers: headers() }).catch(() => null);
      if (!res?.ok) return null;
      const rows = await res.json().catch(() => []);
      return rows?.[0]?.data ?? null;
    },

    /** Debounced for the same reason the SDK debounces: a game writing per-frame must not
     *  produce a request per frame. */
    saveDebounced(playerId, data) {
      clearTimeout(timer);
      timer = setTimeout(() => void this.save(playerId, data), 800);
    },

    async save(playerId, data) {
      if (!url || !anonKey) return;
      await fetch(`${url}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...headers(), Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ player_id: playerId, data, updated_at: new Date().toISOString() }),
      }).catch(() => null);
    },
  };
}
