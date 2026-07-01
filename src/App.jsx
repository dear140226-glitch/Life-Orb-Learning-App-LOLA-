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
  { id:"homework", icon:"📝", title:"Homework Assistance", desc:"Stuck on a specific task from school or this programme? Get it unblocked, not done for you.", cadence:"Async via Facilitator Chat · same-day reply window" },
  { id:"project", icon:"🧩", title:"Project Assistance", desc:"Structured guidance on bigger deliverables — a business plan, a PoE submission, a school project.", cadence:"Milestone check-ins, scoped per project" },
  { id:"private", icon:"👤", title:"Private Tutoring (1:1)", desc:"One-on-one sessions with a facilitator, paced entirely to you.", cadence:"Scheduled sessions · premium tier" },
  { id:"group", icon:"👥", title:"Group Tutoring", desc:"Small cohort sessions (3–8 learners) — Ubuntu-style peer learning with a facilitator guiding the room.", cadence:"Scheduled sessions · cohort tier" },
];

// ─── LEARNER PROFILER ENGINE ─────────────────────────────────
const PROFILER = {
  init: () => ({
    literacyLevel: 3,       // 1-5
    numeracyLevel: 3,
    learningStyle: "visual",
    motivationType: "social",
    vulnerabilityScore: 5,  // 1-10 (10=high vulnerability)
    growthVelocity: 0,
    communityConnectedness: 0,
    monetizationReadiness: 0,
    attentionSpan: "medium",
    languageDominance: "english",
  }),
  update: (profile, evidence) => {
    const words = (evidence || "").split(" ").length;
    const hasUbuntu = /communit|togeth|ubuntu|we |our |family/i.test(evidence);
    const hasMoney = /rand|money|earn|business|income|work|job/i.test(evidence);
    const newProfile = { ...profile };
    if (words > 80) newProfile.literacyLevel = Math.min(5, profile.literacyLevel + 0.2);
    if (hasUbuntu) newProfile.communityConnectedness = Math.min(10, profile.communityConnectedness + 1);
    if (hasMoney) newProfile.monetizationReadiness = Math.min(10, profile.monetizationReadiness + 1);
    newProfile.growthVelocity = words > 50 ? profile.growthVelocity + 1 : profile.growthVelocity;
    return newProfile;
  },
  getRecommendedFormat: (profile) => {
    if (profile.learningStyle === "visual") return "knowledge";
    if (profile.literacyLevel < 2) return "function_chart";
    if (profile.communityConnectedness > 5) return "life_lesson";
    return "knowledge";
  },
  getPathMessage: (profile) => {
    if (profile.vulnerabilityScore >= 7) return "Your learning path focuses on immediate life skills and income pathways.";
    if (profile.monetizationReadiness >= 5) return "You're ready for the entrepreneurship track. Let's accelerate.";
    if (profile.communityConnectedness >= 7) return "Ubuntu leadership track activated. You're built to lead.";
    return "Your personalised path is building week by week.";
  },
};

// ─── RUBRIC ENGINE ───────────────────────────────────────────
const RUBRIC = {
  score: (text, history) => {
    const words = (text || "").split(" ").filter(Boolean).length;
    const hasReflection = /I |me |my |felt |noticed |realised |learned /i.test(text);
    const hasUbuntu = /communit|togeth|ubuntu|we |our |family|neighbour/i.test(text);
    const hasSpecific = /because|therefore|when|so that|in order|example/i.test(text);
    const growth = history?.length > 0 ? 12 : 8;
    const breakdown = {
      reflection: Math.min(30, Math.round(words / 4) * (hasReflection ? 1.3 : 0.8)),
      ubuntu: Math.min(25, hasUbuntu ? 22 : 10),
      evidence: Math.min(20, Math.round(words / 6)),
      growth,
      completion: words > 30 ? 10 : words > 10 ? 6 : 2,
    };
    const total = Math.min(100, Object.values(breakdown).reduce((a,b) => a+b, 0));
    return { total, breakdown };
  },
  grade: (score) => {
    if (score >= 90) return { label:"Distinction", color:T.gold, badge:"🏆", next:"You're at mastery level. Try teaching this to someone else." };
    if (score >= 75) return { label:"Merit", color:T.sage, badge:"🌟", next:"Strong work. Push your next reflection to include more community examples." };
    if (score >= 60) return { label:"Competent", color:T.sky, badge:"✅", next:"Good foundation. Add more 'because' statements to deepen your analysis." };
    if (score >= 40) return { label:"Developing", color:T.ember, badge:"📈", next:"You're growing. Try writing 20 more words next time — detail is power." };
    return { label:"Beginning", color:T.ash, badge:"🌱", next:"Every great learner started here. Write honestly — 30 words minimum." };
  },
};

// ─── DATABASE LAYER ──────────────────────────────────────────
const DB = {
  getUser: (email, pin) => {
    const users = JSON.parse(localStorage.getItem("lifev3_users") || "[]");
    return users.find(u => u.email===email && u.pin===pin) || null;
  },
  createUser: (data) => {
    const users = JSON.parse(localStorage.getItem("lifev3_users") || "[]");
    if (users.find(u => u.email===data.email)) return { error:"Email already registered." };
    const user = {
      ...data, id:Date.now().toString(), createdAt:new Date().toISOString(),
      progress:{}, evidence:[], points:0, grades:{}, messages:[],
      coins:0, profile:PROFILER.init(), streak:0, lastSeen:new Date().toISOString(),
      reviewLog:{},
    };
    users.push(user);
    localStorage.setItem("lifev3_users", JSON.stringify(users));
    return { data:user };
  },
  updateUser: (id, updates) => {
    const users = JSON.parse(localStorage.getItem("lifev3_users") || "[]");
    const i = users.findIndex(u => u.id===id);
    if (i===-1) return null;
    users[i] = { ...users[i], ...updates };
    localStorage.setItem("lifev3_users", JSON.stringify(users));
    return users[i];
  },
  saveEvidence: (userId, ev) => {
    const users = JSON.parse(localStorage.getItem("lifev3_users") || "[]");
    const i = users.findIndex(u => u.id===userId);
    if (i===-1) return null;
    const scored = RUBRIC.score(ev.text, users[i].evidence);
    const g = RUBRIC.grade(scored.total);
    const newProfile = PROFILER.update(users[i].profile, ev.text);
    const coins = Math.floor(scored.total / 10);
    const entry = { ...ev, id:Date.now(), uploadedAt:new Date().toISOString(), score:scored, grade:g };
    users[i].evidence = [...(users[i].evidence||[]), entry];
    users[i].points = (users[i].points||0) + ev.pts;
    users[i].coins = (users[i].coins||0) + coins;
    users[i].grades = { ...(users[i].grades||{}), [ev.modId]:scored };
    users[i].profile = newProfile;
    users[i].progress = { ...(users[i].progress||{}), [ev.modId]:{ at:new Date().toISOString() } };
    localStorage.setItem("lifev3_users", JSON.stringify(users));
    return users[i];
  },
  sendMsg: (userId, msg) => {
    const users = JSON.parse(localStorage.getItem("lifev3_users") || "[]");
    const i = users.findIndex(u => u.id===userId);
    if (i===-1) return null;
    users[i].messages = [...(users[i].messages||[]), { ...msg, id:Date.now(), ts:new Date().toISOString() }];
    localStorage.setItem("lifev3_users", JSON.stringify(users));
    return users[i];
  },
  logReview: (userId, modId, stage, recalled) => {
    const users = JSON.parse(localStorage.getItem("lifev3_users") || "[]");
    const i = users.findIndex(u => u.id===userId);
    if (i===-1) return null;
    const reviewLog = { ...(users[i].reviewLog||{}) };
    reviewLog[modId] = [...(reviewLog[modId]||[]), { stage, recalled, at:new Date().toISOString() }];
    users[i].reviewLog = reviewLog;
    users[i].coins = (users[i].coins||0) + (recalled ? 2 : 1); // small reward either way, more for recall
    localStorage.setItem("lifev3_users", JSON.stringify(users));
    return users[i];
  },
  getAllUsers: () => JSON.parse(localStorage.getItem("lifev3_users") || "[]"),
};

// ─── CURRICULUM WITH FORMAT TAGS ─────────────────────────────
const MODS = [
  { id:"m1", week:1, title:"Know Yourself First", format:"life_lesson", pts:20,
    icon:"🪞", color:T.board, track:"Self", curriculumTags:["caps","ieb","ib","igcse"],
    orbPact:"The ORB Pact begins with self — who are you before the world defines you?",
    content:"Ubuntu teaches: \"A person is a person through other persons\" (Umuntu ngumuntu ngabantu). Before learning anything, know who you are learning FOR and WHY. Wherever you are in the world, the first act of growth is self-knowledge.",
    activity:"Write 3 honest sentences: Who am I right now? What do I truly value? What do I want to give back to my community in 5 years?",
    tip:"There are no wrong answers here. Only honest ones.",
    formatItems:["Your name is your first identity", "Your values guide every decision", "Your community is your responsibility"],
  },
  { id:"m2", week:2, title:"Reading With Purpose", format:"diagnostic",
    pts:20, icon:"📖", color:T.cobalt, track:"Literacy", curriculumTags:["commoncore","national_uk","cbse","acara"],
    orbPact:"Every text has a purpose. Find it, and you find power.",
    content:"Critical reading asks: WHO wrote this? WHY? FOR WHOM? Misinformation spreads fastest wherever educational access is limited — from townships to small towns to crowded cities. Reading critically is protection, anywhere you live.",
    activity:"Find any article, flyer, or social post. Ask: Who wrote it? What do they want me to believe? What question does it NOT answer?",
    tip:"The most powerful readers weren't those who read most — they questioned most.",
    diagnosticCategories:["Type A: News Media","Type B: Social Media","Type C: Advertising","Type D: Educational"],
  },
  { id:"m3", week:3, title:"Money Talks", format:"function_chart",
    pts:25, icon:"💰", color:T.terracotta, track:"Finance", curriculumTags:["caps","commoncore","cbse","singapore"],
    orbPact:"Money earned with knowledge is worth more than ten times earned in ignorance.",
    content:"Income minus Expenses = Savings or Debt. This one equation determines 80% of financial outcomes, in any currency. Wherever formal financial education is scarce, money knowledge is survival knowledge.",
    activity:"Create a budget for 500 units of your local currency: split between needs (food, transport), wants (airtime/data), and savings. Explain each decision.",
    tip:"Saving a small amount weekly compounds fast. Small numbers, big change.",
    functionItems:["Earn → Income streams", "Spend → Needs vs wants", "Save → Emergency fund", "Grow → Investment basics", "Give → Ubuntu economy"],
  },
  { id:"m4", week:4, title:"Ubuntu Leadership", format:"ranking",
    pts:30, icon:"🤝", color:T.sage, track:"Leadership", curriculumTags:["ieb","ib","acara"],
    orbPact:"The strongest leader lifts everyone around them higher.",
    content:"Ubuntu leadership means collective success. The person who organises others is worth more than the one who performs alone. In high-vulnerability communities, a single effective leader changes outcomes for 50 people.",
    activity:"Organise a discussion with 3+ people. Topic: What does our community need most? Document what you learned from others.",
    tip:"You don't need a title to lead. You need a question and a circle.",
    rankings:["#1: Listen before you speak","#2: Ask the hard questions","#3: Share the credit","#4: Stay when it's hard","#5: Make others visible"],
  },
  { id:"m5", week:5, title:"Digital Literacy & AI", format:"knowledge",
    pts:25, icon:"💻", color:T.sky, track:"Digital", curriculumTags:["igcse","national_uk","commoncore","singapore"],
    orbPact:"The tool is not the master. You are.",
    content:"AI tools like Claude are everywhere. Learn to use them critically: verify what they say, understand their limits, and never let them replace your own thinking. Your phone is your most powerful business tool — if you know how to use it.",
    activity:"Ask an AI one question about your community's biggest challenge. Then find a real human expert and compare the answers.",
    tip:"AI knows the world. Your community elders know your street. Both matter.",
    knowledgeItems:["Claude — Long-form thinking","ChatGPT — Quick drafts","Gemini — Free Google AI","Perplexity — Research","NotebookLM — Study tool","Canva AI — Design"],
  },
  { id:"m6", week:6, title:"Portfolio of Evidence", format:"growth_mirror",
    pts:50, icon:"🏆", color:T.mahogany, track:"Portfolio", curriculumTags:["caps","ieb","ib","igcse","commoncore","national_uk","acara","cbse","singapore","finland"],
    orbPact:"Evidence is your voice when you are not in the room.",
    content:"Your Portfolio of Evidence is proof that growth happened. It protects you in interviews. It speaks for you in institutions. Wherever formal credentials are scarce or expensive, a well-built PoE IS a credential.",
    activity:"Review your 5 previous submissions. Write 200 words: How am I different from the person who started Week 1?",
    tip:"The goal was never perfection. The goal was movement.",
    milestones:["Week 1: Self-awareness", "Week 2: Critical thinking", "Week 3: Financial literacy", "Week 4: Leadership", "Week 5: Digital skills", "Week 6: Portfolio complete"],
  },
];

// ─── SHARED COMPONENTS ───────────────────────────────────────
const css = {
  btn: (bg, fg=T.white, size="md") => ({
    background:bg, color:fg, border:"none", borderRadius:T.r8,
    padding:size==="sm"?"7px 14px":size==="lg"?"14px 28px":"10px 20px",
    fontSize:size==="sm"?"0.76rem":"0.9rem",
    fontWeight:"700", cursor:"pointer", fontFamily:T.body, letterSpacing:"0.3px",
  }),
  input: { width:"100%", padding:"12px 16px", borderRadius:T.r8, border:`1.5px solid #E8E4DC`, fontSize:"0.93rem", background:T.white, boxSizing:"border-box", fontFamily:T.body, marginBottom:"14px" },
  label: { display:"block", fontSize:"0.68rem", fontWeight:"800", color:T.mahogany, marginBottom:"5px", textTransform:"uppercase", letterSpacing:"1px" },
  card: { background:T.white, borderRadius:T.r16, padding:"20px", marginBottom:"14px", boxShadow:T.shadow },
  badge: (color, fg=T.white) => ({ background:color, color:fg, borderRadius:T.rFull, padding:"3px 11px", fontSize:"0.68rem", fontWeight:"800", display:"inline-block" }),
};

function PBar({ pct, color=T.gold, h=8 }) {
  return (
    <div style={{ height:h, borderRadius:T.rFull, background:"#EEE8DC", overflow:"hidden" }}>
      <div style={{ height:"100%", width:`${Math.min(pct,100)}%`, background:color, borderRadius:T.rFull, transition:"width 0.6s ease" }} />
    </div>
  );
}

function Toast({ msg, type="success" }) {
  if (!msg) return null;
  return <div style={{ position:"fixed", top:20, left:"50%", transform:"translateX(-50%)", background:type==="err"?T.danger:T.success, color:T.white, padding:"11px 22px", borderRadius:T.r12, fontWeight:"700", zIndex:9999, fontSize:"0.85rem", boxShadow:T.shadowLg }}>{msg}</div>;
}

// ─── FORMAT RENDERERS ────────────────────────────────────────

// FORMAT 1: Knowledge Card (like "11 Free AI Tools")
function KnowledgeCard({ mod }) {
  return (
    <div style={{ ...css.card, borderTop:`4px solid ${mod.color}` }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"12px" }}>
        <span style={css.badge(mod.color)}>📋 KNOWLEDGE CARD</span>
        <span style={{ fontSize:"1.5rem" }}>{mod.icon}</span>
      </div>
      <div style={{ fontFamily:T.display, fontSize:"1.1rem", fontWeight:"bold", color:T.ink, marginBottom:"14px" }}>{mod.title}</div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px" }}>
        {(mod.knowledgeItems||[]).map((item,i) => (
          <div key={i} style={{ background:T.chalk, borderRadius:T.r8, padding:"8px 10px", fontSize:"0.78rem", display:"flex", alignItems:"flex-start", gap:"6px" }}>
            <span style={{ color:mod.color, fontWeight:"800", flexShrink:0 }}>{i+1}</span>
            <span style={{ color:T.ink, lineHeight:1.4 }}>{item}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop:"12px", padding:"10px", background:mod.color+"15", borderRadius:T.r8, borderLeft:`3px solid ${mod.color}` }}>
        <div style={{ fontSize:"0.78rem", color:mod.color, fontWeight:"700", marginBottom:"3px" }}>💡 PRO TIP</div>
        <div style={{ fontSize:"0.8rem", color:T.ink, lineHeight:1.5 }}>{mod.tip}</div>
      </div>
    </div>
  );
}

// FORMAT 2: Diagnostic Sheet (like Stroke medical sheet)
function DiagnosticSheet({ mod }) {
  const categories = mod.diagnosticCategories || [];
  return (
    <div style={{ ...css.card, border:`2px solid ${mod.color}` }}>
      <div style={{ background:mod.color, margin:"-20px -20px 16px", padding:"14px 20px", borderRadius:`${T.r16} ${T.r16} 0 0` }}>
        <span style={{ color:T.white, fontWeight:"800", fontSize:"0.75rem", letterSpacing:"2px", textTransform:"uppercase" }}>🔬 DIAGNOSTIC SHEET</span>
        <div style={{ color:"rgba(255,255,255,0.9)", fontFamily:T.display, fontSize:"1.1rem", fontWeight:"bold", marginTop:"4px" }}>{mod.title}</div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px", marginBottom:"12px" }}>
        {categories.map((cat,i) => (
          <div key={i} style={{ background:T.chalk, borderRadius:T.r8, padding:"10px", textAlign:"center" }}>
            <div style={{ fontSize:"1rem", marginBottom:"4px" }}>{"📰📱📢📚"[i]}</div>
            <div style={{ fontSize:"0.72rem", fontWeight:"700", color:mod.color }}>{cat}</div>
          </div>
        ))}
      </div>
      <div style={{ background:T.chalk, borderRadius:T.r8, padding:"12px" }}>
        <div style={{ fontWeight:"800", fontSize:"0.75rem", color:mod.color, marginBottom:"6px" }}>CRITICAL QUESTION</div>
        <div style={{ fontSize:"0.85rem", color:T.ink, lineHeight:1.6 }}>{mod.orbPact}</div>
      </div>
    </div>
  );
}

// FORMAT 3: Ranking Ladder (like YouTube/Google ranking)
function RankingLadder({ mod }) {
  return (
    <div style={{ ...css.card, borderTop:`4px solid ${mod.color}` }}>
      <div style={{ display:"flex", gap:"10px", alignItems:"center", marginBottom:"14px" }}>
        <span style={{ fontSize:"2rem" }}>🏆</span>
        <div>
          <div style={{ fontSize:"0.68rem", color:T.ash, textTransform:"uppercase", fontWeight:"700" }}>🎖 RANKING LADDER</div>
          <div style={{ fontFamily:T.display, fontSize:"1.05rem", fontWeight:"bold", color:T.ink }}>{mod.title}</div>
        </div>
      </div>
      {(mod.rankings||[]).map((item,i) => (
        <div key={i} style={{ display:"flex", gap:"10px", alignItems:"center", padding:"10px", background:i===0?mod.color+"18":T.chalk, borderRadius:T.r8, marginBottom:"6px", border:i===0?`1.5px solid ${mod.color}`:"none" }}>
          <div style={{ width:"28px", height:"28px", borderRadius:"50%", background:i===0?mod.color:"#DDD", color:i===0?T.white:T.ash, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:"800", fontSize:"0.78rem", flexShrink:0 }}>
            {i+1}
          </div>
          <div style={{ fontSize:"0.83rem", color:T.ink, fontWeight:i===0?"700":"400", lineHeight:1.4 }}>{item}</div>
        </div>
      ))}
    </div>
  );
}

