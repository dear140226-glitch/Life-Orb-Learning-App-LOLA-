import { useState, useEffect, useRef, useCallback } from "react";

// ============================================================
// LIFE NPC AUDIO ENGINE v2 — fully unlocked
// Web Audio API (no external dependency) + Web Speech API
// FIXES (v3.3):
//   • AudioContext resume is async + awaited, never fire-and-forget
//   • Global unlock() fires on first tap anywhere on the page
//   • Phonics now SPEAKS the actual sound (digraphs/blends handled
//     correctly) instead of playing an abstract tone that only ever
//     read the first character
//   • TTS: voiceschanged race fixed, Chrome mobile speak() gap fixed
// ============================================================
const AudioEngine = (() => {
  let ctx = null;
  let unlocked = false;

  async function getCtx() {
    if (!ctx || ctx.state === "closed") {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === "suspended") await ctx.resume();
    return ctx;
  }

  // Unlock on first user gesture anywhere — required by mobile browser
  // autoplay policy. Also pre-warms speechSynthesis so the first real
  // utterance doesn't get silently dropped.
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    getCtx().catch(() => {});
    if (window.speechSynthesis) {
      const warm = new SpeechSynthesisUtterance("");
      window.speechSynthesis.speak(warm);
      window.speechSynthesis.cancel();
    }
  }
  if (typeof document !== "undefined") {
    ["touchstart","touchend","mousedown","keydown","click"].forEach(ev =>
      document.addEventListener(ev, unlock, { once:true, passive:true })
    );
  }

  // ── Tone generator ──────────────────────────────────────────
  async function playTone({ freq=440, type="sine", dur=0.18, vol=0.4, delay=0, ramp=true }) {
    const c = await getCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.connect(gain);
    gain.connect(c.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime + delay);
    gain.gain.setValueAtTime(0.001, c.currentTime + delay);
    gain.gain.linearRampToValueAtTime(vol, c.currentTime + delay + 0.01);
    if (ramp) gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + delay + dur);
    osc.start(c.currentTime + delay);
    osc.stop(c.currentTime + delay + dur + 0.02);
  }

  // ── Clap sound (filtered noise burst) ──────────────────────
  async function playClap(delay=0) {
    const c = await getCtx();
    const bufSize = Math.floor(c.sampleRate * 0.08);
    const buf = c.createBuffer(1, bufSize, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1);
    const src = c.createBufferSource();
    src.buffer = buf;
    const filter = c.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1200;
    filter.Q.value = 0.8;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.7, c.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + delay + 0.12);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);
    src.start(c.currentTime + delay);
    src.stop(c.currentTime + delay + 0.15);
  }

  // ── Clap sequence (n claps, spaced) ────────────────────────
  function clapSequence(n=3, bpm=80) {
    const interval = 60 / bpm;
    for (let i = 0; i < n; i++) playClap(i * interval);
  }

  // ── Phonics: REAL phoneme via TTS + supporting tone ─────────
  // FIX: the old version only ever played PHONICS_FREQS[letter] for a
  // single tone — for digraphs ("sh","ch","th") and blends ("sat") it
  // silently fell back to a default tick because a tone can't represent
  // a phoneme at all. Now it speaks the actual sound and uses the tone
  // only as a short supporting chime.
  const PHONICS_FREQS = {
    s:320, m:280, a:440, b:390, c:370, d:350, e:460,
    f:300, g:380, h:420, i:480, j:360, k:365, l:340,
    n:290, o:500, p:400, q:410, r:330, t:355, u:510,
    v:310, w:430, x:385, y:450, z:270,
  };
  const PHONICS_SPOKEN = {
    sh:"shh", ch:"ch", th:"th", ng:"ng", ck:"k", qu:"kw",
    ph:"f", wh:"wuh", oo:"oo", ee:"ee", ea:"ee", ai:"ay",
    oa:"oh", ou:"ow", ow:"ow", igh:"eye", ar:"ar", er:"er",
    ir:"er", or:"or", ur:"er", aw:"aw", oy:"oy", oi:"oy",
  };

  function playPhonics(letterOrBlend, repetitions=2) {
    const key = (letterOrBlend || "").toLowerCase();
    const spoken = PHONICS_SPOKEN[key] || key; // digraph → spoken form, else speak as-is (letter or whole word)
    const chimeFreq = PHONICS_FREQS[key[0]] || 400;
    for (let i = 0; i < repetitions; i++) {
      playTone({ freq:chimeFreq, type:"sine", dur:0.16, vol:0.22, delay: i * 0.5 });
    }
    setTimeout(() => speak(spoken, { rate:0.7, pitch:1.15 }), 120);
  }

  // ── Reward chime (ascending arpeggio) ──────────────────────
  function playReward() {
    [523, 659, 784, 1047].forEach((f, i) =>
      playTone({ freq:f, type:"sine", dur:0.25, vol:0.3, delay: i * 0.12 })
    );
  }

  // ── Correct ping ───────────────────────────────────────────
  function playCorrect() {
    playTone({ freq:880, type:"sine", dur:0.15, vol:0.3 });
    playTone({ freq:1100, type:"sine", dur:0.15, vol:0.25, delay:0.13 });
  }

  // ── Try again gentle tone ──────────────────────────────────
  function playTryAgain() {
    playTone({ freq:300, type:"sine", dur:0.2, vol:0.2 });
    playTone({ freq:260, type:"sine", dur:0.2, vol:0.2, delay:0.18 });
  }

  // ── Countdown beeps ────────────────────────────────────────
  function playCountdown(n=3, onTick) {
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        playTone({ freq: i === n-1 ? 880 : 440, type:"sine", dur:0.12, vol:0.3 });
        if (onTick) onTick(i);
      }, i * 700);
    }
  }

  // ── Text-to-Speech — voiceschanged race + Chrome gap fixed ──
  // FIX: speak() previously had no way to detect a SILENT failure — on
  // sandboxed iframes (Claude artifact preview) speechSynthesis.speak()
  // can be called successfully with zero error, yet produce no audio at
  // all because the Permissions-Policy blocks the underlying autoplay/
  // speech feature. onstart never fires in that case. We now watch for
  // that and call onFail so the caller can fall back to something the
  // sandbox CAN do (Web Audio tones), instead of silently doing nothing.
  function speak(text, { rate=0.85, pitch=1.1, lang="en-ZA" }={}, onEnd, onFail) {
    if (!window.speechSynthesis) { if (onFail) onFail(); if (onEnd) onEnd(); return; }
    window.speechSynthesis.cancel();
    const doSpeak = () => {
      const utt = new SpeechSynthesisUtterance(text);
      utt.rate = rate; utt.pitch = pitch; utt.lang = lang;
      const voices = window.speechSynthesis.getVoices();
      const best = voices.find(v => v.lang.startsWith("en-ZA"))
        || voices.find(v => v.lang.startsWith("en-GB"))
        || voices.find(v => v.lang.startsWith("en-US"))
        || voices.find(v => v.lang.startsWith("en"));
      if (best) utt.voice = best;
      let started = false;
      utt.onstart = () => { started = true; };
      utt.onend = () => { if (onEnd) onEnd(); };
      utt.onerror = () => { if (onFail) onFail(); if (onEnd) onEnd(); };
      // Watchdog: if speech hasn't actually started within 1.2s, the
      // sandbox is silently swallowing it — fire the fallback.
      setTimeout(() => { if (!started && onFail) onFail(); }, 1200);
      setTimeout(() => {
        try { window.speechSynthesis.speak(utt); } catch(e) { if (onFail) onFail(); if (onEnd) onEnd(); }
      }, 100); // required gap after cancel() on Android Chrome
    };
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) doSpeak();
    else window.speechSynthesis.addEventListener("voiceschanged", doSpeak, { once:true });
  }

  function stopSpeech() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  return { playTone, playClap, clapSequence, playPhonics, playReward, playCorrect, playTryAgain, playCountdown, speak, stopSpeech, unlock };
})();

