/**
 * The game. A small kids quiz — the same one the Unity sample ships, so you can put the two
 * side by side and see that the platform contract is identical in both.
 *
 * Nothing here is platform code. It calls Platform and Save; it does not know what a
 * postMessage is. That separation is the thing to copy: when you port this, you keep
 * platform.js and save.js and throw this file away.
 */

import { SaveTarget } from "./save.js";

const QUESTIONS = [
  { q: "How many legs does a spider have?", a: ["6", "8", "10"], correct: 1 },
  { q: "What colour do you get mixing red and yellow?", a: ["Green", "Purple", "Orange"], correct: 2 },
  { q: "2 + 2 = ?", a: ["3", "4", "5"], correct: 1 },
  { q: "Which one is a mammal?", a: ["Shark", "Dolphin", "Octopus"], correct: 1 },
  { q: "How many days are in a week?", a: ["5", "7", "10"], correct: 1 },
  { q: "What is the biggest planet?", a: ["Mars", "Earth", "Jupiter"], correct: 2 },
  { q: "Ice is water that is…", a: ["Frozen", "Boiling", "Salty"], correct: 0 },
  { q: "How many sides does a triangle have?", a: ["3", "4", "5"], correct: 0 },
];

const HINT_COST = 5;

export function createQuiz(platform, save, els) {
  let index = 0;
  let score = 0;
  let best = 0;
  let hintUsed = false;
  let paused = false;

  function load() {
    index = save.getInt("quiz_index", 0) % QUESTIONS.length;
    score = save.getInt("quiz_score", 0);
    best = save.getInt("quiz_best", 0);
    render();
  }

  function persist() {
    save.setInt("quiz_index", index);
    save.setInt("quiz_score", score);
    save.setInt("quiz_best", best);
  }

  function render() {
    const question = QUESTIONS[index];
    els.progress.textContent = `Question ${index + 1} of ${QUESTIONS.length}`;
    els.score.textContent = String(score);
    els.best.textContent = String(best);
    els.question.textContent = question.q;

    els.answers.innerHTML = "";
    question.a.forEach((text, i) => {
      const button = document.createElement("button");
      button.className = "answer";
      button.textContent = text;
      button.disabled = paused;
      if (hintUsed && i !== question.correct) button.classList.add("dimmed");
      button.addEventListener("click", () => answer(i));
      els.answers.appendChild(button);
    });

    els.hint.disabled = paused || hintUsed;
  }

  function answer(picked) {
    if (paused) return;
    const question = QUESTIONS[index];

    if (picked === question.correct) {
      score += 1;
      els.feedback.textContent = "Correct!";
      els.feedback.className = "feedback good";

      // The metric must match a manifest entry's `metric` exactly, or this counts towards

      if (score > best) {
        best = score;
        // Only submit a NEW best. The platform keeps the player's best anyway (a submit that
        // does not beat the stored score changes nothing), but there is no reason to send it.
        platform.submitScore(best);
      }
    } else {
      els.feedback.textContent = `Not quite — it was "${question.a[question.correct]}".`;
      els.feedback.className = "feedback bad";
      score = 0;
    }

    hintUsed = false;
    index = (index + 1) % QUESTIONS.length;
    persist();
    render();
  }

  /**
   * Two ways to buy a hint, and they are the two halves of the currency model.
   *
   * SPEND: the player pays Flux they already have. The SERVER checks they can afford it and
   * can refuse. Nothing is granted until it says yes.
   *
   * WATCH AN AD: the player earns it. The platform draws the ad, times it, and decides
   * whether it was watched. The game grants the hint only on rewarded:true.
   *
   * In neither case does the game decide anything about the money. That is the whole rule.
   */
  async function buyHint() {
    if (hintUsed || paused) return;

    const result = await platform.spend(HINT_COST, "quiz-hint");
    if (!result.ok) {
      els.feedback.textContent = result.error ?? "Could not buy a hint.";
      els.feedback.className = "feedback bad";
      return;
    }
    grantHint();
  }

  async function watchAdForHint() {
    if (hintUsed || paused) return;

    // Pause and mute OURSELVES. The platform mutes the frame, but it does not pause the game
    // — a game still running under an ad sounds and looks broken.
    paused = true;
    platform.setMuted(true);
    render();

    const { rewarded } = await platform.showRewardedAd("quiz-hint");

    paused = false;
    platform.setMuted(false);

    if (rewarded) {
      grantHint();          // ONLY here. rewarded:false means skipped or failed.
    } else {
      els.feedback.textContent = "No reward — the ad was skipped.";
      els.feedback.className = "feedback";
      render();
    }
  }

  function grantHint() {
    hintUsed = true;
    els.feedback.textContent = "Hint: the wrong answers are dimmed.";
    els.feedback.className = "feedback good";
    render();
  }

  function setMode(mode) {
    save.setTarget(mode);
    els.modeNote.textContent = {
      [SaveTarget.LocalOnly]: "Progress stays in this browser. It never reaches another device.",
      [SaveTarget.PlatformMirror]: "Progress is mirrored to the player's account and follows them anywhere.",
      [SaveTarget.OwnBackend]: "The platform stores nothing. It only tells the game who the player is.",
    }[mode];

    els.modeButtons.forEach((button, i) => button.classList.toggle("active", i === mode));
    load();
  }

  // The platform replaced our values — a guest signed in, or another device was ahead.
  // Re-read. Keeping what we had would roll the player backwards.
  save.onExternalChange(load);

  els.hint.addEventListener("click", () => void watchAdForHint());
  els.buyHint.addEventListener("click", () => void buyHint());
  els.modeButtons.forEach((button, i) => button.addEventListener("click", () => setMode(i)));
  els.reset.addEventListener("click", () => {
    save.clear();
    index = 0;
    score = 0;
    best = 0;
    hintUsed = false;
    render();
  });

  return { load, setMode, render };
}