// FORMAT 4: Story Journey (like "Write the Full Story" steps)
function StoryJourney({ mod }) {
  const stages = ["Opening: Who you are", "Problem: What holds you back", "Attempts: What you tried", "Ending: How you grew"];
  return (
    <div style={{ ...css.card, background:`linear-gradient(160deg, ${mod.color}08, ${T.white})` }}>
      <div style={{ marginBottom:"14px" }}>
        <span style={css.badge(mod.color)}>📖 STORY JOURNEY</span>
        <div style={{ fontFamily:T.display, fontSize:"1.1rem", fontWeight:"bold", color:T.ink, marginTop:"8px" }}>{mod.title}</div>
        <div style={{ fontSize:"0.78rem", color:T.ash, marginTop:"3px" }}>Your learning follows a 4-stage story arc</div>
      </div>
      <div style={{ position:"relative" }}>
        {stages.map((stage,i) => (
          <div key={i} style={{ display:"flex", gap:"12px", marginBottom:"12px", alignItems:"flex-start" }}>
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", flexShrink:0 }}>
              <div style={{ width:"36px", height:"36px", borderRadius:"50%", background:mod.color, color:T.white, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:"800", fontSize:"0.9rem" }}>{i+1}</div>
              {i<3 && <div style={{ width:"2px", height:"24px", background:mod.color+"40", marginTop:"4px" }} />}
            </div>
            <div style={{ background:T.chalk, borderRadius:T.r8, padding:"10px 12px", flex:1 }}>
              <div style={{ fontSize:"0.7rem", color:mod.color, fontWeight:"800", marginBottom:"3px", textTransform:"uppercase" }}>{["OPENING","PROBLEM","3 ATTEMPTS","WARM ENDING"][i]}</div>
              <div style={{ fontSize:"0.83rem", color:T.ink, lineHeight:1.4 }}>{stage}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ background:mod.color, borderRadius:T.r8, padding:"10px 14px", textAlign:"center" }}>
        <div style={{ color:T.white, fontSize:"0.82rem", fontWeight:"700" }}>{mod.tip}</div>
      </div>
    </div>
  );
}

// FORMAT 5: Function Chart (like Complete Foods chart)
function FunctionChart({ mod }) {
  return (
    <div style={{ ...css.card }}>
      <div style={{ textAlign:"center", marginBottom:"16px" }}>
        <span style={css.badge(mod.color)}>📊 FUNCTION CHART</span>
        <div style={{ fontFamily:T.display, fontSize:"1.1rem", fontWeight:"bold", color:T.ink, marginTop:"8px" }}>{mod.title}</div>
        <div style={{ fontSize:"0.78rem", color:T.ash }}>What each financial skill does for you</div>
      </div>
      {(mod.functionItems||[]).map((item,i) => {
        const parts = item.split("→");
        const icons = ["💪","🏗️","🏃","🌱","🤲"];
        const colors = [T.terracotta, T.cobalt, T.sage, T.gold, T.rose];
        return (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:"12px", background:colors[i]+"12", borderRadius:T.r8, padding:"10px 14px", marginBottom:"8px", border:`1.5px solid ${colors[i]}30` }}>
            <div style={{ width:"36px", height:"36px", borderRadius:T.r8, background:colors[i], display:"flex", alignItems:"center", justifyContent:"center", fontSize:"1.1rem", flexShrink:0 }}>{icons[i]}</div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:"800", fontSize:"0.82rem", color:colors[i] }}>{parts[0]?.trim()}</div>
              <div style={{ fontSize:"0.78rem", color:T.ink, marginTop:"2px" }}>{parts[1]?.trim()}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// FORMAT 6: Life Lesson Card (LIFE NPC signature)
function LifeLessonCard({ mod }) {
  return (
    <div style={{ ...css.card, background:T.board, color:T.white }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:"14px" }}>
        <span style={css.badge(T.gold)}>🌍 LIFE LESSON CARD</span>
        <span style={{ fontSize:"2rem" }}>{mod.icon}</span>
      </div>
      <div style={{ fontFamily:T.display, fontSize:"1.2rem", fontWeight:"bold", marginBottom:"8px", lineHeight:1.3 }}>{mod.title}</div>
      <div style={{ background:"rgba(255,255,255,0.1)", borderRadius:T.r8, padding:"12px", marginBottom:"12px", borderLeft:`3px solid ${T.gold}` }}>
        <div style={{ fontSize:"0.68rem", color:T.gold, fontWeight:"800", marginBottom:"4px", letterSpacing:"1px" }}>ORB PACT</div>
        <div style={{ fontSize:"0.88rem", fontStyle:"italic", lineHeight:1.6 }}>"{mod.orbPact}"</div>
      </div>
      <div style={{ marginBottom:"12px" }}>
        {(mod.formatItems||[]).map((item,i) => (
          <div key={i} style={{ display:"flex", gap:"8px", marginBottom:"6px", fontSize:"0.82rem", lineHeight:1.5 }}>
            <span style={{ color:T.gold }}>▸</span>
            <span style={{ color:"rgba(255,255,255,0.88)" }}>{item}</span>
          </div>
        ))}
      </div>
      <div style={{ background:T.gold, borderRadius:T.r8, padding:"8px 14px", textAlign:"center" }}>
        <div style={{ color:T.ink, fontWeight:"800", fontSize:"0.82rem" }}>+{mod.pts} KNOWLEDGE POINTS · +{Math.floor(mod.pts/10)} KNOWLEDGE COINS</div>
      </div>
    </div>
  );
}

// FORMAT 7: Growth Mirror (LIFE NPC signature — portfolio)
function GrowthMirror({ mod, user }) {
  const totalDone = Object.keys(user?.progress||{}).length;
  const pct = Math.round(totalDone / MODS.length * 100);
  return (
    <div style={{ ...css.card }}>
      <div style={{ textAlign:"center", marginBottom:"16px" }}>
        <span style={css.badge(mod.color)}>🪞 GROWTH MIRROR</span>
        <div style={{ fontFamily:T.display, fontSize:"1.1rem", fontWeight:"bold", color:T.ink, marginTop:"8px" }}>{mod.title}</div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px", marginBottom:"14px" }}>
        <div style={{ background:`${T.danger}10`, borderRadius:T.r12, padding:"14px", textAlign:"center", border:`2px solid ${T.danger}30` }}>
          <div style={{ fontSize:"1.5rem" }}>🌱</div>
          <div style={{ fontSize:"0.72rem", fontWeight:"800", color:T.danger, textTransform:"uppercase", marginTop:"4px" }}>Week 1 Me</div>
          <div style={{ fontSize:"0.78rem", color:T.ash, marginTop:"4px" }}>Starting point</div>
        </div>
        <div style={{ background:`${T.success}10`, borderRadius:T.r12, padding:"14px", textAlign:"center", border:`2px solid ${T.success}30` }}>
          <div style={{ fontSize:"1.5rem" }}>🌳</div>
          <div style={{ fontSize:"0.72rem", fontWeight:"800", color:T.success, textTransform:"uppercase", marginTop:"4px" }}>Week 6 Me</div>
          <div style={{ fontSize:"0.78rem", color:T.ash, marginTop:"4px" }}>Growth destination</div>
        </div>
      </div>
      <div style={{ marginBottom:"10px" }}>
        {(mod.milestones||[]).map((m,i) => (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:"10px", marginBottom:"7px" }}>
            <div style={{ width:"20px", height:"20px", borderRadius:"50%", background:i < totalDone ? T.success : "#DDD", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.65rem", color:T.white, flexShrink:0 }}>
              {i < totalDone ? "✓" : i+1}
            </div>
            <div style={{ fontSize:"0.8rem", color:i < totalDone ? T.success : T.ash, fontWeight:i < totalDone ? "700" : "400" }}>{m}</div>
          </div>
        ))}
      </div>
      <PBar pct={pct} color={T.gold} h={10} />
      <div style={{ textAlign:"center", marginTop:"6px", fontSize:"0.75rem", color:T.ash }}>{pct}% of your journey complete</div>
    </div>
  );
}

// FORMAT 8: Phonics Card (Grade R / early literacy — visual-first, BL-blend style)
function PhonicsCard({ mod }) {
  const { phonicsLetter="A", phonicsWords=[], phonicsEmojis=[], phoneticSentence="", sightWords=[] } = mod;
  const pastelPairs = [
    { bg:"#FFF0F5", border:"#F9A8D4" },
    { bg:"#F0FFF4", border:"#86EFAC" },
    { bg:"#EFF6FF", border:"#93C5FD" },
    { bg:"#FFFBEB", border:"#FCD34D" },
    { bg:"#FAF5FF", border:"#C4B5FD" },
    { bg:"#FFF7ED", border:"#FCA5A1" },
  ];
  return (
    <div style={{ ...css.card, background:"linear-gradient(160deg,#FEFCE8,#FFF0F5)", border:"2px solid #FCD34D" }}>
      {/* Header */}
      <div style={{ textAlign:"center", marginBottom:"14px" }}>
        <span style={{ ...css.badge(T.rose), fontSize:"0.65rem", letterSpacing:"1px" }}>🔤 PHONICS CARD</span>
        <div style={{ fontFamily:T.display, fontSize:"1.1rem", fontWeight:"bold", color:T.ink, marginTop:"6px" }}>{mod.title}</div>
        <div style={{ fontSize:"0.75rem", color:T.ash, marginTop:"2px" }}>{mod.orbPact}</div>
      </div>

      {/* Big letter display */}
      <div style={{ textAlign:"center", marginBottom:"14px" }}>
        <div style={{ display:"inline-flex", gap:"12px", alignItems:"center", background:"white", borderRadius:T.r16, padding:"12px 28px", boxShadow:"0 4px 16px rgba(0,0,0,0.08)", border:"2px solid #FCD34D" }}>
          <span style={{ fontFamily:T.display, fontSize:"3.5rem", fontWeight:"900", color:T.rose, lineHeight:1 }}>{phonicsLetter.toUpperCase()}</span>
          <span style={{ fontFamily:T.display, fontSize:"2.5rem", fontWeight:"700", color:T.sky, lineHeight:1 }}>{phonicsLetter.toLowerCase()}</span>
        </div>
        <div style={{ marginTop:"8px", fontSize:"0.78rem", color:T.ash }}>Say it 3 times: <strong style={{ color:T.rose }}>/{phonicsLetter.toLowerCase()}/ /{phonicsLetter.toLowerCase()}/ /{phonicsLetter.toLowerCase()}/</strong></div>
      </div>

      {/* Word + emoji grid */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"8px", marginBottom:"14px" }}>
        {phonicsWords.slice(0,6).map((word, i) => (
          <div key={i} style={{ background:pastelPairs[i%6].bg, border:`2px solid ${pastelPairs[i%6].border}`, borderRadius:T.r12, padding:"10px 6px", textAlign:"center" }}>
            <div style={{ fontSize:"1.6rem", marginBottom:"4px" }}>{phonicsEmojis[i] || "⭐"}</div>
            <div style={{ fontSize:"0.82rem", fontWeight:"800", color:T.ink }}>
              <span style={{ color:T.rose, fontWeight:"900" }}>{word.slice(0, phonicsLetter.length)}</span>
              <span>{word.slice(phonicsLetter.length)}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Sight words strip */}
      {sightWords.length > 0 && (
        <div style={{ marginBottom:"12px" }}>
          <div style={{ fontSize:"0.68rem", fontWeight:"800", color:T.cobalt, textTransform:"uppercase", letterSpacing:"1px", marginBottom:"6px" }}>⭐ Read these words</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:"6px" }}>
            {sightWords.map((w,i) => (
              <span key={i} style={{ background:["#FEE2E2","#DCFCE7","#DBEAFE","#FEF9C3","#EDE9FE","#FCE7F3"][i%6], borderRadius:T.rFull, padding:"4px 14px", fontSize:"0.82rem", fontWeight:"700", color:T.ink }}>{w}</span>
            ))}
          </div>
        </div>
      )}

      {/* Sentence */}
      {phoneticSentence && (
        <div style={{ background:"white", borderRadius:T.r12, padding:"12px 14px", border:"2px solid #FCD34D", textAlign:"center" }}>
          <div style={{ fontSize:"0.68rem", color:T.gold, fontWeight:"800", marginBottom:"4px" }}>📖 READ THIS SENTENCE</div>
          <div style={{ fontSize:"0.92rem", color:T.ink, fontWeight:"700", lineHeight:1.7 }}>{phoneticSentence}</div>
        </div>
      )}
    </div>
  );
}

// FORMAT 9: Step-by-Step Card (Grade R / writing / sequenced skill — numbered panels)
function StepByStepCard({ mod }) {
  const { steps=[], stepEmojis=[], stepColors=[] } = mod;
  const defaultColors = [T.rose, T.cobalt, T.sage, T.terracotta, T.gold, T.mahogany, T.sky, T.ember];
  const defaultEmojis = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣"];
  return (
    <div style={{ ...css.card }}>
      {/* Header */}
      <div style={{ textAlign:"center", marginBottom:"14px" }}>
        <span style={{ ...css.badge(T.sage), fontSize:"0.65rem", letterSpacing:"1px" }}>🪜 STEP BY STEP</span>
        <div style={{ fontFamily:T.display, fontSize:"1.1rem", fontWeight:"bold", color:T.ink, marginTop:"6px" }}>{mod.title}</div>
        <div style={{ fontSize:"0.75rem", color:T.ash, marginTop:"2px" }}>{mod.orbPact}</div>
      </div>

      {/* Numbered step panels — 2-column grid like the SIB / daily habits images */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px", marginBottom:"12px" }}>
        {steps.map((step, i) => {
          const col = stepColors[i] || defaultColors[i % defaultColors.length];
          const em = stepEmojis[i] || defaultEmojis[i] || "⭐";
          const parts = step.split("::");
          const title = parts[0];
          const bullets = parts[1] ? parts[1].split("|") : [];
          return (
            <div key={i} style={{ background:`${col}12`, border:`2px solid ${col}30`, borderRadius:T.r12, padding:"12px 10px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:"6px", marginBottom:"6px" }}>
                <div style={{ width:"26px", height:"26px", borderRadius:"50%", background:col, color:T.white, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:"900", fontSize:"0.75rem", flexShrink:0 }}>{i+1}</div>
                <span style={{ fontSize:"1.1rem" }}>{em}</span>
              </div>
              <div style={{ fontWeight:"800", fontSize:"0.78rem", color:col, marginBottom:"4px", lineHeight:1.3 }}>{title}</div>
              {bullets.map((b,j) => (
                <div key={j} style={{ display:"flex", gap:"5px", fontSize:"0.72rem", color:T.ink, lineHeight:1.5, marginTop:"2px" }}>
                  <span style={{ color:col, flexShrink:0 }}>•</span>
                  <span>{b.trim()}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Remember strip */}
      {mod.tip && (
        <div style={{ background:`linear-gradient(90deg,${T.gold},${T.sunGold})`, borderRadius:T.r12, padding:"10px 14px", textAlign:"center" }}>
          <div style={{ color:T.ink, fontWeight:"800", fontSize:"0.8rem" }}>💛 Remember: {mod.tip}</div>
        </div>
      )}
    </div>
  );
}

// FORMAT 10: WH Questions Card (Grade R language development)
function WHQuestionsCard({ mod }) {
  const { whQuestions=[] } = mod;
  const colors = [T.rose, T.sage, T.cobalt, T.terracotta, T.mahogany, T.sky, T.ember];
  const bgPastels = ["#FFF0F5","#F0FFF4","#EFF6FF","#FFF7ED","#FAF5FF","#E0F7FA","#FFFBEB"];
  return (
    <div style={{ ...css.card, background:"linear-gradient(160deg,#FEFCE8,#F0FFF4)", border:"2px solid #86EFAC" }}>
      <div style={{ textAlign:"center", marginBottom:"14px" }}>
        <span style={{ ...css.badge(T.sage), fontSize:"0.65rem", letterSpacing:"1px" }}>❓ WH QUESTIONS</span>
        <div style={{ fontFamily:T.display, fontSize:"1.1rem", fontWeight:"bold", color:T.ink, marginTop:"6px" }}>{mod.title}</div>
        <div style={{ fontSize:"0.75rem", color:T.ash, marginTop:"2px", lineHeight:1.5 }}>{mod.orbPact}</div>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:"8px", marginBottom:"12px" }}>
        {whQuestions.map((q, i) => {
          const col = colors[i % colors.length];
          const bg = bgPastels[i % bgPastels.length];
          return (
            <div key={i} style={{ background:bg, border:`2px solid ${col}30`, borderRadius:T.r12, padding:"10px 12px", display:"flex", gap:"10px", alignItems:"flex-start" }}>
              <div style={{ width:"32px", height:"32px", borderRadius:"50%", background:col, color:T.white, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:"900", fontSize:"0.85rem", flexShrink:0, boxShadow:`0 2px 6px ${col}40` }}>{i+1}</div>
              <div style={{ flex:1 }}>
                <div style={{ display:"flex", gap:"8px", alignItems:"center", marginBottom:"4px" }}>
                  <span style={{ fontFamily:T.display, fontSize:"1rem", fontWeight:"900", color:col }}>{q.word}</span>
                  <span style={{ fontSize:"1.2rem" }}>{q.emoji}</span>
                  <span style={{ fontSize:"0.68rem", color:T.ash, fontStyle:"italic" }}>{q.purpose}</span>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:"2px" }}>
                  {q.examples.map((ex, j) => (
                    <div key={j} style={{ fontSize:"0.76rem", color:T.ink, display:"flex", gap:"5px" }}>
                      <span style={{ color:col, fontWeight:"700" }}>•</span>
                      <span>{ex}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {mod.tip && (
        <div style={{ background:`linear-gradient(90deg,${T.sage},#4ADE80)`, borderRadius:T.r12, padding:"10px 14px", textAlign:"center" }}>
          <div style={{ color:T.white, fontWeight:"800", fontSize:"0.8rem" }}>💚 Remember: {mod.tip}</div>
        </div>
      )}
    </div>
  );
}

// ─── AUDIO TOOLBAR ───────────────────────────────────────────
// Floats at bottom of lesson for Grade R & 1
// Buttons: 🔊 Read Aloud · 👏 Clap Counter · 🔤 Phonics · 🔇 Mute
function AudioBar({ mod, audio, targetText="" }) {
  const [clapCount, setClapCount] = useState(0);
  const [clapAnim, setClapAnim] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [showClapper, setShowClapper] = useState(false);

  const handleClap = () => {
    audio.unlock();
    audio.clap(1);
    setClapCount(n => n + 1);
    setClapAnim(true);
    setTimeout(() => setClapAnim(false), 300);
  };

  const handleRead = () => {
    audio.unlock();
    if (speaking) { audio.stopSpeech(); setSpeaking(false); return; }
    const text = targetText || mod.phoneticSentence || mod.orbPact || mod.title;
    setSpeaking(true);
    audio.speak(text, { rate:0.78, pitch:1.1 }, null, () => {
      // TTS was silently swallowed (sandboxed preview). Don't leave the
      // learner with nothing — give a tone-based "reading" cue instead
      // and surface why, so it's obvious this isn't a dead button.
      const words = Math.max(1, text.split(/\s+/).length);
      audio.clap(Math.min(words, 6));
    });
    // Estimate duration and reset flag
    setTimeout(() => setSpeaking(false), Math.max(text.length * 65, 2000));
  };

  const handlePhonics = () => {
    audio.unlock();
    if (mod.phonicsLetter) {
      audio.phonics(mod.phonicsLetter, 3);
    } else {
      // Clap syllable pattern for title
      const syllables = mod.title.replace(/[^a-zA-Z ]/g,"").split(" ").length;
      audio.clap(syllables);
    }
  };

  const resetClaps = () => { setClapCount(0); setShowClapper(false); };

  return (
    // FIX: was position:"sticky", bottom:0 — inside the Claude.ai artifact
    // iframe this creates a scroll context where the host app's own fixed
    // bottom chrome visually covers this bar and intercepts every tap.
    // Rendering it in normal document flow makes it scroll with the page
    // and removes the dead-zone entirely.
    <div style={{ background:T.white, borderTop:`2px solid ${mod.color}30`, padding:"10px 16px 18px", boxShadow:"0 -4px 20px rgba(0,0,0,0.10)" }}>
      {/* Clap counter expanded */}
      {showClapper && (
        <div style={{ background:T.chalk, borderRadius:T.r12, padding:"12px 16px", marginBottom:"10px", display:"flex", flexDirection:"column", alignItems:"center", gap:"8px" }}>
          <div style={{ fontSize:"0.68rem", color:T.ash, textTransform:"uppercase", letterSpacing:"1px" }}>👏 Clap Counter — tap for each word / syllable</div>
          <div style={{ fontFamily:T.display, fontSize:"3rem", fontWeight:"900", color:mod.color, lineHeight:1, transition:"transform 0.15s", transform:clapAnim?"scale(1.3)":"scale(1)" }}>
            {clapCount}
          </div>
          <div style={{ display:"flex", gap:"10px" }}>
            <button onClick={handleClap} style={{ background:mod.color, border:"none", color:T.white, borderRadius:T.r12, padding:"14px 28px", fontSize:"1.5rem", cursor:"pointer", boxShadow:`0 4px 12px ${mod.color}50`, fontWeight:"900" }}>
              👏
            </button>
            <button onClick={resetClaps} style={{ background:T.chalk, border:`2px solid ${T.ash}30`, color:T.ash, borderRadius:T.r12, padding:"14px 20px", fontSize:"0.8rem", cursor:"pointer", fontWeight:"700" }}>
              Reset
            </button>
          </div>
          {clapCount > 0 && (
            <div style={{ fontSize:"0.75rem", color:mod.color, fontWeight:"700" }}>
              {clapCount === 1 ? "1 clap!" : `${clapCount} claps!`}
              {clapCount >= 3 ? " 🌟 Great work!" : ""}
            </div>
          )}
        </div>
      )}

      {/* Voice narration blocked notice — only shown once TTS silently fails */}
      {audio.ttsBlocked && (
        <div style={{ background:"#FFF7E6", border:"1px solid #F0C040", borderRadius:T.r8, padding:"8px 12px", marginBottom:"10px", fontSize:"0.68rem", color:T.mahogany, lineHeight:1.5 }}>
          🔇 Voice narration is blocked in this preview window. The tap registered (you'll hear a beat cue instead) — full voice will work once this is opened as the deployed app in your phone's browser.
        </div>
      )}

      {/* Main toolbar buttons */}
      <div style={{ display:"flex", gap:"8px", justifyContent:"space-around" }}>
        {/* Read aloud */}
        <button onClick={handleRead} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:"3px", background: speaking ? `${mod.color}15` : T.chalk, border: speaking ? `2px solid ${mod.color}` : `2px solid transparent`, borderRadius:T.r12, padding:"10px 6px", cursor:"pointer" }}>
          <span style={{ fontSize:"1.4rem" }}>{speaking ? "⏹️" : "🔊"}</span>
          <span style={{ fontSize:"0.6rem", color: speaking ? mod.color : T.ash, fontWeight:"700" }}>{speaking ? "Stop" : "Read Aloud"}</span>
        </button>

        {/* Clap counter toggle */}
        <button onClick={() => { audio.unlock(); setShowClapper(v => !v); }} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:"3px", background: showClapper ? `${mod.color}15` : T.chalk, border: showClapper ? `2px solid ${mod.color}` : `2px solid transparent`, borderRadius:T.r12, padding:"10px 6px", cursor:"pointer", position:"relative" }}>
          <span style={{ fontSize:"1.4rem" }}>👏</span>
          <span style={{ fontSize:"0.6rem", color: showClapper ? mod.color : T.ash, fontWeight:"700" }}>Clap It!</span>
          {clapCount > 0 && !showClapper && (
            <span style={{ position:"absolute", top:"4px", right:"6px", background:mod.color, color:T.white, borderRadius:T.rFull, width:"16px", height:"16px", fontSize:"0.55rem", fontWeight:"900", display:"flex", alignItems:"center", justifyContent:"center" }}>{clapCount}</span>
          )}
        </button>

        {/* Phonics / sound */}
        <button onClick={handlePhonics} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:"3px", background:T.chalk, border:`2px solid transparent`, borderRadius:T.r12, padding:"10px 6px", cursor:"pointer" }}>
          <span style={{ fontSize:"1.4rem" }}>{mod.phonicsLetter ? "🔤" : "🎵"}</span>
          <span style={{ fontSize:"0.6rem", color:T.ash, fontWeight:"700" }}>{mod.phonicsLetter ? `/${mod.phonicsLetter.toLowerCase()}/` : "Sound"}</span>
        </button>

        {/* Mute toggle */}
        <button onClick={() => { audio.unlock(); audio.setEnabled(e => !e); }} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:"3px", background: !audio.enabled ? "#FEE2E2" : T.chalk, border:`2px solid transparent`, borderRadius:T.r12, padding:"10px 6px", cursor:"pointer" }}>
          <span style={{ fontSize:"1.4rem" }}>{audio.enabled ? "🔔" : "🔇"}</span>
          <span style={{ fontSize:"0.6rem", color:T.ash, fontWeight:"700" }}>{audio.enabled ? "Sound On" : "Muted"}</span>
        </button>
      </div>
    </div>
  );
}

// ─── PHONICS CARD (with audio hooks passed in) ────────────────
// Upgraded: word tiles are tappable → play phonics sound + TTS
function PhonicsCardInteractive({ mod, audio }) {
  const { phonicsLetter="A", phonicsWords=[], phonicsEmojis=[], phoneticSentence="", sightWords=[] } = mod;
  const [tapped, setTapped] = useState(null);
  const pastelPairs = [
    { bg:"#FFF0F5", border:"#F9A8D4" },
    { bg:"#F0FFF4", border:"#86EFAC" },
    { bg:"#EFF6FF", border:"#93C5FD" },
    { bg:"#FFFBEB", border:"#FCD34D" },
    { bg:"#FAF5FF", border:"#C4B5FD" },
    { bg:"#FFF7ED", border:"#FCA5A1" },
  ];

  const tapWord = (word, i) => {
    setTapped(i);
    audio.speak(word, { rate:0.7, pitch:1.15 });
    setTimeout(() => setTapped(null), 800);
  };

  const tapLetter = () => {
    audio.phonics(phonicsLetter, 3);
  };

  const tapSentence = () => {
    audio.speak(phoneticSentence, { rate:0.72, pitch:1.0 });
  };

  return (
    <div style={{ ...css.card, background:"linear-gradient(160deg,#FEFCE8,#FFF0F5)", border:"2px solid #FCD34D" }}>
      <div style={{ textAlign:"center", marginBottom:"14px" }}>
        <span style={{ ...css.badge(T.rose), fontSize:"0.65rem", letterSpacing:"1px" }}>🔤 PHONICS CARD</span>
        <div style={{ fontFamily:T.display, fontSize:"1.1rem", fontWeight:"bold", color:T.ink, marginTop:"6px" }}>{mod.title}</div>
        <div style={{ fontSize:"0.75rem", color:T.ash, marginTop:"2px" }}>{mod.orbPact}</div>
      </div>

      {/* Big letter — tap to hear */}
      <div style={{ textAlign:"center", marginBottom:"14px" }}>
        <div onClick={tapLetter} style={{ display:"inline-flex", gap:"12px", alignItems:"center", background:"white", borderRadius:T.r16, padding:"12px 28px", boxShadow:"0 4px 16px rgba(0,0,0,0.08)", border:"2px solid #FCD34D", cursor:"pointer", userSelect:"none" }}>
          <span style={{ fontFamily:T.display, fontSize:"3.5rem", fontWeight:"900", color:T.rose, lineHeight:1 }}>{phonicsLetter.toUpperCase()}</span>
          <span style={{ fontFamily:T.display, fontSize:"2.5rem", fontWeight:"700", color:T.sky, lineHeight:1 }}>{phonicsLetter.toLowerCase()}</span>
        </div>
        <div style={{ marginTop:"8px", fontSize:"0.78rem", color:T.ash }}>
          👆 Tap the letter to hear: <strong style={{ color:T.rose }}>/{phonicsLetter.toLowerCase()}/ /{phonicsLetter.toLowerCase()}/ /{phonicsLetter.toLowerCase()}/</strong>
        </div>
      </div>

      {/* Tappable word + emoji grid */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"8px", marginBottom:"14px" }}>
        {phonicsWords.slice(0,6).map((word, i) => (
          <div key={i} onClick={() => tapWord(word, i)}
            style={{ background: tapped===i ? mod.color+"22" : pastelPairs[i%6].bg, border:`2px solid ${tapped===i ? mod.color : pastelPairs[i%6].border}`, borderRadius:T.r12, padding:"10px 6px", textAlign:"center", cursor:"pointer", transition:"all 0.2s", transform: tapped===i ? "scale(0.95)" : "scale(1)", userSelect:"none" }}>
            <div style={{ fontSize:"1.6rem", marginBottom:"4px" }}>{phonicsEmojis[i] || "⭐"}</div>
            <div style={{ fontSize:"0.82rem", fontWeight:"800", color:T.ink }}>
              <span style={{ color:T.rose, fontWeight:"900" }}>{word.slice(0, phonicsLetter.length)}</span>
              <span>{word.slice(phonicsLetter.length)}</span>
            </div>
            <div style={{ fontSize:"0.55rem", color:T.ash, marginTop:"2px" }}>tap to hear</div>
          </div>
        ))}
      </div>

      {/* Sight words */}
      {sightWords.length > 0 && (
        <div style={{ marginBottom:"12px" }}>
          <div style={{ fontSize:"0.68rem", fontWeight:"800", color:T.cobalt, textTransform:"uppercase", letterSpacing:"1px", marginBottom:"6px" }}>⭐ Tap to hear each word</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:"6px" }}>
            {sightWords.map((w,i) => (
              <span key={i} onClick={() => { audio.speak(w, {rate:0.7}); }}
                style={{ background:["#FEE2E2","#DCFCE7","#DBEAFE","#FEF9C3","#EDE9FE","#FCE7F3"][i%6], borderRadius:T.rFull, padding:"4px 14px", fontSize:"0.82rem", fontWeight:"700", color:T.ink, cursor:"pointer", userSelect:"none" }}>
                {w}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Sentence — tap to hear */}
      {phoneticSentence && (
        <div onClick={tapSentence} style={{ background:"white", borderRadius:T.r12, padding:"12px 14px", border:"2px solid #FCD34D", textAlign:"center", cursor:"pointer", userSelect:"none" }}>
          <div style={{ fontSize:"0.68rem", color:T.gold, fontWeight:"800", marginBottom:"4px" }}>📖 TAP TO READ ALOUD</div>
          <div style={{ fontSize:"0.92rem", color:T.ink, fontWeight:"700", lineHeight:1.7 }}>{phoneticSentence}</div>
        </div>
      )}
    </div>
  );
}

// Format selector (audio-aware version)
function FormatCard({ mod, user, audio }) {
  const map = {
    knowledge: <KnowledgeCard mod={mod} />,
    diagnostic: <DiagnosticSheet mod={mod} />,
    ranking: <RankingLadder mod={mod} />,
    journey: <StoryJourney mod={mod} />,
    function_chart: <FunctionChart mod={mod} />,
    life_lesson: <LifeLessonCard mod={mod} />,
    growth_mirror: <GrowthMirror mod={mod} user={user} />,
    phonics: audio ? <PhonicsCardInteractive mod={mod} audio={audio} /> : <PhonicsCard mod={mod} />,
    step_by_step: <StepByStepCard mod={mod} />,
    wh_questions: <WHQuestionsCard mod={mod} />,
  };
  return map[mod.format] || <LifeLessonCard mod={mod} />;
}

// ─── AUTH ────────────────────────────────────────────────────
function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ name:"", email:"", pin:"", grade:"10", track:"Self", vulnerability:"5", curriculum:"caps", protagonist:"self" });
  const [err, setErr] = useState("");

  const set = e => setForm(f => ({ ...f, [e.target.name]:e.target.value }));

  const submit = () => {
    setErr("");
    if (mode==="login") {
      if (!form.email||!form.pin) return setErr("Email and PIN required.");
      const u = DB.getUser(form.email, form.pin);
      if (!u) return setErr("Incorrect email or PIN.");
      onAuth(u);
    } else {
      if (!form.name||!form.email||!form.pin) return setErr("All fields required.");
      if (form.pin.length!==4) return setErr("PIN must be 4 digits.");
      const res = DB.createUser({ ...form, profile:{ ...PROFILER.init(), vulnerabilityScore:parseInt(form.vulnerability) } });
      if (res.error) return setErr(res.error);
      onAuth(res.data);
    }
  };

  return (
    <div style={{ minHeight:"100vh", background:`linear-gradient(160deg, ${T.board} 0%, ${T.ink} 60%, ${T.mahogany} 100%)`, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"30px 20px" }}>
      {/* Brand */}
      <div style={{ textAlign:"center", marginBottom:"20px" }}>
        <div style={{ fontFamily:T.display, fontSize:"3rem", fontWeight:"bold", background:`linear-gradient(135deg, ${T.gold}, ${T.sunGold}, ${T.gold})`, WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", letterSpacing:"6px" }}>LIFE</div>
        <div style={{ color:T.gold, fontSize:"0.6rem", letterSpacing:"6px", textTransform:"uppercase", marginTop:"4px" }}>KNOW · LED · EDGE · NOW</div>
        <div style={{ color:"rgba(255,255,255,0.4)", fontSize:"0.75rem", marginTop:"8px" }}>Learning Is Fun Edutainment NPC</div>
        <div style={{ color:"rgba(255,255,255,0.25)", fontSize:"0.65rem", marginTop:"2px" }}>A Global Edutainment Brand × EduCreat'Us Infrastructure & Systems Solutions</div>
      </div>

      {/* Pricing banner */}
      <div style={{ background:"rgba(212,160,23,0.15)", border:`1px solid ${T.gold}`, borderRadius:T.r12, padding:"10px 18px", marginBottom:"18px", textAlign:"center", maxWidth:"390px", width:"100%" }}>
        <div style={{ color:"rgba(255,255,255,0.5)", fontSize:"0.65rem", textTransform:"uppercase", letterSpacing:"1px" }}>{PRICING.promoLabel}</div>
        <div style={{ display:"flex", alignItems:"baseline", justifyContent:"center", gap:"8px" }}>
          <span style={{ color:"rgba(255,255,255,0.4)", fontSize:"0.85rem", textDecoration:"line-through" }}>{PRICING.symbol}{PRICING.standardMonthly}/mo</span>
          <span style={{ color:T.sunGold, fontWeight:"900", fontSize:"1.3rem" }}>{PRICING.symbol}{PRICING.promoMonthly}/mo</span>
          <span style={css.badge(T.ember)}>-{PRICING.promoPct}%</span>
        </div>
      </div>

      <div style={{ background:"rgba(255,255,255,0.97)", borderRadius:T.r24, padding:"30px 26px", width:"100%", maxWidth:"390px" }}>
        <div style={{ display:"flex", background:T.chalk, borderRadius:T.r8, marginBottom:"22px", padding:"4px" }}>
          {["login","register"].map(m => (
            <button key={m} onClick={() => setMode(m)} style={{ flex:1, padding:"9px", background:mode===m?T.board:"transparent", color:mode===m?T.white:T.ash, border:"none", borderRadius:T.r8, fontWeight:"700", cursor:"pointer", fontSize:"0.83rem", transition:"all 0.2s" }}>
              {m==="login"?"Sign In":"Register"}
            </button>
          ))}
        </div>

        {mode==="register" && <>
          <label style={css.label}>Full Name</label>
          <input style={css.input} name="name" placeholder="Your full name" value={form.name} onChange={set} />
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px" }}>
            <div>
              <label style={css.label}>Grade</label>
              <select style={{ ...css.input, marginBottom:0 }} name="grade" value={form.grade} onChange={set}>
                {GRADES.map(g => <option key={g} value={g}>{g==="Adult"?"Adult":`Grade ${g}`}</option>)}
              </select>
            </div>
            <div>
              <label style={css.label}>Track</label>
              <select style={{ ...css.input, marginBottom:0 }} name="track" value={form.track} onChange={set}>
                {["Self","Literacy","Finance","Leadership","Digital","Portfolio"].map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div style={{ height:"14px" }} />
          <label style={css.label}>Curriculum (10 global frameworks supported)</label>
          <select style={{ ...css.input }} name="curriculum" value={form.curriculum} onChange={set}>
            {CURRICULA.map(c => <option key={c.id} value={c.id}>{c.name} — {c.region}</option>)}
          </select>
          <label style={css.label}>Your Story Protagonist</label>
          <select style={{ ...css.input }} name="protagonist" value={form.protagonist} onChange={set}>
            {PROTAGONISTS.map(p => <option key={p.id} value={p.id}>{p.icon} {p.isSelf?"Cast yourself as the protagonist":`${p.name} — ${p.origin}`}</option>)}
          </select>
          <label style={css.label}>Community Support Level (1=strong, 10=high need)</label>
          <input style={css.input} name="vulnerability" type="range" min="1" max="10" value={form.vulnerability} onChange={set} />
          <div style={{ textAlign:"center", marginTop:"-10px", marginBottom:"12px", fontSize:"0.75rem", color:T.mahogany, fontWeight:"700" }}>Level {form.vulnerability} — {parseInt(form.vulnerability)>6?"High support needed":parseInt(form.vulnerability)>3?"Moderate support":"Strong foundation"}</div>
        </>}

        <label style={css.label}>Email Address</label>
        <input style={css.input} name="email" type="email" placeholder="learner@lifenpc.global" value={form.email} onChange={set} />
        <label style={css.label}>4-Digit PIN</label>
        <input style={css.input} name="pin" type="password" maxLength={4} placeholder="••••" value={form.pin} onChange={set} onKeyDown={e => e.key==="Enter"&&submit()} />

        {err && <div style={{ color:T.danger, fontSize:"0.8rem", marginBottom:"12px", padding:"8px 12px", background:"rgba(192,57,43,0.08)", borderRadius:T.r8, fontWeight:"600" }}>{err}</div>}

        <button style={{ ...css.btn(`linear-gradient(135deg, ${T.board}, ${T.ink})`, T.white, "lg"), width:"100%" }} onClick={submit}>
          {mode==="login"?"Enter Platform →":"Create Account →"}
        </button>
        <div style={{ textAlign:"center", marginTop:"14px", fontSize:"0.7rem", color:T.ash }}>🔒 PIN-secured · Ubuntu-aligned · 10 global curricula · POPIA compliant</div>
      </div>
    </div>
  );
}

// ─── MEMORY CHECK (Spaced Review UI) ──────────────────────────
function MemoryCheck({ user, onUpdate }) {
  const due = SPACED_REVIEW.getDueReviews(user);
  const [activeId, setActiveId] = useState(null);
  if (due.length === 0) return null;
  const item = due[0];
  const mod = MODS.find(m => m.id === item.modId);
  if (!mod) return null;

  const respond = (recalled) => {
    const updated = DB.logReview(user.id, item.modId, item.stage, recalled);
    if (updated) onUpdate(updated);
    setActiveId(null);
  };

  return (
    <div style={{ ...css.card, background:T.cobalt, color:T.white, borderLeft:`4px solid ${T.sunGold}` }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"8px" }}>
        <span style={css.badge(T.sunGold, T.ink)}>🧠 MEMORY CHECK</span>
        <span style={{ fontSize:"0.65rem", color:"rgba(255,255,255,0.55)" }}>Day {item.intervalDays} review</span>
      </div>
      <div style={{ fontSize:"0.85rem", lineHeight:1.6, marginBottom:"12px" }}>{SPACED_REVIEW.buildPrompt(mod)}</div>
      <div style={{ display:"flex", gap:"8px" }}>
        <button style={{ ...css.btn(T.success, T.white, "sm"), flex:1 }} onClick={() => respond(true)}>✓ Yes, I remember &amp; did it</button>
        <button style={{ ...css.btn("rgba(255,255,255,0.15)", T.white, "sm"), flex:1 }} onClick={() => respond(false)}>Need a refresher</button>
      </div>
      {due.length>1 && <div style={{ fontSize:"0.65rem", color:"rgba(255,255,255,0.5)", marginTop:"8px" }}>+{due.length-1} more review{due.length>2?"s":""} waiting</div>}
    </div>
  );
}

// ─── STUDY PACE / FALLING-BEHIND REMINDER ─────────────────────
function StudyPaceCard({ user }) {
  const pace = PROGRESS_PACE.compute(user);
  return (
    <div style={{ ...css.card, borderLeft:`4px solid ${pace.color}` }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"8px" }}>
        <span style={css.badge(pace.color)}>⏱ {pace.status.toUpperCase()}</span>
        <span style={{ fontSize:"0.68rem", color:T.ash }}>{pace.actualDone}/{pace.totalWeeks} done · week target {pace.expectedDone}</span>
      </div>
      <div style={{ fontSize:"0.85rem", color:T.ink, lineHeight:1.6 }}>{pace.message}</div>
      {pace.gap > 0 && (
        <div style={{ marginTop:"10px", background:T.chalk, borderRadius:T.r8, padding:"10px 12px", fontSize:"0.76rem", color:T.mahogany, fontWeight:"700" }}>
          Catch-up target: {pace.weeklyPaceNeeded} module{pace.weeklyPaceNeeded!==1?"s":""}/week · {pace.weeksRemaining} week{pace.weeksRemaining!==1?"s":""} remaining in the programme
        </div>
      )}
    </div>
  );
}

// ─── DASHBOARD ───────────────────────────────────────────────
function Dashboard({ user, onNav, onUpdate }) {
  const capsGradeMods = CAPS_GRADE_MODS[user?.grade] || [];
  const allUserMods = [...MODS, ...capsGradeMods];
  const done = Object.keys(user.progress||{}).length;
  const total = allUserMods.length;
  const pct = Math.round(done/total*100);
  const grades = Object.values(user.grades||{});
  const avg = grades.length ? Math.round(grades.reduce((s,g)=>s+g.total,0)/grades.length) : 0;
  const g = RUBRIC.grade(avg);
  // Surface next incomplete module — CAPS grade mods first for CAPS users
  const orderedMods = user?.curriculum==="caps" ? [...capsGradeMods, ...MODS] : MODS;
  const next = orderedMods.find(m => !user.progress?.[m.id]) || MODS[MODS.length-1];
  const pathMsg = PROFILER.getPathMessage(user.profile||PROFILER.init());

  return (
    <div style={{ padding:"20px", paddingBottom:"100px" }}>
      {/* Hero */}
      <div style={{ background:`linear-gradient(145deg, ${T.board} 0%, ${T.mahogany} 50%, ${T.ember} 85%, ${T.gold} 100%)`, borderRadius:T.r16, padding:"22px", marginBottom:"14px", boxShadow:T.glow }}>
        <div style={{ fontSize:"0.65rem", color:"rgba(255,255,255,0.6)", letterSpacing:"3px", textTransform:"uppercase", marginBottom:"3px" }}>Your Learning Journey</div>
        <div style={{ fontFamily:T.display, fontSize:"1.4rem", color:T.white, fontWeight:"bold" }}>{user.name}</div>
        <div style={{ fontSize:"0.75rem", color:"rgba(255,255,255,0.7)", marginBottom:"4px" }}>Grade {user.grade} · {user.track} Track</div>
        <div style={{ fontSize:"0.78rem", color:T.sunGold, fontStyle:"italic", marginBottom:"14px" }}>{pathMsg}</div>
        <PBar pct={pct} color={T.sunGold} h={10} />
        <div style={{ display:"flex", justifyContent:"space-between", marginTop:"6px", fontSize:"0.72rem", color:"rgba(255,255,255,0.7)" }}>
          <span>{done}/{total} modules</span>
          <span>{pct}% complete</span>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4, 1fr)", gap:"8px", marginBottom:"14px" }}>
        {[
          { icon:"⭐", val:user.points||0, label:"Points" },
          { icon:"🪙", val:user.coins||0, label:"Coins" },
          { icon:g.badge, val:g.label, label:"Grade" },
          { icon:"📁", val:(user.evidence||[]).length, label:"Evidence" },
        ].map(s => (
          <div key={s.label} style={{ background:T.white, borderRadius:T.r12, padding:"12px 6px", textAlign:"center", boxShadow:T.shadow }}>
            <div style={{ fontSize:"1.1rem" }}>{s.icon}</div>
            <div style={{ fontWeight:"800", fontSize:s.label==="Grade"?"0.6rem":"0.95rem", color:T.board, lineHeight:1.2, marginTop:"2px" }}>{s.val}</div>
            <div style={{ fontSize:"0.6rem", color:T.ash, textTransform:"uppercase", marginTop:"2px" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* AI Profiler insight */}
      <div style={{ background:T.cobalt, borderRadius:T.r12, padding:"14px 16px", marginBottom:"14px" }}>
        <div style={{ color:T.sunGold, fontWeight:"800", fontSize:"0.75rem", marginBottom:"6px" }}>🤖 AI LEARNING PROFILE</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px" }}>
          {[
            { label:"Literacy", val:Math.round((user.profile?.literacyLevel||3)/5*100) },
            { label:"Community", val:Math.round((user.profile?.communityConnectedness||0)/10*100) },
            { label:"Growth", val:Math.min(100, (user.profile?.growthVelocity||0)*10) },
            { label:"Earn-Ready", val:Math.round((user.profile?.monetizationReadiness||0)/10*100) },
          ].map(p => (
            <div key={p.label}>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:"0.68rem", color:"rgba(255,255,255,0.7)", marginBottom:"3px" }}>
                <span>{p.label}</span><span>{p.val}%</span>
              </div>
              <PBar pct={p.val} color={T.sunGold} h={5} />
            </div>
          ))}
        </div>
      </div>

      {/* Study Pace / Falling-Behind Reminder */}
      <StudyPaceCard user={user} />

      {/* Spaced Review Engine */}
      <MemoryCheck user={user} onUpdate={onUpdate} />

      {/* Next module */}
      <div style={{ fontFamily:T.display, fontSize:"0.95rem", color:T.board, fontWeight:"bold", marginBottom:"10px" }}>Continue Learning</div>
      <div style={{ ...css.card, cursor:"pointer", borderLeft:`4px solid ${next.color}` }} onClick={() => onNav("lesson", next.id)}>
        <div style={{ display:"flex", gap:"12px", alignItems:"center" }}>
          <div style={{ width:"46px", height:"46px", borderRadius:T.r12, background:next.color, display:"flex", alignItems:"center", justifyContent:"center", fontSize:"1.4rem", flexShrink:0 }}>{next.icon}</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:"0.68rem", color:T.ash, textTransform:"uppercase" }}>{next.subject || `Week ${next.week}`} · {next.format?.replace("_"," ")} format</div>
            <div style={{ fontWeight:"700", fontSize:"0.9rem", color:T.ink }}>{next.title}</div>
            <div style={{ fontSize:"0.75rem", color:T.ash, marginTop:"2px" }}>+{next.pts} pts · +{Math.floor(next.pts/10)} coins</div>
          </div>
          <span style={{ color:next.color, fontSize:"1.1rem" }}>→</span>
        </div>
      </div>

      {/* IM + Monetization teasers */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px" }}>
        <div style={{ background:T.board, borderRadius:T.r12, padding:"14px", cursor:"pointer" }} onClick={() => onNav("messages")}>
          <div style={{ fontSize:"1.3rem", marginBottom:"4px" }}>💬</div>
          <div style={{ color:T.gold, fontWeight:"700", fontSize:"0.8rem" }}>Message Facilitator</div>
          <div style={{ color:"rgba(255,255,255,0.5)", fontSize:"0.7rem", marginTop:"2px" }}>IM Tool</div>
        </div>
        <div style={{ background:T.terracotta, borderRadius:T.r12, padding:"14px", cursor:"pointer" }} onClick={() => onNav("monetize")}>
          <div style={{ fontSize:"1.3rem", marginBottom:"4px" }}>🪙</div>
          <div style={{ color:T.white, fontWeight:"700", fontSize:"0.8rem" }}>Earn Rewards</div>
          <div style={{ color:"rgba(255,255,255,0.7)", fontSize:"0.7rem", marginTop:"2px" }}>{user.coins||0} coins ready</div>
        </div>
      </div>
    </div>
  );
}

// ─── LESSON ──────────────────────────────────────────────────
function LessonScreen({ user, modId, onComplete, onBack }) {
  const allCapsMods = Object.values(CAPS_GRADE_MODS).flat();
  const mod = MODS.find(m => m.id===modId) || allCapsMods.find(m => m.id===modId) || MODS[0];
  const [step, setStep] = useState(0);
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const audio = useAudio();

  // Show AudioBar for Foundation Phase grades (R and 1)
  const isFoundationPhase = ["R","1"].includes(user?.grade);
  // Audio-enriched formats
  const isAudioFormat = ["phonics","step_by_step","wh_questions"].includes(mod.format);

  // Play reward sound on completion
  useEffect(() => {
    if (step === 3) audio.reward();
  }, [step]);

  // Read activity text aloud when entering activity step for young grades
  useEffect(() => {
    if (step === 1 && isFoundationPhase && mod.orbPact) {
      setTimeout(() => audio.speak(mod.orbPact, { rate:0.8 }), 600);
    }
  }, [step]);

  const submit = () => {
    if (!text.trim() || text.length < 15) return;
    setLoading(true);
    setTimeout(() => {
      const updated = DB.saveEvidence(user.id, { modId:mod.id, moduleTitle:mod.title, pts:mod.pts, text });
      setResult({ score:updated.grades?.[mod.id], grade:RUBRIC.grade(updated.grades?.[mod.id]?.total||0), user:updated });
      setLoading(false);
      setStep(3);
      onComplete(updated);
    }, 1000);
  };

  return (
    <div style={{ minHeight:"100vh", background:T.chalk, paddingBottom:"40px" }}>
      <div style={{ background:`linear-gradient(135deg, ${mod.color}, ${T.ink})`, padding:"18px 20px 24px" }}>
        <button onClick={onBack} style={{ background:"rgba(255,255,255,0.15)", border:"none", color:T.white, padding:"6px 14px", borderRadius:T.rFull, cursor:"pointer", fontSize:"0.8rem", marginBottom:"12px" }}>← Back</button>
        <div style={{ display:"flex", alignItems:"center", gap:"10px", marginBottom:"6px" }}>
          <span style={{ fontSize:"1.8rem" }}>{mod.icon}</span>
          <div>
            <span style={css.badge(T.gold+"CC", T.ink)}>{mod.format?.replace("_"," ").toUpperCase()} FORMAT</span>
            <div style={{ fontFamily:T.display, fontSize:"1.2rem", color:T.white, fontWeight:"bold", marginTop:"4px" }}>{mod.title}</div>
          </div>
        </div>
        <div style={{ display:"flex", gap:"10px", alignItems:"center" }}>
          <div style={{ fontSize:"0.75rem", color:"rgba(255,255,255,0.65)" }}>+{mod.pts} pts · +{Math.floor(mod.pts/10)} coins</div>
          {isFoundationPhase && (
            <span style={{ background:"rgba(255,255,255,0.2)", borderRadius:T.rFull, padding:"2px 10px", fontSize:"0.6rem", color:T.white, fontWeight:"700" }}>🔊 Audio On</span>
          )}
        </div>
      </div>

      {/* Progress steps */}
      <div style={{ display:"flex", background:T.white, borderBottom:`1px solid #EEE` }}>
        {["Learn","Activity","Evidence","Result"].map((s,i) => (
          <button key={s} onClick={() => i<step&&setStep(i)} style={{ flex:1, padding:"11px 4px", background:"none", border:"none", borderBottom:step===i?`3px solid ${mod.color}`:"3px solid transparent", fontSize:"0.66rem", fontWeight:step===i?"800":"400", color:step===i?mod.color:T.ash, cursor:i<step?"pointer":"default" }}>
            {i<step?"✓":s}
          </button>
        ))}
      </div>

      <div style={{ padding:"20px" }}>
        {step===0 && <>
          <FormatCard mod={mod} user={user} audio={audio} />
          <div style={{ ...css.card }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"8px" }}>
              <div style={{ fontWeight:"700", color:T.board }}>📖 Core Learning</div>
              {isFoundationPhase && (
                <button onClick={() => { audio.unlock(); audio.speak(mod.content, {rate:0.78}); }} style={{ background:`${mod.color}15`, border:`1.5px solid ${mod.color}30`, borderRadius:T.rFull, padding:"4px 12px", fontSize:"0.65rem", color:mod.color, fontWeight:"700", cursor:"pointer" }}>
                  🔊 Read to me
                </button>
              )}
            </div>
            <div style={{ lineHeight:1.8, fontSize:"0.88rem", color:T.ink, whiteSpace:"pre-line" }}>{mod.content}</div>
          </div>
          <button style={{ ...css.btn(`linear-gradient(135deg, ${mod.color}, ${T.ink})`, T.white, "lg"), width:"100%" }} onClick={() => { setStep(1); audio.correct(); }}>Go to Activity →</button>
        </>}

        {step===1 && <>
          <div style={css.card}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"10px" }}>
              <div style={{ fontWeight:"700", color:T.board }}>🎯 Activity</div>
              {isFoundationPhase && (
                <button onClick={() => audio.speak(mod.activity, {rate:0.75})} style={{ background:`${mod.color}15`, border:`1.5px solid ${mod.color}30`, borderRadius:T.rFull, padding:"4px 12px", fontSize:"0.65rem", color:mod.color, fontWeight:"700", cursor:"pointer" }}>
                  🔊 Read to me
                </button>
              )}
            </div>
            <div style={{ background:T.chalk, padding:"14px", borderRadius:T.r12, fontSize:"0.88rem", lineHeight:1.8, color:T.ink, whiteSpace:"pre-line" }}>{mod.activity}</div>
          </div>

          {/* Clap-specific activity cue for Grade R/1 phonics */}
          {isFoundationPhase && mod.activity?.toLowerCase().includes("clap") && (
            <div style={{ background:`${T.gold}15`, border:`2px solid ${T.gold}`, borderRadius:T.r12, padding:"14px", marginBottom:"14px", textAlign:"center" }}>
              <div style={{ fontSize:"1.5rem", marginBottom:"6px" }}>👏</div>
              <div style={{ fontWeight:"800", color:T.board, fontSize:"0.85rem", marginBottom:"4px" }}>Clap Counter is active below!</div>
              <div style={{ fontSize:"0.75rem", color:T.ash }}>Use the 👏 button in the toolbar to tap once for each word or syllable.</div>
            </div>
          )}

          <div style={{ background:`${mod.color}12`, borderLeft:`3px solid ${mod.color}`, borderRadius:T.r12, padding:"14px 16px", marginBottom:"14px" }}>
            <div style={{ color:mod.color, fontWeight:"800", fontSize:"0.68rem", marginBottom:"5px", letterSpacing:"0.5px" }}>💬 QUOTE FOR THIS WEEK</div>
            <div style={{ color:T.ink, fontSize:"0.86rem", fontStyle:"italic", lineHeight:1.6 }}>"{(QUOTES[mod.track]||QUOTES.Default).text}"</div>
            <div style={{ color:T.ash, fontSize:"0.7rem", marginTop:"4px" }}>— {(QUOTES[mod.track]||QUOTES.Default).source}</div>
          </div>
          <div style={{ background:T.board, borderRadius:T.r12, padding:"14px 16px", marginBottom:"14px" }}>
            <div style={{ color:T.gold, fontWeight:"800", fontSize:"0.72rem", marginBottom:"4px" }}>🤝 UBUNTU REMINDER</div>
            <div style={{ color:"rgba(255,255,255,0.85)", fontSize:"0.83rem", lineHeight:1.6 }}>Share what you discover with someone in your community. Learning that stays inside you helps one person. Learning shared helps a whole street.</div>
          </div>
          <button style={{ ...css.btn(`linear-gradient(135deg, ${mod.color}, ${T.ink})`, T.white, "lg"), width:"100%" }} onClick={() => setStep(2)}>Submit My Evidence →</button>
        </>}

        {step===2 && <>
          <div style={css.card}>
            <div style={{ fontWeight:"700", color:T.board, marginBottom:"6px" }}>📁 Evidence Submission</div>
            <div style={{ fontSize:"0.8rem", color:T.ash, marginBottom:"12px", lineHeight:1.5 }}>
              {isFoundationPhase
                ? "Tell us what you did! Write a few words or ask a grown-up to help you write. Draw a picture too if you like."
                : "Write honestly. Be specific. Mention your community, your observations, your feelings."}
            </div>
            <textarea value={text} onChange={e => setText(e.target.value)}
              placeholder={isFoundationPhase ? "What did you do? What did you learn? (A grown-up can help write!)" : "Start writing... the more honest and specific, the higher your rubric score."}
              style={{ ...css.input, height:"150px", resize:"vertical", lineHeight:1.6, marginBottom:"8px" }} />
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:"0.72rem", color:T.ash, marginBottom:"14px" }}>
              <span>{text.split(" ").filter(Boolean).length} words</span>
              <span style={{ color:text.split(" ").filter(Boolean).length>=(isFoundationPhase?5:40)?T.success:T.ember }}>
                {text.split(" ").filter(Boolean).length>=(isFoundationPhase?5:40)?"✓ Great!" : isFoundationPhase?"Write 5+ words":"Aim for 40+ words"}
              </span>
            </div>
            <button style={{ ...css.btn(loading?T.ash:T.success, T.white, "lg"), width:"100%", opacity:loading?0.7:1 }} onClick={submit} disabled={loading}>
              {loading?"Scoring with AI rubric...":"Submit & Earn Points →"}
            </button>
          </div>
        </>}

        {step===3 && result && <>
          <div style={{ textAlign:"center", marginBottom:"16px" }}>
            <div style={{ fontSize:"3rem" }}>{result.grade.badge}</div>
            <div style={{ fontFamily:T.display, fontSize:"1.4rem", color:T.board, fontWeight:"bold", marginTop:"6px" }}>{result.grade.label}</div>
            <div style={{ fontSize:"2rem", fontWeight:"900", color:result.grade.color }}>{result.score?.total||0}%</div>
          </div>

          {/* Rubric breakdown */}
          <div style={css.card}>
            <div style={{ fontWeight:"700", color:T.board, marginBottom:"12px" }}>📊 5-Dimension Rubric Score</div>
            {[
              { key:"reflection", label:"Depth of Reflection", max:30, icon:"🪞" },
              { key:"ubuntu", label:"Ubuntu Application", max:25, icon:"🤝" },
              { key:"evidence", label:"Evidence Quality", max:20, icon:"📁" },
              { key:"growth", label:"Growth Signal", max:15, icon:"📈" },
              { key:"completion", label:"Task Completion", max:10, icon:"✅" },
            ].map(d => {
              const s = result.score?.breakdown?.[d.key]||0;
              const p = Math.round(s/d.max*100);
              return (
                <div key={d.key} style={{ marginBottom:"10px" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:"0.78rem", marginBottom:"3px" }}>
                    <span>{d.icon} {d.label}</span>
                    <span style={{ fontWeight:"700", color:T.board }}>{s}/{d.max}</span>
                  </div>
                  <PBar pct={p} color={p>=70?T.success:p>=40?T.gold:T.ember} h={7} />
                </div>
              );
            })}
          </div>

          <div style={{ background:T.board, borderRadius:T.r12, padding:"14px 16px", marginBottom:"14px" }}>
            <div style={{ color:T.gold, fontWeight:"700", marginBottom:"6px" }}>💡 AI Coaching Feedback</div>
            <div style={{ color:"rgba(255,255,255,0.85)", fontSize:"0.85rem", lineHeight:1.6 }}>{result.grade.next}</div>
            <div style={{ marginTop:"10px", display:"flex", gap:"10px", fontSize:"0.78rem" }}>
              <span style={{ color:T.sunGold }}>+{mod.pts} pts earned</span>
              <span style={{ color:T.sunGold }}>+{Math.floor(mod.pts/10)} coins earned</span>
            </div>
          </div>

          <button style={{ ...css.btn(T.chalk, T.board), width:"100%" }} onClick={onBack}>← Back to Curriculum</button>
        </>}
      </div>

      {/* Floating AudioBar — Foundation Phase only */}
      {isFoundationPhase && (
        <AudioBar mod={mod} audio={audio}
          targetText={step===0 ? mod.content : step===1 ? mod.activity : mod.orbPact}
        />
      )}
    </div>
  );
}