// ── useAudio hook ───────────────────────────────────────────
function useAudio() {
  const [enabled, setEnabled] = useState(true);
  const [ttsBlocked, setTtsBlocked] = useState(false); // true once we detect sandboxed/silent TTS
  const wrap = (fn) => (...args) => { if (enabled) fn(...args); };
  const speakWrap = (text, opts, onEnd, onFail) => {
    if (!enabled) { if (onEnd) onEnd(); return; }
    AudioEngine.speak(text, opts, onEnd, () => { setTtsBlocked(true); if (onFail) onFail(); });
  };
  return {
    enabled, setEnabled, ttsBlocked,
    clap: wrap(AudioEngine.clapSequence),
    phonics: wrap(AudioEngine.playPhonics),
    reward: wrap(AudioEngine.playReward),
    correct: wrap(AudioEngine.playCorrect),
    tryAgain: wrap(AudioEngine.playTryAgain),
    countdown: wrap(AudioEngine.playCountdown),
    speak: speakWrap,
    stopSpeech: AudioEngine.stopSpeech,
    unlock: AudioEngine.unlock,
  };
}


// ============================================================
// LIFE NPC × E.I.S.S — PLATFORM v3.1
// "KNOW · LED · EDGE · NOW"
// Learning Is Fun Edutainment NPC — A Global Edutainment Brand
// EduCreat'Us Infrastructure & Systems Solutions
//
// SIGNATURE FORMATS:
// 1. Knowledge Card  2. Diagnostic Sheet  3. Ranking Ladder
// 4. Story Journey   5. Function Chart    6. Life Lesson Card
// 7. Growth Mirror   8. Memory Check (Spaced Review)
// ============================================================

