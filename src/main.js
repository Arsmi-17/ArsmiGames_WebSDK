/**
 * Boot. Wires the game to the platform and to the SDK console.
 *
 * The important thing here is the ORDER, and the fact that the game does not wait for the
 * platform to draw its first frame.
 */

import { Platform } from "./platform.js";
import { createSave, createBackend, SaveTarget } from "./save.js";
import { createQuiz } from "./quiz.js";

const $ = (id) => document.getElementById(id);

// Own-backend mode (option 3) needs these. Leave them blank and the demo says so rather than
// failing quietly. Run supabase/demo_quiz_backend_schema.sql against your project first.
const backend = createBackend({
  url: localStorage.getItem("arsmi.demo.supabaseUrl") ?? "",
  anonKey: localStorage.getItem("arsmi.demo.supabaseAnonKey") ?? "",
});

const save = createSave(Platform, backend);

const quiz = createQuiz(Platform, save, {
  progress: $("progress"),
  score: $("score"),
  best: $("best"),
  question: $("question"),
  answers: $("answers"),
  feedback: $("feedback"),
  hint: $("hint"),
  buyHint: $("buyHint"),
  reset: $("reset"),
  modeNote: $("modeNote"),
  modeButtons: [$("modeLocal"), $("modePlatform"), $("modeBackend")],
});

// ---- the bridge log --------------------------------------------------------
// In a hosted game there is no debugger to attach and no console you can see. This log is
// usually the fastest way to find out why something misbehaved, which is why the demo puts
// it on screen instead of in devtools.
const logBox = $("log");
let stick = true;

logBox.addEventListener("scroll", () => {
  stick = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 24;
});

Platform.on("log", ({ line, dir, at }) => {
  const row = document.createElement("div");
  row.className = `log-line ${dir}`;
  row.innerHTML =
    `<span class="log-time">${at.toLocaleTimeString([], { hour12: false })}</span>` +
    `<span class="log-text"></span>`;
  row.querySelector(".log-text").textContent = line;
  logBox.appendChild(row);
  while (logBox.children.length > 200) logBox.removeChild(logBox.firstChild);
  if (stick) logBox.scrollTop = logBox.scrollHeight;
});

$("clearLog").addEventListener("click", () => (logBox.innerHTML = ""));

// ---- status chips ----------------------------------------------------------
function chip(el, ok, text) {
  el.textContent = text;
  el.className = `chip ${ok ? "ok" : ""}`;
}

function refreshChips() {
  const s = Platform.state;
  chip($("chipBridge"), s.connected, s.connected ? "Bridge" : "No bridge");
  chip($("chipUser"), s.loggedIn, s.loggedIn ? s.displayName ?? "Signed in" : "Guest");
  chip($("chipWallet"), s.fluxCoins !== null, s.fluxCoins === null ? "— flux" : `${s.fluxCoins} flux`);
  chip($("chipMute"), !s.muted, s.muted ? "Muted" : "Audio on");
  $("saveMeta").textContent = Platform.saveUpdatedAt()
    ? `synced ${new Date(Platform.saveUpdatedAt()).toLocaleTimeString([], { hour12: false })}`
    : "not synced";
}

Platform.on("user", refreshChips);
Platform.on("wallet", refreshChips);
Platform.on("mute", refreshChips);
Platform.on("save", refreshChips);

// ---- SDK console -----------------------------------------------------------
$("btnWhoAmI").addEventListener("click", () => {
  const s = Platform.state;
  Platform.log(
    s.loggedIn
      ? `signed in as ${s.displayName} · playerId ${String(s.playerId).slice(0, 12)}…`
      : "guest — no playerId, so own-backend mode has nothing to key on"
  );
});
$("btnLogin").addEventListener("click", () => Platform.requestLogin());
$("btnFullscreen").addEventListener("click", () => Platform.requestFullscreen());
$("btnMute").addEventListener("click", () => Platform.setMuted(!Platform.state.muted));
$("btnWallet").addEventListener("click", () => Platform.spend(0, "noop"));
$("btnAd").addEventListener("click", () => void Platform.showRewardedAd("sdk-console"));
$("btnAchv").addEventListener("click", () => Platform.defineAchievements());
$("btnProgress").addEventListener("click", () => Platform.achievementProgress("quiz_correct", 1));
$("btnBoard").addEventListener("click", () => Platform.defineLeaderboard());
$("btnScore").addEventListener("click", () => Platform.submitScore(100));
$("btnDump").addEventListener("click", () => {
  const entries = save.entries();
  Platform.log(entries.length ? entries.map(([k, v]) => `${k}=${v}`).join("  ") : "save is empty");
});
$("btnPlatformLog").addEventListener("click", () => {
  Platform.platformLog("Hello from the web demo");
  Platform.log("→ bridge:log", "out");
});

// ---- boot ------------------------------------------------------------------
//
// Draw the game FIRST, from local state, then connect. A game that waits for the platform
// before showing anything is a game that shows a black screen when the platform is slow —
// and shows it forever when there is no platform at all.
quiz.setMode(SaveTarget.PlatformMirror);
refreshChips();

void Platform.connect().then(() => {
  // Declare the manifest and the board once, after the handshake. Doing it before means
  // shouting into a void — there is nobody on the other end of the bridge yet.
  Platform.defineAchievements();
  Platform.defineLeaderboard();
  quiz.load();
  refreshChips();
});