// ─── CAPS SUBJECT FRAMEWORK ──────────────────────────────────
// Phase lookup by grade for CAPS curriculum (South Africa)
const CAPS_PHASES = {
  R:  { name:"Foundation Phase", grades:"R–3", subjects:[
    { name:"Home Language", hoursPerWeek:10 },
    { name:"First Additional Language", hoursPerWeek:3 },
    { name:"Mathematics", hoursPerWeek:7 },
    { name:"Life Skills", hoursPerWeek:6 },
  ]},
  "1": { name:"Foundation Phase", grades:"R–3", subjects:[
    { name:"Home Language", hoursPerWeek:10 },
    { name:"First Additional Language", hoursPerWeek:4 },
    { name:"Mathematics", hoursPerWeek:7 },
    { name:"Life Skills", hoursPerWeek:6 },
  ]},
  "2": { name:"Foundation Phase", grades:"R–3", subjects:[
    { name:"Home Language", hoursPerWeek:10 },
    { name:"First Additional Language", hoursPerWeek:4 },
    { name:"Mathematics", hoursPerWeek:7 },
    { name:"Life Skills", hoursPerWeek:6 },
  ]},
  "3": { name:"Foundation Phase", grades:"R–3", subjects:[
    { name:"Home Language", hoursPerWeek:10 },
    { name:"First Additional Language", hoursPerWeek:4 },
    { name:"Mathematics", hoursPerWeek:7 },
    { name:"Life Skills", hoursPerWeek:6 },
  ]},
  "4": { name:"Intermediate Phase", grades:"4–6", subjects:[
    { name:"Home Language", hoursPerWeek:6 },
    { name:"First Additional Language", hoursPerWeek:5 },
    { name:"Mathematics", hoursPerWeek:6 },
    { name:"Natural Sciences & Technology", hoursPerWeek:3.5 },
    { name:"Social Sciences", hoursPerWeek:3 },
    { name:"Life Skills", hoursPerWeek:4 },
    { name:"Economic & Management Sciences", hoursPerWeek:2 },
  ]},
  "5": { name:"Intermediate Phase", grades:"4–6", subjects:[
    { name:"Home Language", hoursPerWeek:6 },
    { name:"First Additional Language", hoursPerWeek:5 },
    { name:"Mathematics", hoursPerWeek:6 },
    { name:"Natural Sciences & Technology", hoursPerWeek:3.5 },
    { name:"Social Sciences", hoursPerWeek:3 },
    { name:"Life Skills", hoursPerWeek:4 },
    { name:"Economic & Management Sciences", hoursPerWeek:2 },
  ]},
  "6": { name:"Intermediate Phase", grades:"4–6", subjects:[
    { name:"Home Language", hoursPerWeek:6 },
    { name:"First Additional Language", hoursPerWeek:5 },
    { name:"Mathematics", hoursPerWeek:6 },
    { name:"Natural Sciences & Technology", hoursPerWeek:3.5 },
    { name:"Social Sciences", hoursPerWeek:3 },
    { name:"Life Skills", hoursPerWeek:4 },
    { name:"Economic & Management Sciences", hoursPerWeek:2 },
  ]},
  "7": { name:"Senior Phase", grades:"7–9", subjects:[
    { name:"Home Language", hoursPerWeek:5 },
    { name:"First Additional Language", hoursPerWeek:4 },
    { name:"Mathematics / Math Literacy", hoursPerWeek:5 },
    { name:"Natural Sciences", hoursPerWeek:3.5 },
    { name:"Social Sciences", hoursPerWeek:3 },
    { name:"Life Orientation", hoursPerWeek:2 },
    { name:"Economic & Management Sciences", hoursPerWeek:2 },
    { name:"Technology", hoursPerWeek:2 },
    { name:"Creative Arts", hoursPerWeek:2 },
  ]},
  "8": { name:"Senior Phase", grades:"7–9", subjects:[
    { name:"Home Language", hoursPerWeek:5 },
    { name:"First Additional Language", hoursPerWeek:4 },
    { name:"Mathematics / Math Literacy", hoursPerWeek:5 },
    { name:"Natural Sciences", hoursPerWeek:3.5 },
    { name:"Social Sciences", hoursPerWeek:3 },
    { name:"Life Orientation", hoursPerWeek:2 },
    { name:"Economic & Management Sciences", hoursPerWeek:2 },
    { name:"Technology", hoursPerWeek:2 },
    { name:"Creative Arts", hoursPerWeek:2 },
  ]},
  "9": { name:"Senior Phase", grades:"7–9", subjects:[
    { name:"Home Language", hoursPerWeek:5 },
    { name:"First Additional Language", hoursPerWeek:4 },
    { name:"Mathematics / Math Literacy", hoursPerWeek:5 },
    { name:"Natural Sciences", hoursPerWeek:3.5 },
    { name:"Social Sciences", hoursPerWeek:3 },
    { name:"Life Orientation", hoursPerWeek:2 },
    { name:"Economic & Management Sciences", hoursPerWeek:2 },
    { name:"Technology", hoursPerWeek:2 },
    { name:"Creative Arts", hoursPerWeek:2 },
  ]},
  "10": { name:"FET Phase", grades:"10–12", subjects:[
    { name:"Home Language", hoursPerWeek:4.5 },
    { name:"First Additional Language", hoursPerWeek:4.5 },
    { name:"Mathematics / Math Literacy", hoursPerWeek:4.5 },
    { name:"Life Orientation", hoursPerWeek:2 },
    { name:"3 Elective Subjects", hoursPerWeek:12 },
  ]},
  "11": { name:"FET Phase", grades:"10–12", subjects:[
    { name:"Home Language", hoursPerWeek:4.5 },
    { name:"First Additional Language", hoursPerWeek:4.5 },
    { name:"Mathematics / Math Literacy", hoursPerWeek:4.5 },
    { name:"Life Orientation", hoursPerWeek:2 },
    { name:"3 Elective Subjects", hoursPerWeek:12 },
  ]},
  "12": { name:"FET Phase", grades:"10–12", subjects:[
    { name:"Home Language", hoursPerWeek:4.5 },
    { name:"First Additional Language", hoursPerWeek:4.5 },
    { name:"Mathematics / Math Literacy", hoursPerWeek:4.5 },
    { name:"Life Orientation", hoursPerWeek:2 },
    { name:"3 Elective Subjects", hoursPerWeek:12 },
  ]},
};