// ─── DESIGN SYSTEM ──────────────────────────────────────────
// Design direction: "Living Classroom"
// The ONE bold move: Module cards use a hand-drawn border system
// that mimics chalkboard frames — warm, human, anti-corporate.
// Everything else is disciplined restraint.

const T = {
  // Core palette
  ink:      "#0D0D0D",
  chalk:    "#FAF8F4",
  board:    "#1B3A2D",  // deep blackboard green
  dust:     "#C8C0A8",  // chalk dust cream
  ember:    "#C4622D",  // warm orange-red
  gold:     "#D4A017",  // learning gold
  sunGold:  "#F0C040",
  sage:     "#4A7C59",  // growth green
  cobalt:   "#1A3A6B",  // authority blue
  mahogany: "#6B2D0F",
  terracotta:"#B8522A",
  sky:      "#2E7FB8",
  rose:     "#B83A5A",
  white:    "#FFFFFF",
  danger:   "#C0392B",
  success:  "#1E8449",
  ash:      "#8A8A8A",

  // Type
  display: "'Georgia', 'Times New Roman', serif",
  body:    "'Segoe UI', system-ui, sans-serif",
  mono:    "'Courier New', monospace",

  // Radius
  r4:"4px", r8:"8px", r12:"12px", r16:"16px", r24:"24px", rFull:"9999px",

  shadow: "0 2px 12px rgba(0,0,0,0.1)",
  shadowLg: "0 8px 32px rgba(0,0,0,0.16)",
  glow: "0 0 24px rgba(212,160,23,0.3)",
};

// Format colour codes
const FORMAT_COLORS = {
  knowledge:    T.cobalt,
  diagnostic:   T.rose,
  ranking:      T.gold,
  journey:      T.sage,
  function_chart: T.terracotta,
  life_lesson:  T.board,
  growth_mirror: T.mahogany,
};

// ─── PRICING ──────────────────────────────────────────────────
const PRICING = {
  currency: "ZAR",
  symbol: "R",
  standardMonthly: 250,
  promoActive: true,
  promoPct: 50,
  get promoMonthly() { return Math.round(this.standardMonthly * (1 - this.promoPct/100)); },
  promoLabel: "Founding Cohort Offer",
};

