/**
 * Every line of platform integration this game has, in one file.
 *
 * It is deliberately all here rather than sprinkled through the game: when you port this to
 * your own game, this is the file you read, and quiz.js is the file you throw away.
 *
 * The two rules that matter most, because breaking either fails *silently*:
 *
 *   1. The game must run with no platform at all. Open index.html from the filesystem and
 *      it still plays. Every call below is guarded, and none of them block the first frame.
 *   2. The platform is authoritative about anything worth cheating for — the wallet, whether
 *      an ad was watched, whether a save is current. The game asks and waits; it never
 *      decides.
 */

export const Platform = (() => {
  // The SDK creates window.GameHubBridge for us when the script loads. If the script is not
  // on the page — a standalone build, a bad deploy, a 404 — this is null and every method
  // below turns into a no-op instead of a crash.
  const sdk = window.GameHubBridge ?? window.GameHubSDK?.create?.({ debug: false }) ?? null;

  const listeners = { log: [], user: [], wallet: [], mute: [], save: [] };
  const emit = (kind, payload) => listeners[kind].forEach((fn) => fn(payload));

  const state = {
    connected: !!sdk,
    preview: false,
    loggedIn: false,
    playerId: null,       // pseudonymous, per-game. The key for your OWN backend.
    displayName: null,
    saveMode: "no",       // "no" | "sdk" | "backend" — set by the platform, not by you
    fluxCoins: null,
    muted: false,
    fullscreen: false,
    ready: false,
  };

  const log = (line, dir = "info") => emit("log", { line, dir, at: new Date() });

  if (!sdk) {
    log("No SDK on the page — running standalone. Progress stays in this browser.", "warn");
  }

  // ---- context -------------------------------------------------------------
  // preview:true means the dashboard or admin is previewing the game. Nothing you write in
  // preview persists, and you must not treat the test user as a real player.
  sdk?.onContext?.((ctx) => {
    state.preview = !!ctx.preview;
    log(`context — ${state.preview ? "PREVIEW (nothing persists)" : "live"}`, "in");
  });

  // ---- who is playing ------------------------------------------------------
  sdk?.user?.onChange?.((user) => {
    state.loggedIn = !!user?.loggedIn;
    state.playerId = user?.playerId ?? null;
    state.displayName = user?.displayName ?? null;
    log(`user:state — ${state.loggedIn ? state.displayName ?? "signed in" : "guest"}`, "in");
    emit("user", state);
  });

  // ---- audio ---------------------------------------------------------------
  // Two-way, and both directions matter. The platform's volume button sends set_mute and the
  // game MUST honour it, or the button is a lie. When the game mutes itself it says so, and
  // the platform's icon follows. The SDK drops no-op updates, so this cannot ping-pong.
  sdk?.onMute?.(({ muted, source }) => {
    state.muted = muted;
    log(`audio ${muted ? "muted" : "unmuted"} (${source})`, source === "platform" ? "in" : "out");
    emit("mute", state);
  });

  // ---- fullscreen ----------------------------------------------------------
  // Subscribe at boot, not when the player clicks something. The platform's fullscreen
  // button resizes the frame around you, and a game that only finds out about fullscreen
  // when it asks for it will render at the wrong size when the platform does the asking.
  //
  // The platform also treats this subscription as the proof that you handle fullscreen at
  // all, and refuses to publish a game that never registers it.
  sdk?.on?.("set_fullscreen", ({ fullscreen }) => {
    state.fullscreen = !!fullscreen;
    log(`fullscreen ${fullscreen ? "entered" : "exited"}`, "in");
    // A canvas game would resize its renderer here.
  });

  // ---- wallet --------------------------------------------------------------
  // The balance is whatever the SERVER says it is. A game READS it and asks to SPEND from it.
  // There is no way to add to it — not through this object, not through sdk.emit(), which
  // refuses the message outright. Flux is real money: the player buys it, or the PLATFORM
  // grants it for watching the PLATFORM's own ad.
  //
  // That includes ads your game asks for. They pay out in YOUR currency, not in Flux.
  sdk?.wallet?.onChange?.(({ fluxCoins }) => {
    state.fluxCoins = fluxCoins;
    log(`wallet:state — ${fluxCoins} flux`, "in");
    emit("wallet", state);
  });
  sdk?.wallet?.onError?.(({ message }) => log(`wallet:error — ${message}`, "err"));

  // ---- save data -----------------------------------------------------------
  // Fires when the platform REPLACES your values: after a guest signs in and their progress
  // is merged up, or when the player's other device turns out to be further ahead. Ignoring
  // it is how progress gets lost — you must re-read, not keep what you had.
  sdk?.data?.onChange?.(() => {
    log("data:changed — the platform replaced our save; re-reading", "in");
    emit("save", state);
  });

  return {
    state,
    on: (kind, fn) => (listeners[kind].push(fn), () => {}),
    log,

    /**
     * Call once, before the first frame that reads a save.
     *
     * init() resolves when the platform hands over the player's save. It resolves
     * immediately with {} when there is no platform, so a standalone build does not hang —
     * which is exactly what would happen if you awaited a message that never arrives.
     */
    async connect() {
      if (!sdk) {
        state.ready = true;
        return {};
      }
      const data = await sdk.init();
      state.saveMode = sdk.data?.mode ?? "sdk";
      state.ready = true;
      log(`connected — save mode "${state.saveMode}", rev ${sdk.data.rev()}`, "in");
      void sdk.wallet.fetch();
      return data;
    },

    // ---- save ------------------------------------------------------------
    // Writes are batched: calling setItem in a loop produces one write, about a second later.
    // The SDK forces a flush when the tab is hidden or closed, so you do not lose the last
    // few seconds of play. You rarely need flush() yourself.
    getItem: (key, fallback = null) => sdk?.data?.getItem?.(key) ?? fallback,
    setItem: (key, value) => sdk?.data?.setItem?.(key, String(value)),
    getInt: (key, fallback = 0) => {
      const raw = sdk?.data?.getItem?.(key);
      const n = Number(raw);
      return Number.isFinite(n) ? n : fallback;
    },
    clearSave: () => sdk?.data?.clear?.(),
    saveUpdatedAt: () => sdk?.data?.updatedAt?.() ?? null,

    // ---- wallet ----------------------------------------------------------
    /** Resolves { ok, error }. NOT ok means the player could not afford it — grant nothing. */
    async spend(amount, reason) {
      if (!sdk) return { ok: false, error: "No platform." };
      this.log(`→ wallet:spend ${amount} (${reason})`, "out");
      return sdk.wallet.spend(amount, reason);
    },

    // ---- rewarded ad -----------------------------------------------------
    /**
     * The ad is a PLATFORM overlay drawn over the game. The game does not render it, does
     * not time it, and does not get to say whether it was watched — the reward is real
     * currency, so that decision stays outside the iframe.
     *
     * Pause yourself when it starts. The platform mutes the frame; it does not pause you.
     * Resolves { rewarded }. rewarded:false means skipped or failed — grant NOTHING.
     */
    async showRewardedAd(placement) {
      if (!sdk) return { rewarded: false, reason: "no-platform" };
      this.log(`→ ad:show (${placement})`, "out");
      const result = await sdk.ads.showRewarded({ placement });
      this.log(result.rewarded ? "← ad:rewarded" : "← ad:dismissed — no reward", "in");
      return result;
    },

    // ---- leaderboard -----------------------------------------------------
    defineLeaderboard() {
      sdk?.leaderboard?.define?.({
        boards: [{ metricKey: "quiz_score", metricLabel: "Quiz score", sortDirection: "desc" }],
      });
      this.log("→ leaderboard:define", "out");
    },

    /**
     * A submit only replaces the stored score when it BEATS it, for that board's sort
     * direction. The platform keeps the player's best. A game that assumes every submit
     * overwrites will disagree with the platform about what the player's score is.
     */
    submitScore(score) {
      sdk?.leaderboard?.submitScore?.({
        metricKey: "quiz_score",
        metricLabel: "Quiz score",
        sortDirection: "desc",
        score,
      });
      this.log(`→ leaderboard:score ${score}`, "out");
    },

    // ---- window ----------------------------------------------------------
    setMuted: (muted) => sdk?.setMuted?.(muted),
    requestFullscreen: () => sdk?.requestPlatformFullscreen?.("landscape"),
    requestLogin: () => sdk?.requestLogin?.("quiz"),
    platformLog: (message) => sdk?.log?.("info", message),
  };
})();