// ─── GRADE R SAMPLE MODULES (CAPS) ───────────────────────────
// 8 modules · multi-modal design · phonics · step-by-step · WH questions
// Design principles from reference images:
//   • Chunked numbered steps — never walls of text
//   • Colour-coded panels per concept
//   • Emoji anchors on every item (visual hook)
//   • Say it / Draw it / Do it activities (auditory + visual + kinesthetic)
//   • Short sessions · encouragement built in · progress not perfection
const CAPS_R_MODS = [
  // ── R·1 ── PHONICS: Letter S ──────────────────────────────
  { id:"caps_r_1", title:"The S Sound — Ssss!", subject:"Home Language · Phonics", icon:"🐍", pts:15,
    color:T.rose, format:"phonics",
    orbPact:"Every big reader started with one little sound.",
    content:"The letter S makes the /s/ sound — like a snake saying sssss! In Grade R we start with sounds, not letter names. Say the sound, find it in words, draw things that start with it. Your brain learns by DOING, not just listening.",
    activity:"1. Say /s/ /s/ /s/ three times out loud.\n2. Find 3 things in your home that start with S.\n3. Draw them and write the letter S next to each one.\n4. Read the sentence at the bottom — point to each word.",
    tip:"Say the sound, don't say the name. /s/ not 'ess'!",
    phonicsLetter:"S",
    phonicsWords:["sun","star","sock","snake","soap","seed"],
    phonicsEmojis:["☀️","⭐","🧦","🐍","🧼","🌱"],
    sightWords:["see","said","so","sit","is"],
    phoneticSentence:"The sun is so big.",
  },
  // ── R·2 ── PHONICS: Letter M ──────────────────────────────
  { id:"caps_r_2", title:"The M Sound — Mmmm!", subject:"Home Language · Phonics", icon:"🌙", pts:15,
    color:T.cobalt, format:"phonics",
    orbPact:"Mmmmm — sounds like something yummy, and learning IS yummy.",
    content:"The letter M makes the /m/ sound. You can feel it! Put your lips together and hum: mmmmm. Your lips vibrate. M is one of the first sounds babies make — 'mama' starts with M. Now we make it stronger.",
    activity:"1. Say /m/ /m/ /m/ — feel your lips close!\n2. Hum the sound and put your hand on your throat — feel the buzz?\n3. Draw 3 things that start with M.\n4. Read the sentence and clap once for each word.",
    tip:"Close your lips to make /m/. Open for every other sound!",
    phonicsLetter:"M",
    phonicsWords:["moon","map","mud","mop","milk","mat"],
    phonicsEmojis:["🌙","🗺️","💧","🧹","🥛","🛏️"],
    sightWords:["me","my","make","more","am"],
    phoneticSentence:"My mom makes me milk.",
  },
  // ── R·3 ── WRITING: How to Hold a Pencil & Form Letters ───
  { id:"caps_r_3", title:"Pencil Power — Let's Write!", subject:"Home Language · Writing", icon:"✏️", pts:15,
    color:T.sage, format:"step_by_step",
    orbPact:"Every author started by learning to hold a pencil.",
    content:"Writing starts with your hand, not the pencil. Before letters come grip, posture, and control. Short practice sessions (5–10 minutes) beat long frustrated ones every time. Progress, not perfection — every wobbly line is a brain connection forming.",
    activity:"1. Hold your pencil the tripod way (3 fingers).\n2. Trace the line exercises on paper: straight lines, curves, zigzags.\n3. Write the letter S three times — big, medium, small.\n4. Write the letter M three times.\n5. Draw a sun and write S next to it. Draw a moon and write M.",
    tip:"Progress, not perfection! Every wobbly letter is your brain getting stronger.",
    steps:[
      "Sit Up Straight::Feet flat on floor|Sit close to desk|Paper tilted slightly",
      "Tripod Grip::Thumb + pointer + middle finger|Hold loosely — not too tight|Pencil rests on ring finger",
      "Start on the Lines::Write BIG first|Then medium|Then small",
      "Trace Before You Write::Trace with your finger|Then trace lightly in pencil|Then write on your own",
      "Short Bursts Work Best::5–10 minutes only|Rest your hand|Come back later",
      "Celebrate Every Letter::Wobbly is OK|Each try gets better|You ARE a writer",
      "Take a Break Move!::Shake your hands|Do wall push-ups|Wiggle fingers 10 times",
      "Check Your Work::Did you sit on the line?|Does it look like the letter?|Circle your best one",
    ],
    stepEmojis:["🪑","✏️","📏","👆","⏱️","🌟","💪","👁️"],
    stepColors:[T.cobalt, T.rose, T.sage, T.terracotta, T.gold, T.success, T.ember, T.mahogany],
  },
  // ── R·4 ── NUMBERS: Counting 1–10 ─────────────────────────
  { id:"caps_r_4", title:"Counting 1 to 10 — Let's Count!", subject:"Mathematics", icon:"🔢", pts:15,
    color:T.terracotta, format:"step_by_step",
    orbPact:"Every number tells a story. Let's count yours.",
    content:"Counting is not just saying numbers — it's matching one number to one object. This is called one-to-one correspondence and it's the most important maths skill in Grade R. Touch, say, count. Touch, say, count. Fingers first, always.",
    activity:"1. Count 10 objects around you — touch each one as you count.\n2. Draw 5 apples. Write the number 5.\n3. Draw 3 stars. Write the number 3.\n4. Which is more — 5 or 3? Circle the bigger number.",
    tip:"Touch each thing as you count. One touch = one number. Never skip!",
    steps:[
      "1 — One::ONE finger up|ONE sun in the sky|ONE you!",
      "2 — Two::TWO eyes|TWO hands|TWO shoes",
      "3 — Three::THREE wheels on a tricycle|THREE little pigs|Count: 1, 2, 3",
      "4 — Four::FOUR legs on a dog|FOUR wheels on a car|Count: 1, 2, 3, 4",
      "5 — Five::FIVE fingers on one hand|High five!|Count: 1, 2, 3, 4, 5",
      "6 — Six::SIX legs on an insect|Count both hands to 5, add 1",
      "7 — Seven::SEVEN days in a week|Count on — start at 5, add 2 more",
      "8 — Eight::EIGHT legs on a spider|Count on from 7: 7… 8",
    ],
    stepEmojis:["1️⃣","2️⃣","3️⃣","4️⃣","✋","🐛","📅","🕷️"],
    stepColors:[T.rose, T.cobalt, T.sage, T.terracotta, T.gold, T.success, T.ember, T.mahogany],
  },
  // ── R·5 ── SHAPES ─────────────────────────────────────────
  { id:"caps_r_5", title:"Shapes Are Everywhere!", subject:"Mathematics · Shapes", icon:"🔷", pts:15,
    color:T.cobalt, format:"knowledge",
    orbPact:"A circle, a square, a triangle — the whole world is made of shapes.",
    content:"Before numbers, shapes! Recognising shapes builds spatial reasoning — the same brain skill used in maths, science, engineering, and art. Every shape has rules: circles have no corners, squares have 4 equal sides, triangles have 3 corners. Find the rules, find the shapes.",
    activity:"Go on a Shape Hunt! Find:\n• 3 circles in your home (clock? plate? wheel?)\n• 3 rectangles (door? window? book?)\n• 1 triangle (slice of bread? roof? pizza?)\nDraw each one and write the shape name.",
    tip:"Count the corners! 0 corners = circle. 3 corners = triangle. 4 corners = square or rectangle.",
    knowledgeItems:[
      "⭕ Circle — 0 corners, round all the way",
      "🔲 Square — 4 equal sides, 4 corners",
      "📐 Triangle — 3 sides, 3 corners",
      "▭ Rectangle — 4 sides, long and short",
      "💎 Diamond — 4 sides, pointy top & bottom",
      "⭐ Star — pointy spikes all around",
    ],
  },
  // ── R·6 ── WH QUESTIONS ────────────────────────────────────
  { id:"caps_r_6", title:"Asking Questions — What, Where, Who?", subject:"Home Language · Speaking", icon:"❓", pts:15,
    color:T.sky, format:"wh_questions",
    orbPact:"The child who asks questions learns faster than the child who stays quiet.",
    content:"Asking questions is how humans learn. In Grade R we learn the WH question words — What, Where, When, Who — and when to use each one. Every story you read, every lesson you hear, every new thing you see — a question makes it stick in your brain.",
    activity:"Play Question Time with a grown-up:\n1. They describe something (an animal, a place, a food).\n2. You ask 3 WH questions to guess what it is.\n3. Swap — you describe, they guess.\n4. Try to use a different question word each time.",
    tip:"There are no silly questions. Only silly silences!",
    whQuestions:[
      { word:"What?", emoji:"📦", purpose:"asking about things", examples:["What is your name?","What do you want?","What is this?"] },
      { word:"Where?", emoji:"🗺️", purpose:"asking about places", examples:["Where do you live?","Where is my bag?","Where are we going?"] },
      { word:"When?", emoji:"⏰", purpose:"asking about time", examples:["When do we eat?","When is your birthday?","When will you come?"] },
      { word:"Who?", emoji:"👤", purpose:"asking about people", examples:["Who is your teacher?","Who made this?","Who lives here?"] },
      { word:"Why?", emoji:"🤔", purpose:"asking for reasons", examples:["Why are you crying?","Why is the sky blue?","Why do we sleep?"] },
      { word:"How?", emoji:"⚙️", purpose:"asking about method", examples:["How do you make bread?","How do you feel?","How does it work?"] },
    ],
  },
  // ── R·7 ── FEELINGS & SAFETY ──────────────────────────────
  { id:"caps_r_7", title:"My Feelings & Staying Safe", subject:"Life Skills", icon:"💛", pts:15,
    color:T.gold, format:"step_by_step",
    orbPact:"Knowing how you feel is the first kind of power.",
    content:"Feelings are not good or bad — they are information. Happy, sad, scared, angry, surprised, proud — every feeling is telling you something important. The child who can name their feelings can ask for help. The child who knows their safety rules stays safer. Both start here.",
    activity:"Feelings Mirror:\n1. Make each face: happy 😊, sad 😢, angry 😠, scared 😨, proud 😊.\n2. For each one, say: 'I feel _____ when _____.' Finish the sentence.\n3. Draw your face right now. What feeling is it? Write or say the word.\n4. Say out loud your full name and one person you can tell if you feel unsafe.",
    tip:"Your feelings are always OK. What you DO with them is what we practice.",
    steps:[
      "Happy 😊::Smile, big eyes|I feel happy when I play|It's OK to feel happy!",
      "Sad 😢::Droopy eyes, frown|I feel sad when I miss someone|It's OK to feel sad — tell someone",
      "Angry 😠::Tight fists, hot face|I feel angry when things are unfair|Breathe out slowly — 3 times",
      "Scared 😨::Wide eyes, goosebumps|I feel scared when I'm alone in the dark|Find a safe adult — fast",
      "Proud 😊::Stand tall, big smile|I feel proud when I try hard|Tell yourself: 'I did it!'",
      "Safe Touch vs Unsafe::Safe: hug from family|Unsafe: touch that makes you feel bad|ALWAYS tell a grown-up",
      "My Safe People::Parent / guardian|Teacher at school|Trusted neighbour or elder",
      "If I Feel Unsafe::Say NO loudly|Run to a safe place|Tell a trusted adult right away",
    ],
    stepEmojis:["😊","😢","😠","😨","🌟","🛡️","👨‍👩‍👧","🆘"],
    stepColors:[T.gold, T.cobalt, T.ember, T.mahogany, T.success, T.rose, T.sage, T.danger],
  },
  // ── R·8 ── STORY TIME: Nkanyezi's Morning ─────────────────
  { id:"caps_r_8", title:"Story Time: Nkanyezi's Morning", subject:"Home Language · Reading", icon:"📖", pts:15,
    color:T.mahogany, format:"journey",
    orbPact:"Every story is a small world you can visit anytime.",
    content:"Stories teach us about feelings, choices, and other people's lives — without us having to live every experience ourselves. When we read or listen to stories in Grade R, we are building vocabulary, memory, imagination, and empathy all at once. The best readers were read TO first.",
    activity:"Listen to or read this story:\n\n'Nkanyezi woke up early. The sun was just coming up. She put on her school uniform by herself. Then she made her bed — one corner, two corners, three corners, four. She ate her pap. She picked up her bag. She walked to school with her brother Sbu. On the way, they saw a dog. Nkanyezi said: \"Don't run — walk slowly.\" Sbu listened. The dog wagged its tail and walked away.'\n\nThen answer:\n1. What time did Nkanyezi wake up?\n2. Who did she walk with?\n3. Why did she say 'Don't run'?\n4. What did the dog do at the end?",
    tip:"Point to each word as you read. Reading is pointing + saying + thinking — all at once.",
  },
];