// ─── GLOBAL CURRICULA (Grade R – 12, not limited to one country) ─
// 10 frameworks selected for global reach + track record. SA content
// (CAPS) sits alongside them as ONE option among many, not the default.
const CURRICULA = [
  { id:"caps", name:"CAPS", region:"South Africa", desc:"Curriculum and Assessment Policy Statement", range:"R–12" },
  { id:"ieb", name:"IEB", region:"South Africa (Independent)", desc:"Independent Examinations Board", range:"R–12" },
  { id:"ib", name:"IB", region:"Global", desc:"International Baccalaureate (PYP/MYP/DP)", range:"3–12" },
  { id:"igcse", name:"Cambridge IGCSE / Cambridge Pathway", region:"Global", desc:"Cambridge Assessment International Education", range:"R–12" },
  { id:"commoncore", name:"Common Core", region:"United States", desc:"US Common Core State Standards", range:"K–12" },
  { id:"national_uk", name:"National Curriculum (England)", region:"United Kingdom", desc:"UK Dept for Education framework", range:"R–13 (Y1–Y13)" },
  { id:"acara", name:"Australian Curriculum", region:"Australia", desc:"ACARA F–10 + senior pathways", range:"F–12" },
  { id:"cbse", name:"CBSE", region:"India", desc:"Central Board of Secondary Education", range:"1–12" },
  { id:"singapore", name:"Singapore Curriculum (MOE)", region:"Singapore", desc:"Consistently top-ranked in global learning outcomes (PISA/TIMSS)", range:"1–12" },
  { id:"finland", name:"Finnish National Core Curriculum", region:"Finland", desc:"Benchmark for learner wellbeing + outcomes globally", range:"R–12" },
];
// Selection basis: PISA/TIMSS performance history (Singapore, Finland),
// global mobility/recognition (IB, Cambridge IGCSE), market scale (Common
// Core, CBSE, National UK, ACARA), and home-market depth (CAPS, IEB).
// Architecture supports adding more curricula without code changes —
// each module can declare `curriculumTags: ["caps","ib","cbse"]` etc.
const GRADES = ["R","1","2","3","4","5","6","7","8","9","10","11","12","Adult"];

// ─── STORY PROTAGONISTS ───────────────────────────────────────
// Narrative Pedagogy (Bruner): every module is framed around a protagonist.
// A learner can either follow a cast character OR cast themselves as the
// protagonist of their own ORB Pact journey.
const PROTAGONISTS = [
  { id:"self", name:"You", icon:"🪞", isSelf:true, bio:"The protagonist is you. Every story below speaks directly to your week, your choices, your growth." },
  { id:"amara", name:"Amara", icon:"🌍", origin:"Lagos / global diaspora", bio:"Self-taught coder turned community tutor, building income from skills she taught herself." },
  { id:"thando", name:"Thando", icon:"🤝", origin:"Soweto, South Africa", bio:"Organises peer study circles; lives the Ubuntu leadership track daily." },
  { id:"mei", name:"Mei", icon:"📊", origin:"Singapore", bio:"Methodical planner who turns small budgets into long-term savings habits." },
  { id:"diego", name:"Diego", icon:"🛠️", origin:"São Paulo", bio:"Runs a small repair business from his phone; obsessed with digital tools." },
];

// ─── THE UBUNTU STANDARD ──────────────────────────────────────
// Ubuntu philosophy appears on LIFE NPC because it is a *pedagogical*
// asset (Self-Determination Theory's "Relatedness" pillar), not a
// decorative one. Content only qualifies for the Ubuntu badge if it
// passes all four tests below.
const UBUNTU_STANDARD = {
  name:"The Ubuntu Standard",
  criteria: [
    { test:"Collective Outcome", q:"Does the content show how one person's growth lifts a group, not just the individual?" },
    { test:"Attributed & Specific", q:"Is the quote/practice sourced to a real tradition or person — not a generic inspirational line?" },
    { test:"Actionable", q:"Does it convert into a concrete behaviour the learner can do this week (not just a feeling)?" },
    { test:"Reciprocal", q:"Does it ask the learner to give something back to their community, not only receive?" },
  ],
  quotes: [
    { text:"A person is a person through other persons.", source:"Umuntu ngumuntu ngabantu — Nguni proverb (Zulu/Xhosa)" },
    { text:"I am because we are, and because we are, therefore I am.", source:"John Mbiti, summarising Ubuntu cosmology" },
    { text:"My humanity is bound up in yours, for we can only be human together.", source:"Archbishop Desmond Tutu" },
  ],
};