// ─── CAPS GRADES 1–3 MODULES (Foundation Phase continued) ────
const CAPS_1_MODS = [
  { id:"caps_1_1", title:"Phonics & Early Reading", subject:"Home Language", icon:"📖", pts:15,
    color:T.cobalt, format:"knowledge", grade:"1",
    orbPact:"Every letter is a door. You hold the key.",
    content:"In Grade 1, reading begins with phonics — the sounds that letters make. English has 44 sounds but only 26 letters, so patterns matter. The most important skill is blending: pushing sounds together to form words. 'C-A-T' → 'cat'. Practice this daily, and reading unlocks itself within weeks.",
    activity:"Find 5 objects in your home. Say each word slowly, sound by sound. Write the first letter of each object. Read them back.",
    tip:"Don't rush reading. Slow, correct reading beats fast, wrong reading every time.",
    knowledgeItems:["Letter sounds (phonemes)","Blending: c-a-t → cat","Sight words: the, is, and, a, to","Left to right reading direction","Capital letters start sentences"],
  },
  { id:"caps_1_2", title:"Adding & Subtracting to 20", subject:"Mathematics", icon:"➕", pts:15,
    color:T.sage, format:"function_chart", grade:"1",
    orbPact:"Numbers bend to those who practice.",
    content:"Grade 1 maths builds on counting to introduce addition and subtraction within 20. The key is using physical objects first — fingers, stones, beans — before moving to abstract numbers. Concrete → pictorial → abstract is the path every confident mathematician took.",
    activity:"Use 10 small objects (stones, bottle caps, beans). Show 3+4. Show 9–5. Write the number sentence each time. Do 5 more sums.",
    tip:"If you can touch it, you understand it. Always start with real objects.",
    functionItems:["Count on: 6+3, start at 6 count 3 more","Count back: 9–4, start at 9 count back 4","Number bonds to 10: pairs that make 10","Doubles: 2+2, 3+3, 4+4","Word problems: more than / less than"],
  },
  { id:"caps_1_3", title:"Myself & My World", subject:"Life Skills", icon:"🧒", pts:15,
    color:T.terracotta, format:"life_lesson", grade:"1",
    orbPact:"The safest child is the child who knows their own story.",
    content:"Grade 1 Life Skills teaches personal safety, health, and identity. Children who know their full name, address, and how to describe feelings are significantly safer and more resilient. This knowledge is protective — it helps children identify danger and ask for help.",
    activity:"Learn and say out loud: your full name, your parent/guardian's name, your address. Practice saying 'I feel _____ because _____' with three different feelings today.",
    tip:"Knowing who you are is the first kind of strength.",
    formatItems:["My full name and family name","My home address","Feelings and how to name them","Safe vs unsafe touch","People who can help me: parents, teachers, police"],
  },
  { id:"caps_1_4", title:"Telling the Time", subject:"Mathematics / Life Skills", icon:"⏰", pts:15,
    color:T.gold, format:"ranking", grade:"1",
    orbPact:"Time is the one thing you cannot earn back. Know it.",
    content:"Grade 1 learners begin with o'clock and half past on analogue clocks. Understanding time builds routine, responsibility, and independence. A child who can read a clock can get themselves ready for school — a life skill that multiplies into hundreds of other habits.",
    activity:"Look at a clock (or draw one). Set it to 7 o'clock (school time), 1 o'clock (lunch), 3 o'clock (home time). Draw each clock face and write what you do at that time.",
    tip:"The short hand tells the HOUR. The long hand tells the MINUTES. Always read the short hand first.",
    rankings:["#1: O'clock — long hand points straight up","#2: Half past — long hand points straight down","#3: Read short hand first (the hour)","#4: Digital clocks say the same thing differently","#5: Morning (AM) vs afternoon (PM) matters"],
  },
];

const CAPS_2_MODS = [
  { id:"caps_2_1", title:"Reading for Meaning", subject:"Home Language", icon:"🔍", pts:18,
    color:T.cobalt, format:"diagnostic", grade:"2",
    orbPact:"A reader who understands owns the text. A reader who just decodes is still locked out.",
    content:"Grade 2 moves from decoding (sounding out words) to comprehension (understanding meaning). The transition is critical. Many learners can read words but cannot answer questions about what they read. Comprehension requires actively asking: Who? What? Where? When? Why?",
    activity:"Read any 5-sentence passage (a story, a notice, a caption). Answer: Who is it about? What happens? Where does it happen? How does it end? Write your answers.",
    tip:"Good readers ask questions while they read, not just after.",
    diagnosticCategories:["Who? — Characters & people","What? — Events & actions","Where/When? — Setting","Why? — Reasons & feelings"],
  },
  { id:"caps_2_2", title:"Place Value: Tens & Units", subject:"Mathematics", icon:"🔟", pts:18,
    color:T.sage, format:"knowledge", grade:"2",
    orbPact:"Every big number is built from small ones.",
    content:"Grade 2 introduces place value — understanding that 34 means 3 tens and 4 units, not 3 and 4 separately. This single concept unlocks all future maths: addition with carrying, subtraction with borrowing, multiplication, decimals, and beyond. It is the foundation brick of number sense.",
    activity:"Write any number between 20 and 99. Break it into tens and units. Example: 47 = 4 tens + 7 units. Do this for 5 different numbers. Then add: 23 + 14. Show your working.",
    tip:"Always draw the tens as bundles of 10 sticks and the units as single sticks when you're learning.",
    knowledgeItems:["Units (ones): 1 to 9","Tens: 10, 20, 30 … 90","Reading 2-digit numbers","Adding tens and units separately","Number lines from 0 to 100"],
  },
  { id:"caps_2_3", title:"Living & Non-Living Things", subject:"Natural Sciences & Technology", icon:"🌱", pts:18,
    color:T.sage, format:"function_chart", grade:"2",
    orbPact:"Science begins the moment you ask 'why?'",
    content:"Grade 2 Life Skills introduces the distinction between living and non-living things. All living things share seven properties: they move, feed, grow, reproduce, respond, excrete, and respire. Non-living things do not. This classification system is the entry point to all biological science.",
    activity:"Go outside or look around your home. List 5 living things and 5 non-living things. For each living thing, say how you know it's alive (does it grow? move? eat?).",
    tip:"A car moves but is not alive. A tree barely moves but is alive. Movement alone doesn't tell you — look for ALL seven signs.",
    functionItems:["Move → Animals walk, plants turn to light","Feed → Eat or make food","Grow → Get bigger over time","Reproduce → Make more of themselves","Respond → React to heat, light, touch"],
  },
  { id:"caps_2_4", title:"Measurement: Length & Mass", subject:"Mathematics", icon:"📏", pts:18,
    color:T.ember, format:"ranking", grade:"2",
    orbPact:"Measurement turns guessing into knowing.",
    content:"Grade 2 measurement teaches centimetres, metres, grams, and kilograms. More importantly, it teaches estimation — the ability to make a good guess before measuring. Estimation is a life skill used in cooking, building, budgeting, and engineering. The standard unit was invented so that everyone's measure means the same thing.",
    activity:"Measure 3 objects using a ruler. Estimate first, then measure. Record: estimate vs actual. Try to estimate a 1kg mass using a bag of flour or rice for comparison.",
    tip:"Always estimate before you measure. The gap between estimate and actual is what learning looks like.",
    rankings:["#1: Estimate before measuring (trains intuition)","#2: Centimetres for small lengths (pencil, hand)","#3: Metres for big lengths (room, road)","#4: Grams for light mass (apple, eraser)","#5: Kilograms for heavy mass (bag, person)"],
  },
];

const CAPS_3_MODS = [
  { id:"caps_3_1", title:"Writing Paragraphs", subject:"Home Language", icon:"✍️", pts:20,
    color:T.cobalt, format:"journey", grade:"3",
    orbPact:"A paragraph is a complete thought. Master one, and you can write anything.",
    content:"Grade 3 introduces formal paragraph writing: a topic sentence, supporting sentences, and a closing sentence. This structure is the DNA of all academic and professional writing — essays, reports, emails, arguments. A learner who masters paragraphs in Grade 3 is already ahead in Grades 10–12.",
    activity:"Write a paragraph about your favourite food. Start with: 'My favourite food is ___.' Write 3 sentences about why you like it. End with: 'That is why I love ___.' Count your sentences.",
    tip:"Topic sentence → 3 supporting sentences → closing sentence. That's the formula. Use it forever.",
  },
  { id:"caps_3_2", title:"Multiplication & Division", subject:"Mathematics", icon:"✖️", pts:20,
    color:T.terracotta, format:"function_chart", grade:"3",
    orbPact:"Multiplication is just fast addition. Division is just fair sharing.",
    content:"Grade 3 introduces multiplication tables and division. Multiplication is repeated addition (3×4 = 3+3+3+3). Division is sharing equally (12÷4 = how many groups of 4 fit in 12?). These two operations are inverses of each other — knowing one unlocks the other. Memorising the 2, 5, and 10 times tables is the single best investment a Grade 3 learner can make.",
    activity:"Write out the 2× table from 2×1 to 2×10. Then write the 5× table. For each answer, write the matching division: 2×5=10, so 10÷2=5. Make the connection.",
    tip:"Times tables are patterns, not memory tests. See the pattern: 5× always ends in 0 or 5.",
    functionItems:["2× table → even numbers pattern","5× table → ends in 0 or 5","10× table → just add a zero","Division = inverse of multiplication","Word problems: 'shared equally' = divide"],
  },
  { id:"caps_3_3", title:"The Water Cycle", subject:"Natural Sciences & Technology", icon:"💧", pts:20,
    color:T.sky, format:"knowledge", grade:"3",
    orbPact:"Water never disappears. It travels.",
    content:"Grade 3 Natural Sciences introduces the water cycle: evaporation (water turns to vapour from heat), condensation (vapour cools and forms clouds), precipitation (rain/snow/hail falls), and collection (gathers in rivers, dams, ground). Understanding this cycle is climate literacy — increasingly critical as droughts and floods affect communities worldwide.",
    activity:"Put a cup of water in sunlight for an hour. Observe. Where did the water go? Draw the water cycle with arrows and label each stage. Explain it to someone in your home.",
    tip:"The water in your cup may have once been in a cloud over the ocean. Water is the world's greatest traveller.",
    knowledgeItems:["Evaporation: liquid → vapour (heat)","Condensation: vapour → droplets (cooling)","Precipitation: rain, hail, snow","Collection: rivers, dams, groundwater","The cycle never stops — water is reused"],
  },
  { id:"caps_3_4", title:"My Community, My Economy", subject:"Economic & Management Sciences", icon:"🏘️", pts:20,
    color:T.gold, format:"life_lesson", grade:"3",
    orbPact:"Every business in your street is a lesson in economics.",
    content:"Grade 3 EMS introduces the idea of needs vs wants, goods vs services, and producers vs consumers. These six concepts explain nearly every economic decision a person will make in their life — from choosing what to buy, to understanding why some jobs pay more than others. Economics starts on your own street.",
    activity:"Walk around your street or neighbourhood (or describe it from memory). List 3 businesses or people who provide goods and 3 who provide services. For each: who are they serving, and what need does it meet?",
    tip:"A need is something you cannot survive without. A want is something that improves your life. The line between them is where budgeting starts.",
    formatItems:["Needs: food, shelter, clothing, safety","Wants: toys, sweets, TV, holidays","Goods: physical things you can hold","Services: work done for you","Producers: people who make or grow","Consumers: people who buy or use"],
  },
];

// All CAPS grade-specific modules indexed by grade
// ─── CAPS GRADE 4 MODULES (Intermediate Phase) ───────────────
const CAPS_4_MODS = [
  { id:"caps_4_1", title:"Essay Writing: Paragraph Planning", subject:"Home Language", icon:"✍️", pts:20,
    color:T.cobalt, format:"journey", grade:"4",
    orbPact:"A planned writer never runs out of things to say.",
    content:"Grade 4 Home Language introduces structured essay writing. The paragraph planning model — brainstorm, outline, draft, revise — is the professional writing process used by journalists, lawyers, and authors. Learning it now means every piece of writing for the rest of your life gets easier. The five-paragraph essay (intro, 3 body paragraphs, conclusion) is the template that unlocks most school writing tasks from Grade 4 to matric.",
    activity:"Choose a topic you care about (your community, a sport, an animal). Write a 5-point outline: 1 introduction idea, 3 body points, 1 conclusion idea. Then write one full body paragraph using your outline.",
    tip:"The outline is the thinking. The writing is just the explaining. Never skip the outline.",
  },
  { id:"caps_4_2", title:"First Additional Language: Reading Strategies", subject:"First Additional Language", icon:"🌐", pts:20,
    color:T.sky, format:"diagnostic", grade:"4",
    orbPact:"A second language is a second life.",
    content:"Grade 4 introduces formal First Additional Language (FAL) instruction — typically English or Afrikaans in South African schools. The key reading strategies are: skimming (reading fast for the main idea), scanning (searching for specific information), and intensive reading (reading carefully for detail). These three strategies are used in every exam, every job, every life decision involving text.",
    activity:"Find any short article or notice. First skim it: what is the main topic? (10 seconds). Then scan it: find one specific fact (a number, a name). Then read it carefully: what is the author's opinion or purpose?",
    tip:"Skimming and scanning are not lazy reading. They are skilled, deliberate reading for a purpose.",
    diagnosticCategories:["Skim — Main idea (fast)","Scan — Find a fact (targeted)","Read — Deep meaning (slow)","Infer — What is NOT said?"],
  },
  { id:"caps_4_3", title:"Common Fractions", subject:"Mathematics", icon:"½", pts:22,
    color:T.terracotta, format:"function_chart", grade:"4",
    orbPact:"Half a loaf is better than none — but only if you know what half means.",
    content:"Grade 4 Mathematics introduces common fractions: halves, thirds, quarters, fifths, and tenths. A fraction represents a part of a whole. The bottom number (denominator) says how many equal parts the whole is cut into. The top number (numerator) says how many parts you have. Fractions underpin percentages, decimals, probability, and recipes — they are everywhere in real life.",
    activity:"Take any food item or draw a rectangle. Show: ½, ¼, ¾, and ⅓. Write the fraction name, draw it, and write a real-life sentence using it (e.g. 'I ate ¾ of the pizza.').",
    tip:"Always check: are the parts EQUAL? A fraction only works when the whole is cut into equal pieces.",
    functionItems:["Numerator → how many parts you have","Denominator → total equal parts","½ = 2 equal parts, take 1","¼ = 4 equal parts, take 1","Equivalent fractions: ½ = 2/4 = 4/8"],
  },
  { id:"caps_4_4", title:"Matter & Materials", subject:"Natural Sciences & Technology", icon:"⚗️", pts:20,
    color:T.sage, format:"knowledge", grade:"4",
    orbPact:"Everything you can touch is made of matter. Knowing what it's made of is power.",
    content:"Grade 4 Natural Sciences introduces matter — anything that has mass and takes up space. Matter exists in three states: solid (fixed shape and volume), liquid (fixed volume, takes the shape of its container), and gas (no fixed shape or volume). Understanding states of matter explains cooking, weather, construction, and manufacturing. It is the foundation of chemistry and materials science.",
    activity:"Find 3 examples of each state of matter in your home: 3 solids, 3 liquids, 3 gases. For each, describe: does it have a fixed shape? Does it have a fixed volume? Write your findings in a table.",
    tip:"Ice, water, and steam are the same substance (H₂O) in three different states. Temperature changes the state — not the material itself.",
    knowledgeItems:["Solid: fixed shape + fixed volume","Liquid: fixed volume, no fixed shape","Gas: no fixed shape or volume","Changing state: melting, freezing, evaporation","Matter can change state and change back"],
  },
  { id:"caps_4_5", title:"Maps & Geography: My Province", subject:"Social Sciences", icon:"🗺️", pts:20,
    color:T.mahogany, format:"ranking", grade:"4",
    orbPact:"To know where you are going, you must first know where you are.",
    content:"Grade 4 Social Sciences (Geography strand) introduces map skills and South Africa's nine provinces. Map literacy — reading direction (N/S/E/W), understanding scale, and interpreting a key/legend — is a real-world skill used in navigation, logistics, urban planning, and emergency response. Every map is an argument about what matters — the map-maker decides what to include and leave out.",
    activity:"Draw a map of your street or neighbourhood from memory. Include: at least 3 landmarks, a compass rose (N/S/E/W), and a simple key. Then compare your map to Google Maps or a real map if available. What did you get right? What did you miss?",
    tip:"A map is not reality — it is a simplified model of reality. Always ask: what did the map-maker choose NOT to show?",
    rankings:["#1: Compass — N, S, E, W (Never Eat Soggy Waffles)","#2: Scale — distance on paper vs real distance","#3: Key/Legend — what each symbol means","#4: Grid references — find a place by row and column","#5: SA's 9 provinces + their capital cities"],
  },
  { id:"caps_4_6", title:"Healthy Living & Personal Safety", subject:"Life Skills", icon:"💪", pts:18,
    color:T.rose, format:"life_lesson", grade:"4",
    orbPact:"Your body is the only home you will live in forever. Maintain it.",
    content:"Grade 4 Life Skills covers physical health, nutrition, and personal safety. The five food groups (carbohydrates, proteins, fats, vitamins/minerals, water) each play a different role in the body. Understanding nutrition at Grade 4 level is protective — it helps learners identify and resist poor food choices marketed to them daily. Personal safety includes recognising unsafe situations, understanding consent, and knowing who to tell.",
    activity:"Plan one day of healthy meals. For each meal, identify which food groups are represented. Then write 3 personal safety rules you follow (or should follow) every day.",
    tip:"Advertising is designed to make you want unhealthy things. Knowing the five food groups gives you the knowledge to push back.",
    formatItems:["Carbohydrates → energy (bread, rice, maize)","Proteins → growth & repair (eggs, beans, meat)","Fats → insulation & brain function (oils, avocado)","Vitamins & minerals → immune system (fruit, veg)","Water → every body process requires it"],
  },
  { id:"caps_4_7", title:"Needs, Wants & Budgeting", subject:"Economic & Management Sciences", icon:"💰", pts:20,
    color:T.gold, format:"diagnostic", grade:"4",
    orbPact:"The person who controls their spending controls their future.",
    content:"Grade 4 EMS introduces economic decision-making at the personal and household level. Needs (food, shelter, clothing, healthcare) vs wants (entertainment, luxuries) is the first economic distinction every person must make. A budget is a plan that aligns spending with what matters most. Children who understand budgeting before high school make measurably better financial decisions as adults.",
    activity:"You receive R200 for the month. List your needs first (how much for each?). Then see what is left. Allocate it to wants. Total must equal R200. What did you have to sacrifice? Write one sentence explaining your hardest choice.",
    tip:"A budget doesn't tell you to stop enjoying life. It tells you to decide in advance — before the money is gone.",
    diagnosticCategories:["Needs — Must have to survive","Wants — Nice to have if affordable","Income — Money that comes in","Expenditure — Money that goes out"],
  },
];

// ─── CAPS GRADE 5 MODULES (Intermediate Phase) ───────────────
const CAPS_5_MODS = [
  { id:"caps_5_1", title:"Transactional Writing: Letters & Emails", subject:"Home Language", icon:"📬", pts:22,
    color:T.cobalt, format:"function_chart", grade:"5",
    orbPact:"The person who can write a clear letter can open any door.",
    content:"Grade 5 Home Language introduces transactional writing — writing that gets something done in the real world. Formal letters, informal letters, and emails each have a fixed structure that signals competence and respect. Employers, universities, and government departments judge people by their writing before they meet them. Mastering letter format in Grade 5 is a long-term career investment.",
    activity:"Write a formal letter to your school principal requesting permission for a class outing. Include: date, address block, greeting, body (3 paragraphs), closing, and signature. Then rewrite the same request as an informal letter to a friend.",
    tip:"Formal = distant and respectful. Informal = warm and relaxed. The STRUCTURE changes — so does the TONE. Know which one the situation demands.",
    functionItems:["Date → top right, formal letters","Address block → sender then recipient","Greeting → Dear Sir/Madam (formal), Hi Thabo (informal)","Body → purpose, details, request","Closing → Yours faithfully (formal), Take care (informal)"],
  },
  { id:"caps_5_2", title:"Comprehension: Inference & Fact", subject:"First Additional Language", icon:"🔎", pts:22,
    color:T.sky, format:"diagnostic", grade:"5",
    orbPact:"What the text says is the beginning. What it means is the destination.",
    content:"Grade 5 FAL comprehension moves beyond literal questions (what does the text say?) to inferential questions (what does the text suggest?). Inference is reading between the lines — understanding mood, motive, and implied meaning. This skill separates average readers from strong ones, and is tested in every major exam from Grade 5 to matric. It is also the core skill for detecting fake news, advertising manipulation, and political spin.",
    activity:"Read any paragraph from a book, article or notice. Answer: (1) One thing the text states directly. (2) One thing the text implies but does not say. (3) Why do you think the author chose this topic? Justify each answer.",
    tip:"Inference questions often use words like 'suggest', 'imply', 'probably', 'likely'. They want your reasoning — not just a quote from the text.",
    diagnosticCategories:["Literal — what it says","Inferential — what it implies","Vocabulary — what words mean","Author's purpose — why it was written"],
  },
  { id:"caps_5_3", title:"Decimals & Percentages", subject:"Mathematics", icon:"🔣", pts:24,
    color:T.terracotta, format:"knowledge", grade:"5",
    orbPact:"Percentages run the world — tax, interest, discount, data. Learn them now.",
    content:"Grade 5 Mathematics connects fractions, decimals, and percentages as three ways of expressing the same thing. Half = 0.5 = 50%. This trinity is the language of finance, science, and statistics. A learner who can move fluently between these three forms can decode any data they encounter — from a bank statement to a news graph to a school report.",
    activity:"Convert each of the following both ways — to decimal AND to percentage: one quarter, three quarters, one fifth, three tenths. Then find 25% of R80 and 10% of R350. Show all working.",
    tip:"To find 10% of any number, just move the decimal point one place to the left. 10% of R460 = R46. Then you can build any percentage from there.",
    knowledgeItems:["Fraction to decimal: divide top by bottom","Decimal to percentage: multiply by 100","10% shortcut: move decimal left one place","50% = half, 25% = quarter, 75% = three quarters","VAT (15% in SA) is a real-world percentage applied daily"],
  },
  { id:"caps_5_4", title:"Energy: Sources & Transfer", subject:"Natural Sciences & Technology", icon:"⚡", pts:22,
    color:T.sage, format:"ranking", grade:"5",
    orbPact:"Energy cannot be created or destroyed — only transformed. You are part of that system.",
    content:"Grade 5 Natural Sciences introduces energy — the capacity to do work. Energy comes in many forms (kinetic, potential, thermal, light, sound, electrical, chemical) and transfers from one form to another. Understanding energy sources (renewable vs non-renewable) is climate literacy. South Africa's load-shedding crisis, global warming, and the cost of electricity all trace back to decisions about energy — decisions that Grade 5 learners will inherit.",
    activity:"Trace the energy transfers in making a cup of tea: chemical energy (gas/electricity source) to thermal energy (stove) to thermal energy (water) to thermal energy (your body). Now identify 2 renewable and 2 non-renewable energy sources available in your community.",
    tip:"Renewable energy replenishes naturally (sun, wind, water). Non-renewable runs out (coal, oil, gas). South Africa gets about 85% of its electricity from coal — a fact worth understanding.",
    rankings:["#1: Solar — sun's radiation to electrical (panels)","#2: Wind — kinetic to electrical (turbines)","#3: Hydro — water movement to electrical (dams)","#4: Coal — chemical to thermal to electrical (SA primary)","#5: Nuclear — atomic to thermal to electrical (Koeberg)"],
  },
  { id:"caps_5_5", title:"South Africa's History: Pre-1994", subject:"Social Sciences", icon:"🕊️", pts:22,
    color:T.mahogany, format:"life_lesson", grade:"5",
    orbPact:"Those who do not know their history are condemned to repeat it.",
    content:"Grade 5 Social Sciences introduces South Africa's colonial and apartheid history. Understanding apartheid — the legal system of racial separation enforced from 1948 to 1994 — is essential for understanding present-day inequality, land, language politics, and why certain communities still carry structural disadvantages. This is one of the world's most documented case studies in how power, law, and identity interact.",
    activity:"Interview the oldest person you have access to (grandparent, neighbour, elder). Ask: What did apartheid mean for your daily life? Write down their answer in at least 5 sentences. This is primary source history — irreplaceable.",
    tip:"History is not neutral. Every account is told from a position. Ask: whose voice is in this source? Whose voice is missing?",
    formatItems:["1948 — National Party wins, apartheid begins","Pass Laws — controlled where Black South Africans could live","Bantu Education — deliberately inferior schooling by law","1960 Sharpeville — 69 protestors killed by police","1976 Soweto Uprising — students resist Afrikaans instruction","1990 — Mandela released, negotiations begin","1994 — first democratic elections, ANC wins"],
  },
  { id:"caps_5_6", title:"Physical Education & Teamwork", subject:"Life Skills", icon:"🏃", pts:18,
    color:T.rose, format:"growth_mirror", grade:"5",
    orbPact:"A team that trains together builds more than fitness — it builds trust.",
    content:"Grade 5 Life Skills Physical Education develops coordination, fair play, and teamwork. Research shows that learners who participate in structured physical activity perform better academically — the brain benefits directly from exercise through increased blood flow, improved mood, and better concentration. Teamwork is also the most cited skill by employers worldwide. Sport teaches it faster than most classroom activities.",
    activity:"Organise a simple team game with 2 or more people. After playing: (1) Name one thing your team did well. (2) Name one thing you personally could improve. (3) Write down one rule of fair play that was followed — or broken.",
    tip:"The best athletes are often the best teammates. Notice who passes, who listens, who encourages. Those are the leaders.",
    milestones:["Coordination: ball skills, balance, agility","Rules: follow them even when no one is watching","Fair play: respect opponents and teammates","Teamwork: communicate, share, encourage","Reflection: learn from wins AND losses"],
  },
  { id:"caps_5_7", title:"Production, Consumption & Trade", subject:"Economic & Management Sciences", icon:"🔄", pts:22,
    color:T.gold, format:"function_chart", grade:"5",
    orbPact:"Every product you use was made by someone, somewhere. That chain is the economy.",
    content:"Grade 5 EMS introduces the production-consumption cycle and the concept of trade. Producers make goods or provide services. Consumers buy and use them. Trade (exchanging goods, services, or money) is how wealth moves through an economy. Understanding this cycle explains why prices rise (scarcity, demand), why some countries are richer (production capacity), and how your daily choices connect to a global system.",
    activity:"Choose any product in your home (food, clothing, electronic). Trace its journey: Where was the raw material from? Where was it made? How did it reach your home? Who made money at each step? Write each step as a chain.",
    tip:"Every purchase is a vote. When you buy something, you tell producers: make more of this. Understanding production chains makes you a conscious consumer.",
    functionItems:["Raw materials → extracted from nature","Production → transformed into a product","Distribution → transported to markets","Retail → sold to the consumer","Consumption → used, then disposed or recycled"],
  },
];