// ─── SPACED REVIEW ENGINE (Ebbinghaus intervals) ──────────────
const REVIEW_INTERVALS_DAYS = [1, 3, 7, 21];
const SPACED_REVIEW = {
  // For a completed module, figure out which review checkpoint is due now.
  getDueReviews: (user) => {
    const progress = user?.progress || {};
    const reviewLog = user?.reviewLog || {};
    const now = Date.now();
    const due = [];
    Object.keys(progress).forEach(modId => {
      const completedAt = new Date(progress[modId].at).getTime();
      const log = reviewLog[modId] || [];
      const nextStage = log.length; // how many checkpoints already done
      if (nextStage >= REVIEW_INTERVALS_DAYS.length) return; // fully reviewed
      const dueAt = completedAt + REVIEW_INTERVALS_DAYS[nextStage] * 24 * 60 * 60 * 1000;
      if (now >= dueAt) due.push({ modId, stage: nextStage, intervalDays: REVIEW_INTERVALS_DAYS[nextStage] });
    });
    return due;
  },
  // Quick true/false-style recall question generated from the module's core idea.
  buildPrompt: (mod) => `In one sentence: what was the ONE action "${mod.title}" asked you to take, and have you done it since?`,
};

// ─── PROGRESS PACE ENGINE (falling-behind detection + catch-up plan) ─
// Assumes a fixed-length cohort programme (one module = one week, length =
// MODS.length weeks). Compares calendar weeks elapsed since enrolment
// against modules actually completed, and turns the gap into a concrete
// weekly target — not just a vague "you're behind" message.
const PROGRESS_PACE = {
  compute: (user) => {
    const totalWeeks = MODS.length;
    const startedAt = new Date(user.createdAt || Date.now()).getTime();
    const weeksElapsed = Math.max(0, (Date.now() - startedAt) / (7*24*60*60*1000));
    const expectedDone = Math.min(totalWeeks, Math.floor(weeksElapsed) + 1);
    const actualDone = Object.keys(user.progress||{}).length;
    const weeksRemaining = Math.max(0.5, totalWeeks - weeksElapsed);
    const modulesRemaining = Math.max(0, totalWeeks - actualDone);
    const gap = expectedDone - actualDone; // positive = behind
    const weeklyPaceNeeded = modulesRemaining>0 ? Math.round((modulesRemaining/weeksRemaining)*10)/10 : 0;

    let status, color, message;
    if (actualDone >= totalWeeks) {
      status = "Complete"; color = T.success;
      message = "You've finished the full programme. Time to build your next portfolio piece or apply to tutor.";
    } else if (gap <= 0) {
      status = "On Track"; color = T.success;
      message = gap < 0 ? `You're ${Math.abs(gap)} module(s) ahead of schedule. Keep this pace and you'll finish early.`
                         : "You're exactly on pace. One module a week keeps you on schedule.";
    } else if (gap === 1) {
      status = "Slightly Behind"; color = T.gold;
      message = `You're 1 module behind. Complete ${weeklyPaceNeeded} module(s)/week from now to finish on time.`;
    } else {
      status = "Falling Behind"; color = T.danger;
      message = `You're ${gap} modules behind schedule. To finish on time you now need ${weeklyPaceNeeded} module(s) per week — about ${Math.round(weeklyPaceNeeded*7)} day(s) apart. Consider a catch-up session with your facilitator.`;
    }
    return { totalWeeks, expectedDone, actualDone, gap, weeksRemaining: Math.round(weeksRemaining*10)/10, weeklyPaceNeeded, status, color, message };
  },
};

// ─── QUOTE LIBRARY (one relevant quote per track, shown on activity pages) ─
const QUOTES = {
  Self:       { text:"Knowing yourself is the beginning of all wisdom.", source:"Aristotle" },
  Literacy:   { text:"The man who does not read good books has no advantage over the man who cannot read them.", source:"Mark Twain" },
  Finance:    { text:"Do not save what is left after spending; spend what is left after saving.", source:"Warren Buffett" },
  Leadership: { text:"If you want to go fast, go alone. If you want to go far, go together.", source:"African proverb" },
  Digital:    { text:"Technology is best when it brings people together.", source:"Matt Mullenweg" },
  Portfolio:  { text:"What gets measured gets managed.", source:"Peter Drucker" },
  Default:    { text:"A person is a person through other persons.", source:"Umuntu ngumuntu ngabantu — Nguni proverb" },
};

// ─── SUPPORT SERVICES (human-assisted tiers beyond the self-serve app) ─
const SERVICES = [
  { id:"homework", icon:"📝", title:"Homework Assistance", desc:"Stuck on a specific task from school or t