// ─── CAPS GRADE 6 MODULES (Intermediate Phase — final year) ──
const CAPS_6_MODS = [
  { id:"caps_6_1", title:"Argument Writing: Persuade & Debate", subject:"Home Language", icon:"🗣️", pts:24,
    color:T.cobalt, format:"journey", grade:"6",
    orbPact:"The person who argues well never needs to shout.",
    content:"Grade 6 Home Language introduces argumentative writing — the ability to take a position and defend it with evidence, logic, and structure. This is the most powerful writing skill in academic and professional life. A well-structured argument: states a clear position, supports it with at least three pieces of evidence, acknowledges the opposing view, and refutes it. Lawyers, journalists, scientists, and politicians all use this exact structure.",
    activity:"Choose a statement you disagree with (e.g. 'School uniforms should be abolished' or 'Social media is bad for young people'). Write 3 paragraphs: (1) Your position. (2) Your strongest evidence. (3) The opposing view AND why you still disagree. Use 'however', 'although', 'despite' to signal your counter-argument.",
    tip:"A weak argument ignores the other side. A strong argument faces it — and defeats it with evidence, not emotion.",
  },
  { id:"caps_6_2", title:"Speaking & Presenting: Oral Skills", subject:"First Additional Language", icon:"🎤", pts:22,
    color:T.sky, format:"ranking", grade:"6",
    orbPact:"Your voice, used well, is worth more than any qualification.",
    content:"Grade 6 FAL oral skills — formal speeches, presentations, and discussions — are assessed in every year through matric and beyond. Research consistently shows that the ability to speak confidently in a second language dramatically expands employment opportunities and social mobility. The fear of public speaking is nearly universal; those who train through it gain a lasting advantage.",
    activity:"Prepare a 2-minute speech on any topic you know well. Practise it out loud THREE times before delivering it. Time yourself. Record yourself on a phone if possible. Watch it back: note one thing you did well and one thing to improve.",
    tip:"Practising out loud is different from practising in your head. Your mouth, breath, and body need the rehearsal — not just your mind.",
    rankings:["#1: Know your content — confidence comes from preparation","#2: Eye contact — look at your audience, not your notes","#3: Voice pace — slow down, especially at key points","#4: Structure — opening hook, body points, strong close","#5: Body language — stand still, breathe, own the space"],
  },
  { id:"caps_6_3", title:"Ratio, Rate & Proportion", subject:"Mathematics", icon:"⚖️", pts:26,
    color:T.terracotta, format:"function_chart", grade:"6",
    orbPact:"Ratio is how the world compares. Master it and you think in proportions.",
    content:"Grade 6 Mathematics introduces ratio, rate, and proportion — three related concepts that underpin cooking, medicine dosing, map scale, currency exchange, speed calculations, and financial interest. A ratio compares two quantities (2:3). A rate compares quantities with different units (60 km/h). A proportion states that two ratios are equal (1:2 = 3:6). These are not abstract concepts — they appear in every recipe, every journey, and every salary calculation.",
    activity:"You are making a recipe that serves 4 people but you need to serve 10. The recipe uses 200g flour, 3 eggs, and 150ml milk. Scale every ingredient correctly for 10 people. Show your ratio working. Then calculate: if a car travels at 80 km/h, how far does it travel in 2.5 hours?",
    tip:"Ratio questions become easy the moment you find the unit value. Find what ONE costs/weighs/takes, then multiply. Always.",
    functionItems:["Ratio → comparison of same units (2:3 boys to girls)","Rate → comparison of different units (R15 per litre)","Proportion → two equal ratios (1:2 = 5:10)","Unitary method → find 1, then multiply","Scale → map distance vs real distance (1:50 000)"],
  },
  { id:"caps_6_4", title:"Ecosystems & Food Webs", subject:"Natural Sciences & Technology", icon:"🌿", pts:24,
    color:T.sage, format:"knowledge", grade:"6",
    orbPact:"Every living thing depends on another. Break one link and the whole web shakes.",
    content:"Grade 6 Natural Sciences introduces ecosystems — communities of living organisms interacting with each other and their environment. Food chains show energy flow from producers (plants) to consumers (herbivores, carnivores) to decomposers. Food webs show the real complexity — multiple overlapping chains. Understanding ecosystems explains biodiversity loss, extinction cascades, invasive species, and why protecting a single species (like bees) can affect an entire agricultural system.",
    activity:"Draw a food web for your local environment (garden, park, veld, or ocean if coastal). Include at least: 2 producers, 3 herbivores, 2 carnivores, 1 decomposer. Draw arrows showing energy flow direction. Then remove one species — what happens to the others?",
    tip:"Arrows in a food web point FROM the food TO the eater — they show the direction of energy transfer, not who eats whom.",
    knowledgeItems:["Producer → makes own food via photosynthesis (plants)","Herbivore → eats only plants (first-order consumer)","Carnivore → eats animals (second/third-order consumer)","Omnivore → eats both plants and animals (humans)","Decomposer → breaks down dead matter (fungi, bacteria)"],
  },
  { id:"caps_6_5", title:"Southern Africa: Climate & Vegetation", subject:"Social Sciences", icon:"🌍", pts:22,
    color:T.mahogany, format:"diagnostic", grade:"6",
    orbPact:"Climate is what you expect. Weather is what you get. Know the difference — and why it matters.",
    content:"Grade 6 Social Sciences Geography covers Southern Africa's climate zones and biomes. South Africa has six major biomes: Fynbos, Succulent Karoo, Nama-Karoo, Grassland, Savanna, and Forest — each with unique rainfall patterns, temperatures, and vegetation. Understanding why different regions get different rainfall explains farming patterns, water security, migration, and economic inequality between provinces. Climate change is already altering these patterns.",
    activity:"Research (or recall from school) which biome your home area falls in. Write: (1) Average rainfall per year. (2) Main vegetation type. (3) One economic activity that depends on this biome. (4) One way climate change threatens it. If you don't know your biome, look it up — that research IS the activity.",
    tip:"South Africa is a water-scarce country — average rainfall is below the global average. Every biome's rainfall tells the story of who lives there and how.",
    diagnosticCategories:["Fynbos — SW Cape, winter rainfall, unique flora","Grassland — Highveld, summer rain, most farming","Savanna — bushveld, mixed trees & grass, game reserves","Karoo — semi-arid, sparse shrubs, sheep farming"],
  },
  { id:"caps_6_6", title:"Puberty, Identity & Relationships", subject:"Life Skills", icon:"🧬", pts:20,
    color:T.rose, format:"life_lesson", grade:"6",
    orbPact:"Change is not a problem. Ignorance about change is.",
    content:"Grade 6 Life Skills covers puberty — the physical and emotional changes that happen during adolescence. Puberty is a biological process, not something to be ashamed of. Understanding it in advance reduces anxiety, supports healthy self-image, and enables young people to recognise unsafe relationships. Research shows that comprehensive, age-appropriate education about puberty and relationships reduces teen pregnancy, sexual abuse, and peer exploitation.",
    activity:"Write a letter to your younger self (age 8 or 9). Explain three things about growing up that you wish you had known sooner. The letter is private — it is for you. But writing it builds the self-awareness that protects you.",
    tip:"You are not required to grow up at someone else's pace. You are also not required to be ashamed of any part of the process.",
    formatItems:["Physical changes: body, voice, skin — normal for everyone","Emotional changes: mood, identity, peer pressure — also normal","Consent: your body, your boundaries, always","Safe vs unsafe relationships: pressure is a warning sign","Who to tell: a trusted adult when something feels wrong"],
  },
  { id:"caps_6_7", title:"Financial Literacy: Income & Expenditure", subject:"Economic & Management Sciences", icon:"📊", pts:24,
    color:T.gold, format:"function_chart", grade:"6",
    orbPact:"Income minus expenditure equals your future. Make that number positive.",
    content:"Grade 6 EMS introduces formal personal financial statements — income and expenditure records that show exactly where money comes from and where it goes. The difference between income and expenditure is either a surplus (money left over = savings capacity) or a deficit (spending more than earning = debt). This is the most practically important financial skill most South Africans never formally learned, and it is the direct cause of household debt cycles in low-income communities.",
    activity:"Create a monthly income and expenditure statement for a fictional household earning R5 000/month. List at least 6 expenses (rent, food, transport, airtime, electricity, school fees). Calculate the total expenditure. Is there a surplus or deficit? If a deficit — what would you cut first, and why?",
    tip:"Track before you budget. You cannot control what you cannot see. Write down every expense for one week — the result is always surprising.",
    functionItems:["Income → all money received (salary, grants, side income)","Fixed expenses → same every month (rent, insurance)","Variable expenses → change monthly (food, transport, airtime)","Surplus → income exceeds expenditure (save this)","Deficit → expenditure exceeds income (danger zone — act now)"],
  },
];

const CAPS_GRADE_MODS = {
  "R":  CAPS_R_MODS,
  "1":  CAPS_1_MODS,
  "2":  CAPS_2_MODS,
  "3":  CAPS_3_MODS,
  "4":  CAPS_4_MODS,
  "5":  CAPS_5_MODS,
  "6":  CAPS_6_MODS,
};

// ─── CAPS SUBJECT FRAMEWORK CARD ─────────────────────────────
function CapsSubjectCard({ user }) {
  const grade = user?.grade;
  const phase = CAPS_PHASES[grade];
  if (!phase) return null;
  return (
    <div style={{ background:`linear-gradient(135deg, ${T.board}, #0F2A1E)`, borderRadius:T.r16, padding:"18px", marginBottom:"16px", color:T.white }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:"10px" }}>
        <div>
          <div style={{ fontSize:"0.6rem", color:T.gold, letterSpacing:"2px", textTransform:"uppercase", marginBottom:"3px" }}>CAPS Framework · Grade {grade}</div>
          <div style={{ fontFamily:T.display, fontSize:"1rem", fontWeight:"bold" }}>{phase.name}</div>
          <div style={{ fontSize:"0.72rem", color:"rgba(255,255,255,0.5)", marginTop:"2px" }}>Grades {phase.grades}</div>
        </div>
        <div style={{ background:"rgba(212,160,23,0.2)", border:`1px solid ${T.gold}`, borderRadius:T.r8, padding:"6px 10px", textAlign:"center" }}>
          <div style={{ color:T.gold, fontWeight:"900", fontSize:"1.1rem" }}>{phase.subjects.length}</div>
          <div style={{ color:"rgba(255,255,255,0.5)", fontSize:"0.58rem", textTransform:"uppercase" }}>subjects</div>
        </div>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:"6px" }}>
        {phase.subjects.map((s,i) => (
          <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", background:"rgba(255,255,255,0.07)", borderRadius:T.r8, padding:"7px 10px" }}>
            <span style={{ fontSize:"0.8rem", color:"rgba(255,255,255,0.88)" }}>{s.name}</span>
            <span style={{ fontSize:"0.68rem", color:T.gold, fontWeight:"700", whiteSpace:"nowrap", marginLeft:"8px" }}>{s.hoursPerWeek}h/wk</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop:"10px", fontSize:"0.68rem", color:"rgba(255,255,255,0.35)", textAlign:"center" }}>
        Source: CAPS Policy Statement · DBE South Africa
      </div>
    </div>
  );
}

// ─── SHARED MODULE CARD ───────────────────────────────────────
function ModCard({ mod, user, onNav, gradeLabel }) {
  const done = user.progress?.[mod.id];
  const gradeEntry = user.grades?.[mod.id];
  const g = gradeEntry ? RUBRIC.grade(gradeEntry.total) : null;
  return (
    <div style={{ ...css.card, cursor:"pointer", borderLeft:`4px solid ${mod.color}` }} onClick={() => onNav("lesson", mod.id)}>
      <div style={{ display:"flex", gap:"10px", alignItems:"flex-start" }}>
        <div style={{ width:"42px", height:"42px", borderRadius:T.r12, background:done?T.success:mod.color, display:"flex", alignItems:"center", justifyContent:"center", fontSize:"1.15rem", flexShrink:0 }}>
          {done?"✓":mod.icon}
        </div>
        <div style={{ flex:1 }}>
          <div style={{ display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:"4px", marginBottom:"3px" }}>
            <span style={{ fontSize:"0.62rem", color:T.ash, textTransform:"uppercase" }}>
              {mod.subject || `Week ${mod.week} · ${mod.track}`}
            </span>
            <div style={{ display:"flex", gap:"4px" }}>
              {gradeLabel && <span style={css.badge(T.board)}>{gradeLabel}</span>}
              <span style={css.badge(FORMAT_COLORS[mod.format]||mod.color)}>{mod.format?.replace("_"," ")}</span>
              {g && <span style={css.badge(g.color)}>{g.badge} {gradeEntry.total}%</span>}
            </div>
          </div>
          <div style={{ fontWeight:"700", fontSize:"0.88rem", color:T.ink }}>{mod.title}</div>
          <div style={{ fontSize:"0.73rem", color:T.ash, fontStyle:"italic", marginTop:"2px", lineHeight:1.4 }}>"{mod.orbPact}"</div>
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:"7px" }}>
            <span style={{ fontSize:"0.68rem", color:done?T.success:T.ember, fontWeight:"700" }}>{done?"✓ Complete — Review":"Tap to start"}</span>
            <span style={{ fontSize:"0.68rem", color:T.gold, fontWeight:"700" }}>+{mod.pts} pts{mod.pts>=20?` · +${Math.floor(mod.pts/10)} coins`:""}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── CURRICULUM ──────────────────────────────────────────────
function CurriculumScreen({ user, onNav }) {
  const isCaps = user?.curriculum === "caps";
  const userGrade = user?.grade;
  const capsGradeMods = CAPS_GRADE_MODS[userGrade] || [];
  const hasAuthoredCaps = capsGradeMods.length > 0;

  // Tab: "all" | "caps" | "core"
  const [tab, setTab] = useState(isCaps && hasAuthoredCaps ? "caps" : "core");

  // Progress counts
  const capsDone = capsGradeMods.filter(m => user.progress?.[m.id]).length;
  const coreDone = MODS.filter(m => user.progress?.[m.id]).length;

  const tabs = [
    ...(isCaps ? [{ id:"caps", label:`📗 CAPS${hasAuthoredCaps ? ` (${capsDone}/${capsGradeMods.length})` : ""}` }] : []),
    { id:"core", label:`📚 Core (${coreDone}/${MODS.length})` },
  ];

  return (
    <div style={{ paddingBottom:"100px" }}>

      {/* Tab bar */}
      {tabs.length > 1 && (
        <div style={{ display:"flex", background:T.white, borderBottom:`1px solid #EEE`, position:"sticky", top:"56px", zIndex:40 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ flex:1, padding:"11px 4px", background:"none", border:"none", borderBottom:tab===t.id?`3px solid ${T.board}`:"3px solid transparent", fontSize:"0.68rem", fontWeight:tab===t.id?"800":"400", color:tab===t.id?T.board:T.ash, cursor:"pointer" }}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div style={{ padding:"16px 20px" }}>

        {/* ── CAPS TAB ── */}
        {tab === "caps" && isCaps && (
          <>
            <CapsSubjectCard user={user} />

            {hasAuthoredCaps ? (
              <>
                <div style={{ fontFamily:T.display, fontSize:"0.95rem", color:T.board, fontWeight:"bold", marginBottom:"4px" }}>
                  Grade {userGrade} Modules — {CAPS_PHASES[userGrade]?.name}
                </div>
                <div style={{ fontSize:"0.72rem", color:T.ash, marginBottom:"12px" }}>
                  CAPS-aligned · {capsDone}/{capsGradeMods.length} complete
                </div>
                {capsGradeMods.map(mod => (
                  <ModCard key={mod.id} mod={mod} user={user} onNav={onNav} gradeLabel={`CAPS · Gr ${userGrade}`} />
                ))}
              </>
            ) : (
              /* Coming soon for Grades 4–12 */
              <div style={{ background:`${T.gold}12`, border:`1.5px dashed ${T.gold}`, borderRadius:T.r12, padding:"20px", marginBottom:"16px", textAlign:"center" }}>
                <div style={{ fontSize:"1.8rem", marginBottom:"8px" }}>🚧</div>
                <div style={{ fontWeight:"800", color:T.board, fontSize:"0.9rem", marginBottom:"6px" }}>
                  Grade {userGrade} CAPS Modules — Coming Soon
                </div>
                <div style={{ fontSize:"0.75rem", color:T.ash, lineHeight:1.7, marginBottom:"12px" }}>
                  {CAPS_PHASES[userGrade]?.name} content ({CAPS_PHASES[userGrade]?.grades}) is being authored now. Switch to the Core tab to keep learning while you wait.
                </div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:"6px", justifyContent:"center" }}>
                  {(CAPS_PHASES[userGrade]?.subjects||[]).map((s,i) => (
                    <span key={i} style={{ ...css.badge(T.ash), fontSize:"0.62rem" }}>{s.name}</span>
                  ))}
                </div>
                <button style={{ ...css.btn(T.board, T.white, "sm"), marginTop:"14px" }} onClick={() => setTab("core")}>
                  Go to Core Modules →
                </button>
              </div>
            )}
          </>
        )}

        {/* ── CORE TAB ── */}
        {tab === "core" && (
          <>
            <div style={{ fontFamily:T.display, fontSize:"0.95rem", color:T.board, fontWeight:"bold", marginBottom:"4px" }}>
              Core LIFE NPC Modules
            </div>
            <div style={{ fontSize:"0.72rem", color:T.ash, marginBottom:"12px" }}>
              7 formats · All curricula · {coreDone}/{MODS.length} complete
            </div>
            {MODS.map(mod => (
              <ModCard key={mod.id} mod={mod} user={user} onNav={onNav} />
            ))}
          </>
        )}

        {/* ── SINGLE TAB (non-CAPS users) ── */}
        {!isCaps && (
          <>
            <div style={{ fontFamily:T.display, fontSize:"0.95rem", color:T.board, fontWeight:"bold", marginBottom:"4px" }}>
              All Modules — 7 Formats
            </div>
            <div style={{ fontSize:"0.72rem", color:T.ash, marginBottom:"12px" }}>
              {coreDone}/{MODS.length} complete
            </div>
            {MODS.map(mod => (
              <ModCard key={mod.id} mod={mod} user={user} onNav={onNav} />
            ))}
          </>
        )}

      </div>
    </div>
  );
}

// ─── PORTFOLIO ───────────────────────────────────────────────
function PortfolioScreen({ user }) {
  const ev = user.evidence||[];
  const capsGradeMods = CAPS_GRADE_MODS[user?.grade] || [];
  const totalMods = MODS.length + capsGradeMods.length;
  const done = Object.keys(user.progress||{}).length;
  const pct = Math.round(done/totalMods*100);
  const grades = Object.values(user.grades||{});
  const avg = grades.length ? Math.round(grades.reduce((s,g)=>s+g.total,0)/grades.length) : 0;
  const g = RUBRIC.grade(avg);

  return (
    <div style={{ padding:"20px", paddingBottom:"100px" }}>
      {/* Growth Mirror header */}
      <div style={{ background:`linear-gradient(135deg, ${T.board}, ${T.mahogany})`, borderRadius:T.r16, padding:"22px", color:T.white, marginBottom:"14px" }}>
        <div style={{ fontSize:"0.62rem", color:T.gold, letterSpacing:"3px", textTransform:"uppercase", marginBottom:"6px" }}>Portfolio of Evidence</div>
        <div style={{ fontFamily:T.display, fontSize:"1.3rem", fontWeight:"bold" }}>{user.name}</div>
        <div style={{ fontSize:"0.78rem", opacity:0.7, marginBottom:"14px" }}>Grade {user.grade} · {user.track} Track · LIFE NPC × E.I.S.S</div>
        <div style={{ display:"flex", gap:"16px", marginBottom:"14px", fontSize:"0.78rem" }}>
          <span style={{ color:T.gold }}>⭐ {user.points||0} pts</span>
          <span style={{ color:T.gold }}>🪙 {user.coins||0} coins</span>
          <span style={{ color:T.gold }}>{g.badge} {g.label}</span>
        </div>
        <PBar pct={pct} color={T.gold} h={10} />
        <div style={{ display:"flex", justifyContent:"space-between", marginTop:"6px", fontSize:"0.72rem", color:"rgba(255,255,255,0.65)" }}>
          <span>{pct}% complete</span><span>Avg score: {avg}%</span>
        </div>
      </div>

      {ev.length===0 ? (
        <div style={{ ...css.card, textAlign:"center", padding:"40px 20px" }}>
          <div style={{ fontSize:"2.5rem", marginBottom:"10px" }}>📭</div>
          <div style={{ color:T.ash }}>Complete your first module to build your portfolio.</div>
        </div>
      ) : ev.map((e,i) => {
        const eg = RUBRIC.grade(e.score?.total||0);
        return (
          <div key={e.id||i} style={{ ...css.card, borderLeft:`4px solid ${eg.color}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"6px", flexWrap:"wrap", gap:"4px" }}>
              <span style={{ fontWeight:"700", fontSize:"0.88rem" }}>{e.moduleTitle}</span>
              <span style={css.badge(eg.color)}>{eg.badge} {eg.label} · {e.score?.total||0}%</span>
            </div>
            <div style={{ fontSize:"0.7rem", color:T.ash, marginBottom:"8px" }}>{new Date(e.uploadedAt).toLocaleDateString("en-ZA")}</div>
            <div style={{ fontSize:"0.82rem", color:T.ink, lineHeight:1.6, background:T.chalk, padding:"10px", borderRadius:T.r8 }}>
              {e.text?.substring(0,200)}{e.text?.length>200?"...":""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── MESSAGES (IM TOOL) ──────────────────────────────────────
function MessagesScreen({ user, onUpdate }) {
  const [text, setText] = useState("");
  const msgs = user.messages||[];
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior:"smooth" }); }, [msgs.length]);

  const send = () => {
    if (!text.trim()) return;
    const updated = DB.sendMsg(user.id, { from:"learner", text, name:user.name });
    onUpdate(updated);
    setText("");
    setTimeout(() => {
      const replies = [
        `${user.name}, thank you for reaching out. Your facilitator will respond within 24 hours. Keep learning! 🌟`,
        "Great question! That shows real curiosity. Stay with it — the answer will come.",
        "Received! Remember: every question is evidence of a growing mind. 📚",
        "Your learning is on track. The facilitator will give you detailed feedback soon.",
      ];
      const r = DB.sendMsg(user.id, { from:"facilitator", text:replies[Math.floor(Math.random()*replies.length)], name:"Facilitator" });
      onUpdate(r);
    }, 2000);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"calc(100vh - 70px)", background:T.chalk }}>
      <div style={{ padding:"14px 20px", background:T.white, borderBottom:`1px solid #EEE` }}>
        <div style={{ fontWeight:"700", color:T.board }}>💬 Message Your Facilitator</div>
        <div style={{ fontSize:"0.72rem", color:T.ash }}>IM Tool · Responses within 24 hours · Ubuntu-powered support</div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"16px 20px" }}>
        {msgs.length===0 && (
          <div style={{ textAlign:"center", padding:"40px 20px", color:T.ash }}>
            <div style={{ fontSize:"2rem", marginBottom:"8px" }}>👋</div>
            <div style={{ fontSize:"0.88rem" }}>Ask your facilitator anything about your learning journey. No question is too small.</div>
          </div>
        )}
        {msgs.map((m,i) => (
          <div key={m.id||i} style={{ display:"flex", justifyContent:m.from==="learner"?"flex-end":"flex-start", marginBottom:"12px" }}>
            <div style={{ maxWidth:"80%", background:m.from==="learner"?T.board:T.white, color:m.from==="learner"?T.white:T.ink, borderRadius:m.from==="learner"?`${T.r16} ${T.r16} 4px ${T.r16}`:`${T.r16} ${T.r16} ${T.r16} 4px`, padding:"10px 14px", boxShadow:T.shadow }}>
              <div style={{ fontSize:"0.65rem", color:m.from==="learner"?"rgba(255,255,255,0.55)":T.ash, marginBottom:"4px" }}>{m.name}</div>
              <div style={{ fontSize:"0.86rem", lineHeight:1.5 }}>{m.text}</div>
              <div style={{ fontSize:"0.6rem", color:m.from==="learner"?"rgba(255,255,255,0.45)":T.ash, marginTop:"4px", textAlign:"right" }}>{new Date(m.ts).toLocaleTimeString("en-ZA",{hour:"2-digit",minute:"2-digit"})}</div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div style={{ padding:"10px 16px", background:T.white, borderTop:`1px solid #EEE`, display:"flex", gap:"8px" }}>
        <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key==="Enter"&&send()} placeholder="Type your message..." style={{ ...css.input, marginBottom:0, flex:1 }} />
        <button style={{ ...css.btn(T.board, T.white), flexShrink:0 }} onClick={send}>Send</button>
      </div>
    </div>
  );
}

// ─── MONETIZATION SCREEN ─────────────────────────────────────
function MonetizeScreen({ user, onBack, onNav }) {
  const coins = user.coins||0;
  const streams = [
    { icon:"🪙", title:"Knowledge Coins", desc:`You have ${coins} coins. Earn 10+ to redeem for airtime or data vouchers.`, action:"Redeem Coins", available:coins>=10, color:T.gold },
    { icon:"🎓", title:"Earn as a Tutor", desc:"Complete all 6 modules and apply to become a paid peer tutor.", action:"Apply to Tutor", available:Object.keys(user.progress||{}).length>=4, color:T.sage },
    { icon:"📦", title:"Sell Your Work", desc:"Your portfolio evidence can be packaged and sold on Gumroad or Teachers Pay Teachers.", action:"Start Selling", available:Object.keys(user.progress||{}).length>=6, color:T.cobalt },
    { icon:"💼", title:"Corporate Connections", desc:"LIFE NPC connects high-scoring learners with CSI partner companies.", action:"View Opportunities", available:(user.grades?Object.values(user.grades).reduce((s,g)=>s+g.total,0)/Math.max(Object.values(user.grades).length,1):0)>=70, color:T.mahogany },
  ];

  return (
    <div style={{ minHeight:"100vh", background:T.chalk, paddingBottom:"80px" }}>
      <div style={{ background:`linear-gradient(135deg, ${T.terracotta}, ${T.mahogany})`, padding:"18px 20px 24px" }}>
        <button onClick={onBack} style={{ background:"rgba(255,255,255,0.15)", border:"none", color:T.white, padding:"6px 14px", borderRadius:T.rFull, cursor:"pointer", fontSize:"0.8rem", marginBottom:"12px" }}>← Back</button>
        <div style={{ fontFamily:T.display, fontSize:"1.3rem", color:T.white, fontWeight:"bold" }}>💰 Learn to Earn</div>
        <div style={{ fontSize:"0.78rem", color:"rgba(255,255,255,0.7)", marginTop:"4px" }}>Your learning has real-world value. Here's how to unlock it.</div>
      </div>
      <div style={{ padding:"20px" }}>
        <div style={{ background:T.gold, borderRadius:T.r12, padding:"16px", textAlign:"center", marginBottom:"16px" }}>
          <div style={{ fontFamily:T.display, fontSize:"2rem", fontWeight:"bold", color:T.ink }}>🪙 {coins}</div>
          <div style={{ color:T.ink, fontWeight:"700", fontSize:"0.85rem" }}>Knowledge Coins Available</div>
          <div style={{ fontSize:"0.75rem", color:"rgba(0,0,0,0.5)", marginTop:"4px" }}>10 coins ≈ 1 mobile airtime/data voucher</div>
        </div>

        <div style={{ ...css.card }}>
          <div style={{ fontWeight:"700", color:T.board, marginBottom:"10px" }}>🪙 Coin Redemption & Affiliate Breakdown</div>
          {[
            { tier:"Earning", rule:"1 coin per 10% rubric score on evidence · +1–2 coins per Memory Check review" },
            { tier:"Redeem — Airtime/Data", rule:"10 coins → 1 voucher (~R10 equivalent), fulfilled via airtime affiliate API (e.g. Flash/Vodapay-style network)" },
            { tier:"Redeem — Marketplace credit", rule:"50 coins → discount code toward LIFE NPC merchandise or partner courses" },
            { tier:"Affiliate qualification", rule:"A reward partner must: (1) pay LIFE NPC a referral fee per redemption, (2) honour vouchers within 48h, (3) pass a fraud/compliance check, (4) serve the learner's region" },
            { tier:"Revenue model", rule:"LIFE NPC buys vouchers wholesale below face value from the affiliate; the margin funds the coin pool — coins are a cost centre, not free money" },
          ].map((r,i) => (
            <div key={i} style={{ marginBottom:"8px", paddingBottom:"8px", borderBottom:i<4?"1px solid #EEE":"none" }}>
              <div style={{ fontWeight:"700", fontSize:"0.78rem", color:T.terracotta }}>{r.tier}</div>
              <div style={{ fontSize:"0.76rem", color:T.ash, lineHeight:1.5 }}>{r.rule}</div>
            </div>
          ))}
        </div>
        {streams.map((s,i) => (
          <div key={i} style={{ ...css.card, borderTop:`4px solid ${s.color}`, opacity:s.available?1:0.6 }}>
            <div style={{ display:"flex", gap:"12px", alignItems:"flex-start", marginBottom:"10px" }}>
              <span style={{ fontSize:"1.5rem" }}>{s.icon}</span>
              <div>
                <div style={{ fontWeight:"700", color:T.ink }}>{s.title}</div>
                <div style={{ fontSize:"0.8rem", color:T.ash, lineHeight:1.5, marginTop:"3px" }}>{s.desc}</div>
              </div>
            </div>
            <button style={{ ...css.btn(s.available?s.color:T.ash, T.white, "sm"), opacity:s.available?1:0.7 }} disabled={!s.available}>
              {s.available?s.action:"Complete more modules to unlock"}
            </button>
          </div>
        ))}

        <div style={{ fontFamily:T.display, fontSize:"1rem", color:T.board, fontWeight:"bold", margin:"18px 0 10px" }}>🧑‍🏫 Human-Assisted Support</div>
        <div style={{ fontSize:"0.78rem", color:T.ash, marginBottom:"10px" }}>Beyond the self-serve app: real people who help when a module isn't enough.</div>
        {SERVICES.map(s => (
          <div key={s.id} style={{ ...css.card, borderLeft:`4px solid ${T.cobalt}` }}>
            <div style={{ display:"flex", gap:"12px", alignItems:"flex-start", marginBottom:"8px" }}>
              <span style={{ fontSize:"1.4rem" }}>{s.icon}</span>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:"700", color:T.ink }}>{s.title}</div>
                <div style={{ fontSize:"0.8rem", color:T.ash, lineHeight:1.5, marginTop:"3px" }}>{s.desc}</div>
                <div style={{ fontSize:"0.7rem", color:T.cobalt, marginTop:"5px", fontWeight:"700" }}>{s.cadence}</div>
              </div>
            </div>
            <button style={{ ...css.btn(T.cobalt, T.white, "sm") }} onClick={() => onNav && onNav("messages")}>Request via Facilitator Chat</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── ADMIN ───────────────────────────────────────────────────
function AdminScreen({ onBack }) {
  const [pin, setPin] = useState("");
  const [auth, setAuth] = useState(false);
  const [users, setUsers] = useState([]);
  const [tab, setTab] = useState("overview");

  if (!auth) return (
    <div style={{ minHeight:"100vh", background:T.ink, display:"flex", alignItems:"center", justifyContent:"center", padding:"20px" }}>
      <div style={{ background:T.white, borderRadius:T.r24, padding:"30px 26px", width:"100%", maxWidth:"340px" }}>
        <button onClick={onBack} style={{ background:"none", border:"none", cursor:"pointer", color:T.board, fontWeight:"700", marginBottom:"14px" }}>← Exit</button>
        <div style={{ fontFamily:T.display, fontSize:"1.2rem", color:T.board, fontWeight:"bold", marginBottom:"4px" }}>E.I.S.S Admin</div>
        <div style={{ fontSize:"0.78rem", color:T.ash, marginBottom:"20px" }}>LIFE NPC Operations Dashboard</div>
        <label style={css.label}>Admin PIN</label>
        <input style={css.input} type="password" maxLength={4} placeholder="••••" value={pin} onChange={e => setPin(e.target.value)} onKeyDown={e => e.key==="Enter"&&(pin==="9517"?(setAuth(true),setUsers(DB.getAllUsers())):alert("Incorrect PIN"))} />
        <button style={{ ...css.btn(T.board, T.white, "lg"), width:"100%" }} onClick={() => pin==="9517"?(setAuth(true),setUsers(DB.getAllUsers())):alert("Incorrect PIN")}>Enter Admin</button>
      </div>
    </div>
  );

  const totalPts = users.reduce((s,u)=>s+(u.points||0),0);
  const totalEv = users.reduce((s,u)=>s+(u.evidence||[]).length,0);
  const totalCoins = users.reduce((s,u)=>s+(u.coins||0),0);

  return (
    <div style={{ minHeight:"100vh", background:T.ink, paddingBottom:"40px" }}>
      <div style={{ background:"#111", padding:"16px 20px", display:"flex", alignItems:"center", gap:"10px" }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:T.chalk, cursor:"pointer" }}>←</button>
        <div>
          <div style={{ color:T.gold, fontFamily:T.display, fontWeight:"bold" }}>E.I.S.S Admin — LIFE NPC</div>
          <div style={{ color:"rgba(255,255,255,0.35)", fontSize:"0.68rem" }}>EduCreat'Us Infrastructure & Systems Solutions</div>
        </div>
      </div>
      <div style={{ display:"flex", background:"#111", borderBottom:"1px solid rgba(255,255,255,0.08)" }}>
        {["overview","learners","system"].map(t => (
          <button key={t} onClick={()=>setTab(t)} style={{ flex:1, padding:"11px 4px", background:"none", border:"none", borderBottom:tab===t?`2px solid ${T.gold}`:"2px solid transparent", color:tab===t?T.gold:"rgba(255,255,255,0.35)", fontSize:"0.72rem", fontWeight:tab===t?"700":"400", cursor:"pointer" }}>
            {t.charAt(0).toUpperCase()+t.slice(1)}
          </button>
        ))}
      </div>
      <div style={{ padding:"20px" }}>
        {tab==="overview" && <>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px" }}>
            {[
              {icon:"👤",val:users.length,label:"Learners"},
              {icon:"⭐",val:totalPts,label:"Points Earned"},
              {icon:"🪙",val:totalCoins,label:"Coins Earned"},
              {icon:"📁",val:totalEv,label:"Evidence Files"},
              {icon:"📊",val:users.length?Math.round(users.reduce((s,u)=>s+(Object.keys(u.progress||{}).length/MODS.length*100),0)/users.length)+"%":"0%",label:"Avg Completion"},
              {icon:"💬",val:users.reduce((s,u)=>s+(u.messages||[]).length,0),label:"Messages"},
            ].map(s => (
              <div key={s.label} style={{ background:"#1A1A1A", borderRadius:T.r12, padding:"16px", textAlign:"center" }}>
                <div style={{ fontSize:"1.3rem" }}>{s.icon}</div>
                <div style={{ fontWeight:"800", fontSize:"1rem", color:T.gold }}>{s.val}</div>
                <div style={{ fontSize:"0.65rem", color:"rgba(255,255,255,0.35)", textTransform:"uppercase" }}>{s.label}</div>
              </div>
            ))}
          </div>
        </>}
        {tab==="learners" && <>
          {users.length===0 ? (
            <div style={{ background:"#1A1A1A", borderRadius:T.r12, padding:"30px", textAlign:"center", color:"rgba(255,255,255,0.3)" }}>No learners registered yet.</div>
          ) : users.map(u => {
            const uGrades = Object.values(u.grades||{});
            const uAvg = uGrades.length ? Math.round(uGrades.reduce((s,g)=>s+g.total,0)/uGrades.length) : 0;
            const ug = RUBRIC.grade(uAvg);
            return (
              <div key={u.id} style={{ background:"#1A1A1A", borderRadius:T.r12, padding:"14px 16px", marginBottom:"10px" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"5px" }}>
                  <span style={{ fontWeight:"700", color:T.chalk }}>{u.name}</span>
                  <span style={css.badge(T.board)}>{u.track}</span>
                </div>
                <div style={{ fontSize:"0.72rem", color:"rgba(255,255,255,0.4)", marginBottom:"8px" }}>{u.email} · Grade {u.grade}</div>
                <div style={{ display:"flex", gap:"10px", fontSize:"0.72rem", color:T.gold, flexWrap:"wrap", marginBottom:"8px" }}>
                  <span>⭐ {u.points||0} pts</span>
                  <span>🪙 {u.coins||0} coins</span>
                  <span>📁 {(u.evidence||[]).length} files</span>
                  <span>{ug.badge} {ug.label} · {uAvg}%</span>
                </div>
                <PBar pct={Math.round(Object.keys(u.progress||{}).length/MODS.length*100)} color={T.gold} h={6} />
              </div>
            );
          })}
        </>}
        {tab==="system" && <>
          {[
            {icon:"🔒",label:"Security",status:"Active",detail:"Supabase Auth + POPIA compliant (localStorage for prototype)",color:T.success},
            {icon:"🔄",label:"Auto-Updates",status:"Ready",detail:"GitHub CI/CD → Vercel auto-deploy on every push",color:T.sky},
            {icon:"🐛",label:"Bug Tracker",status:"Clean",detail:"0 errors detected · Sentry.io integration in Phase 2",color:T.success},
            {icon:"📈",label:"SEO Engine",status:"Pending",detail:"Next.js SSR → Google indexable · JSON-LD schema in Phase 2",color:T.gold},
            {icon:"⚡",label:"Performance",status:"Fast",detail:"Vercel CDN · Cloudflare cache · < 1s load time",color:T.success},
            {icon:"📊",label:"Analytics",status:"Basic",detail:"localStorage analytics · Supabase Analytics in Phase 2",color:T.ash},
            {icon:"🌐",label:"Scaling",status:"Auto",detail:"Vercel auto-scales to 10,000 users · Upgrade path ready",color:T.success},
            {icon:"🤖",label:"AI Profiler",status:"Active",detail:"10-dimension learner profiler running · Supabase sync in Phase 2",color:T.cobalt},
          ].map(s => (
            <div key={s.label} style={{ background:"#1A1A1A", borderRadius:T.r12, padding:"12px 16px", marginBottom:"8px", display:"flex", gap:"12px", alignItems:"flex-start" }}>
              <span style={{ fontSize:"1.2rem", flexShrink:0 }}>{s.icon}</span>
              <div style={{ flex:1 }}>
                <div style={{ display:"flex", justifyContent:"space-between" }}>
                  <span style={{ color:T.chalk, fontWeight:"700", fontSize:"0.85rem" }}>{s.label}</span>
                  <span style={css.badge(s.color)}>{s.status}</span>
                </div>
                <div style={{ color:"rgba(255,255,255,0.45)", fontSize:"0.75rem", marginTop:"4px", lineHeight:1.5 }}>{s.detail}</div>
              </div>
            </div>
          ))}
        </>}
      </div>
    </div>
  );
}

// ─── NAV ─────────────────────────────────────────────────────
function NavBar({ screen, onNav, msgCount }) {
  return (
    <div style={{ position:"fixed", bottom:0, left:0, right:0, background:T.board, display:"flex", justifyContent:"space-around", padding:"10px 0 16px", zIndex:100, borderTop:"1px solid rgba(255,255,255,0.06)" }}>
      {[
        {id:"dashboard",icon:"🏠",label:"Home"},
        {id:"curriculum",icon:"📚",label:"Learn"},
        {id:"portfolio",icon:"📁",label:"Portfolio"},
        {id:"messages",icon:"💬",label:"Messages",badge:msgCount},
        {id:"admin",icon:"⚙️",label:"Admin"},
      ].map(item => (
        <button key={item.id} onClick={()=>onNav(item.id)} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:"2px", color:screen===item.id?T.gold:"rgba(255,255,255,0.38)", fontSize:"0.58rem", fontWeight:screen===item.id?"800":"400", cursor:"pointer", border:"none", background:"none", position:"relative" }}>
          <span style={{ fontSize:"1.2rem" }}>{item.icon}</span>
          <span>{item.label}</span>
          {item.badge>0 && <span style={{ position:"absolute", top:-2, right:0, background:T.danger, color:T.white, borderRadius:T.rFull, width:"13px", height:"13px", fontSize:"0.58rem", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:"800" }}>{item.badge}</span>}
        </button>
      ))}
    </div>
  );
}

// ─── ROOT ────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("auth");
  const [user, setUser] = useState(null);
  const [lessonId, setLessonId] = useState(null);
  const [toast, setToast] = useState({ msg:"", type:"success" });

  useEffect(() => {
    const s = localStorage.getItem("lifev3_session");
    if (s) {
      try {
        const { email, pin } = JSON.parse(s);
        const u = DB.getUser(email, pin);
        if (u) { setUser(u); setScreen("dashboard"); }
      } catch {}
    }
  }, []);

  const showToast = (msg, type="success") => { setToast({msg,type}); setTimeout(()=>setToast({msg:"",type:"success"}),3000); };

  const handleAuth = (u) => {
    setUser(u);
    localStorage.setItem("lifev3_session", JSON.stringify({ email:u.email, pin:u.pin }));
    setScreen("dashboard");
    showToast(`Welcome to LIFE NPC, ${u.name}! 🌟`);
  };

  const handleLogout = () => {
    localStorage.removeItem("lifev3_session");
    setUser(null);
    setScreen("auth");
  };

  const nav = (s, id=null) => {
    if (s==="lesson"&&id) setLessonId(id);
    setScreen(s);
  };

  const updateUser = (u) => setUser(u);

  const handleComplete = (u) => {
    setUser(u);
    showToast("🎉 Module complete! Portfolio & AI profile updated.");
    setScreen("curriculum");
  };

  const unread = user ? (user.messages||[]).filter(m=>m.from==="facilitator").length : 0;

  if (screen==="auth") return <><Toast {...toast}/><AuthScreen onAuth={handleAuth}/></>;
  if (screen==="admin") return <AdminScreen onBack={()=>setScreen("dashboard")}/>;
  if (screen==="monetize") return <MonetizeScreen user={user} onBack={()=>setScreen("dashboard")} onNav={nav}/>;
  if (screen==="lesson"&&lessonId) return <>
    <Toast {...toast}/>
    <LessonScreen user={user} modId={lessonId} onComplete={handleComplete} onBack={()=>setScreen("curriculum")}/>
  </>;

  return (
    <div style={{ background:T.chalk, minHeight:"100vh", fontFamily:T.body }}>
      <Toast {...toast}/>
      <div style={{ background:T.board, padding:"12px 20px", display:"flex", justifyContent:"space-between", alignItems:"center", position:"sticky", top:0, zIndex:50 }}>
        <div>
          <div style={{ fontFamily:T.display, fontSize:"1rem", fontWeight:"bold", background:`linear-gradient(90deg,${T.gold},${T.sunGold})`, WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", letterSpacing:"1px" }}>LIFE NPC</div>
          <div style={{ fontSize:"0.52rem", color:"rgba(255,255,255,0.35)", letterSpacing:"3px", textTransform:"uppercase" }}>KNOW · LED · EDGE · NOW</div>
        </div>
        <div style={{ display:"flex", gap:"6px" }}>
          <button onClick={handleLogout} style={css.btn("rgba(255,255,255,0.08)","rgba(255,255,255,0.55)","sm")}>Out</button>
        </div>
      </div>
      <div style={{ paddingBottom:"80px" }}>
        {screen==="dashboard" && <Dashboard user={user} onNav={nav} onUpdate={updateUser}/>}
        {screen==="curriculum" && <CurriculumScreen user={user} onNav={nav}/>}
        {screen==="portfolio" && <PortfolioScreen user={user}/>}
        {screen==="messages" && <MessagesScreen user={user} onUpdate={updateUser}/>}
      </div>
      <NavBar screen={screen} onNav={nav} msgCount={unread}/>
    </div>
  );
}
