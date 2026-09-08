/* =========================================================
   DRONE HANDS · Módulo principal del prototipo IoT
   Control gestual estilo dron con MediaPipe Hand Landmarker
   ========================================================= */
import { HandController } from "./gestures.js";
import { World } from "./world.js";

const $ = (sel) => document.querySelector(sel);
const clamp = (v, a, b) => (v < a ? a : v > b ? v > b ? b : v : a);
const lerp = (a, b, t) => a + (b - a) * t;

const BEST_KEY = "dronehands_best_v1";

/* ---------------- Audio (WebAudio, sin ficheros) ---------------- */
class Sfx {
  constructor() { this.ctx = null; this.muted = false; this.droneOsc = null; this.droneGain = null; }
  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
  }
  resume() { this.ensure(); this.ctx?.resume?.(); }
  startDrone() {
    this.resume();
    if (!this.ctx || this.droneOsc) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "sawtooth";
    o.frequency.value = 70;
    g.gain.value = 0.0;
    o.connect(g); g.connect(this.ctx.destination);
    o.start();
    this.droneOsc = o; this.droneGain = g;
  }
  setDrone(level, freq) {
    if (!this.droneOsc || this.muted) return;
    const t = this.ctx.currentTime;
    this.droneGain.gain.setTargetAtTime(this.muted ? 0 : clamp(level, 0, 1) * 0.05, t, .1);
    this.droneOsc.frequency.setTargetAtTime(clamp(freq, 40, 180), t, .15);
  }
  stopDrone() {
    if (!this.droneOsc) return;
    try { this.droneGain.gain.setTargetAtTime(0, this.ctx.currentTime, .1); this.droneOsc.stop(this.ctx.currentTime + .5); } catch (_) {}
    this.droneOsc = null; this.droneGain = null;
  }
  blip(f1 = 620, f2 = 880, dur = .12, type = "square", vol = .12) {
    this.resume();
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f1, t);
    o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t); o.stop(t + dur + .02);
  }
  crash() {
    this.resume();
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * .4, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    g.gain.value = .3;
    src.buffer = buf;
    src.connect(g); g.connect(this.ctx.destination);
    src.start(t);
  }
  setMuted(m) { this.muted = m; if (m) { if (this.droneGain && this.ctx) this.droneGain.gain.setTargetAtTime(0, this.ctx.currentTime, .05); } }
}

/* ---------------- Estados ---------------- */
const S = { LOADING: "loading", START: "start", ERROR: "error", CALIB: "calib", PLAY: "play", PAUSE: "pause", HANDS_LOST: "handslost", GAMEOVER: "gameover" };
const DIFF = { easy: { base: 130, accel: .55, spread: 130 }, normal: { base: 165, accel: .75, spread: 110 }, hard: { base: 200, accel: 1.0, spread: 95 } };
const KEY = { left: false, right: false, up: false, down: false, space: false };

const app = {
  state: S.LOADING,
  diff: "normal",
  keyboardMode: false,
  keyboardOnly: false,
  score: 0,
  gates: 0,
  lives: 3,
  combo: 1,
  comboTimer: 0,
  best: Number(localStorage.getItem(BEST_KEY) || 0),
  invuln: 0,
  time: 0,
  countT: 0,
  handsSeenT: 0,
  pinchHold: 0
};

const drone = { x: 0, y: 0, vx: 0, vy: 0, alt: 0, spd: 0, tilt: 0, turbo: 0, alive: true, rot: 0 };

const sfx = new Sfx();
const hands = new HandController();
const world = new World($("#game"));

let video = null;
let camOverlay = null;
let camCtx = null;
let fps = { n: 0, t: performance.now(), v: 0 };

/* =========================================================
   Utilidades de UI
   ========================================================= */
function showPanel(id) {
  for (const el of document.querySelectorAll(".panel")) el.classList.add("hidden");
  if (id) $(id)?.classList.remove("hidden");
  $("#screen").style.pointerEvents = id ? "auto" : "none";
}
function setGameState(s) {
  app.state = s;
  const hudOn = [S.PLAY, S.CALIB, S.PAUSE, S.HANDS_LOST].includes(s);
  $("#hud").classList.toggle("hidden", !hudOn);
  $("#gesture-panel").classList.toggle("hidden", !(hudOn && !app.keyboardOnly));
  $("#cam-wrap").classList.toggle("hidden", !(hudOn && !app.keyboardOnly));
  if (s === S.START) showPanel("#scr-start");
  else if (s === S.LOADING) showPanel("#scr-loading");
  else if (s === S.ERROR) showPanel("#scr-error");
  else if (s === S.PAUSE) showPanel("#scr-pause");
  else if (s === S.HANDS_LOST) showPanel("#scr-handslost");
  else if (s === S.GAMEOVER) showPanel("#scr-gameover");
  else showPanel(null);
}
function setStatus(t) { $("#load-status").textContent = t; }

let announceTimer = 0;
function announce(text, cls, dur) {
  const el = $("#announce");
  el.textContent = text;
  el.className = "announce show " + (cls || "");
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { el.className = "announce"; }, dur || 1200);
}

function updateHud() {
  $("#hud-score").textContent = app.score;
  $("#hud-best").textContent = app.best;
  const kmh = Math.round(60 + drone.spd * 2.4 + drone.turbo * 160);
  $("#hud-speed").textContent = kmh + " km/h";
  $("#hud-speed-bar").style.width = (clamp((drone.spd - 40) / 520, 0, 1) * 100) + "%";
  const altPct = clamp(1 - drone.y / Math.max(1, world.H), 0, 1);
  $("#hud-alt").textContent = Math.round(altPct * 400) + " m";
  $("#hud-alt-bar").style.height = (altPct * 100) + "%";
  if (!app.recordHit && app.best > 0 && app.score > app.best) {
    app.recordHit = true;
    announce("🏆 ¡NUEVO RÉCORD!", "record", 1800);
    $("#hud-score").classList.add("flash-record");
  }
  const comboEl = $("#hud-combo");
  if (app.combo > 1) {
    comboEl.classList.remove("hidden");
    $("#hud-combo-text").textContent = "x" + app.combo;
    $("#hud-combo-bar").style.width = clamp(app.comboTimer / 4, 0, 1) * 100 + "%";
  } else comboEl.classList.add("hidden");
  const segs = document.querySelectorAll("#hud-hull .seg");
  for (let i = 0; i < segs.length; i++) segs[i].classList.toggle("lost", i >= app.lives);
  document.getElementById("hud-hull").classList.toggle("low", app.lives === 1);
}

function updateGesturePanel() {
  if (app.keyboardOnly) return;
  const L = hands.left, R = hands.right;
  $("#g-left-bar").style.height = (50 - clamp(L.alt, -1, 1) * 48) + "%";
  $("#g-left-status").textContent = L.present ? (L.fist > .5 ? "puño · hover" : "alt " + L.alt.toFixed(2)) : "sin mano";
  $("#g-left").classList.toggle("active", L.present);
  $("#g-right-bar").style.width = (50 + clamp(R.dir, -1, 1) * 48) + "%";
  $("#g-right-status").textContent = R.present ? (R.pinch > .5 ? "TURBO " + R.dir.toFixed(2) : "dir " + R.dir.toFixed(2)) : "sin mano";
  $("#g-right").classList.toggle("active", R.present);
  $("#g-fps").textContent = Math.round(fps.v) + " fps · " + hands.backend;
  const nHands = (L.present ? 1 : 0) + (R.present ? 1 : 0);
  $("#g-hands").textContent = nHands + "/2 manos";
  const wrap = document.getElementById("cam-wrap");
  wrap.classList.toggle("hands-0", nHands === 0);
  wrap.classList.toggle("hands-1", nHands === 1);
  wrap.classList.toggle("hands-2", nHands === 2);
  document.getElementById("cam-check").textContent = nHands === 2 ? "✓ 2/2 manos" : (nHands === 1 ? "1/2 mano" : "0/2 manos");
}
/* =========================================================
   Flujos de partida
   ========================================================= */
function resetRun() {
  app.score = 0;
  app.gates = 0;
  app.lives = 3;
  app.combo = 1;
  app.comboTimer = 0;
  app.invuln = 1.2;
  app.countT = 3.2;
  app.pinchHold = 0;
  app.recordHit = false;
  app.lastTurbo = false;
  app.lastCount = 0;
  $("#hud-score").classList.remove("flash-record");
  $("#go-retry-fill").style.width = "0%";
  drone.x = Math.max(170, world.W * 0.24);
  drone.y = world.H / 2;
  drone.vx = 0;
  drone.vy = 0;
  drone.spd = 0;
  drone.alt = 0;
  drone.tilt = 0;
  drone.turbo = 0;
  drone.rot = 0;
  drone.alive = true;
  world.reset();
  updateHud();
}

function startCalibration() {
  sfx.resume();
  sfx.startDrone();
  hands.clearAltCenter();
  resetRun();
  setGameState(S.CALIB);
}

function finishCalibration() {
  hands.captureAltCenter();
  setGameState(S.PLAY);
  sfx.blip(440, 990, .25);
}

function loseLife(reason) {
  if (app.invuln > 0) return;
  app.lives--;
  app.combo = 1;
  sfx.crash();
  world.burst(drone.x, drone.y, "#ff4d6d", 30, 5);
  announce("💥 ¡IMPACTO!", "danger", 900);
  updateHud();
  app.invuln = 1.4;
  if (app.lives <= 0) gameOver();
}

function gameOver() {
  drone.alive = false;
  sfx.stopDrone();
  world.burst(drone.x, drone.y, "#ffd166", 46, 6);
  app.pinchHold = 0;
  const isNew = app.score > app.best;
  if (isNew) { app.best = app.score; localStorage.setItem(BEST_KEY, String(app.best)); }
  const goTarget = app.score; const goEl = $("#go-score"); const goT0 = performance.now();
  const goTick = () => { const p = Math.min(1, (performance.now() - goT0) / 1200); goEl.textContent = Math.round(goTarget * p * (2 - p)); if (p < 1) requestAnimationFrame(goTick); };
  goTick();
  $("#go-gates").textContent = app.gates;
  $("#go-best").textContent = app.best;
  $("#go-newbest").classList.toggle("hidden", !isNew);
  setGameState(S.GAMEOVER);
}

/* =========================================================
   Control del dron (gestos o teclado)
   ========================================================= */
function readControls(dt) {
  const d = DIFF[app.diff] || DIFF.normal;
  let alt = 0, dir = 0, side = 0, turbo = 0, hover = 0;

  if (app.keyboardOnly || app.keyboardMode) {
    alt = (KEY.down ? 1 : 0) - (KEY.up ? 1 : 0);
    dir = (KEY.right ? 1 : 0) - (KEY.left ? 1 : 0);
    side = 0;
    turbo = KEY.space ? 1 : 0;
    hover = 0;
  } else {
    const L = hands.left, R = hands.right;
    /* Mano izquierda -> altitud (Y de la muñeca, relativa al centro capturado) */
    if (L.present) {
      if (L.fist > 0.5) hover = 1;
      else {
        const c = hands.altCenter ?? 0;
        const span = 0.38;
        alt = clamp((L.altRaw - c) / span, -1, 1);
        if (Math.abs(alt) < 0.06) alt = 0;
      }
    }
    /* Mano derecha -> dirección (ángulo muñeca->índice) + palma lateral */
    if (R.present) {
      dir = R.dir;
      side = R.side * 0.8;
      if (Math.abs(dir) < 0.05) dir = 0;
      if (Math.abs(side) < 0.05) side = 0;
      turbo = R.pinch > 0.55 ? 1 : 0;
    }
  }

  /* Física vertical */
  if (hover) {
    drone.vy *= Math.pow(0.001, dt);
  } else {
    drone.vy += alt * d.accel * 520 * dt;
  }
  drone.vy *= Math.pow(0.35, dt);
  drone.alt = lerp(drone.alt, alt, 1 - Math.pow(0.02, dt));

  /* Física horizontal: velocidad de crucero + aceleración por pitch */
  const target = d.base + Math.max(0, dir) * d.base * 1.1 + drone.turbo * 240 - Math.max(0, -dir) * d.base * .55;
  drone.spd = lerp(drone.spd, target, 1 - Math.pow(0.15, dt));
  drone.spd = clamp(drone.spd, 40, 560);
  drone.vx = side * 220;
  drone.x = clamp(drone.x + (drone.vx + Math.max(0, dir) * 40) * dt, world.W * 0.1, world.W * 0.55);

  /* Turbo */
  const wasTurbo = drone.turbo > 0.5;
  drone.turbo = lerp(drone.turbo, turbo, 1 - Math.pow(0.05, dt));
  if (drone.turbo > 0.5 && !wasTurbo && app.state === S.PLAY) announce("⚡ TURBO ×2", "turbo", 900);
  drone.tilt = lerp(drone.tilt, (Math.abs(dir) > Math.abs(side) ? dir : side), 1 - Math.pow(0.05, dt));
  drone.rot = clamp(-drone.alt * .5 + -drone.tilt * .35, -.6, .6);

  /* Altura por teclado/gestos */
  drone.y += drone.vy * dt;
  const margin = 30;
  if (drone.y < margin) { drone.y = margin; drone.vy = Math.max(0, drone.vy); }
  if (drone.y > world.H - margin) { drone.y = world.H - margin; drone.vy = Math.min(0, drone.vy); }

  /* Audio del dron */
  sfx.setDrone(.4 + drone.turbo * .6 + Math.abs(drone.alt) * .25, 70 + drone.spd * .16 + Math.abs(drone.alt) * 22);
}

function scoring(dt) {
  for (const g of world.gates) {
    if (g.passed && !g.scored) {
      g.scored = true;
      if (g.hitDrone) {
        app.combo = 1;
      } else {
        app.gates++;
        const base = 10 * app.combo * (drone.turbo > 0.5 ? 2 : 1);
        app.score += base;
        app.combo = Math.min(5, app.combo + 1);
        app.comboTimer = 4;
        if (app.combo >= 2) announce("¡COMBO x" + app.combo + "!", "", 900);
        sfx.blip(520 + app.combo * 60, 980, .1);
        world.burst(g.x, g.gapY, "#00e5ff", 14, 3);
        world.setDifficulty(app.score / 600);
      }
    }
    if (g.hitDrone && !g.penaltyDone) {
      g.penaltyDone = true;
      loseLife("gate");
    }
  }
  for (const c of world.chips) {
    if (c.taken && !c.scored) {
      c.scored = true;
      app.score += 5 * (drone.turbo > 0.5 ? 2 : 1);
      sfx.blip(760, 1200, .08, "sine", .1);
      world.burst(c.x, c.y, "#3ddc84", 10, 2.5);
    }
  }
  for (const r of world.rings) {
    if (r.passed && !r.scored) {
      r.scored = true;
      if (r.hitDrone) {
        app.score += 15 * (drone.turbo > 0.5 ? 2 : 1);
        sfx.blip(880, 1400, .12, "sine", .12);
        world.burst(r.x, r.y, "#ffd166", 16, 3);
      }
    }
  }
  if (app.combo > 1) {
    app.comboTimer -= dt;
    if (app.comboTimer <= 0) app.combo = 1;
  }
}

/* =========================================================
   Renderizado del dron y pantalla
   ========================================================= */
function drawDrone(ctx) {
  if (!drone.alive) return;
  const blink = app.invuln > 0 && Math.floor(app.time * 12) % 2 === 0;
  if (blink) return;

  ctx.save();
  ctx.translate(drone.x, drone.y);
  ctx.rotate(drone.rot);

  /* Estela del turbo */
  if (drone.turbo > 0.05) {
    ctx.globalAlpha = drone.turbo * .8;
    const fl = 22 + Math.sin(app.time * 40) * 6;
    const grad = ctx.createLinearGradient(-16, 0, -16 - fl, 0);
    grad.addColorStop(0, "#ff9f1c");
    grad.addColorStop(1, "rgba(255, 159, 28, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-14, -5);
    ctx.lineTo(-16 - fl, 0);
    ctx.lineTo(-14, 5);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* Hélices */
  ctx.strokeStyle = "rgba(223, 233, 255, .85)";
  ctx.lineWidth = 2;
  const blade = Math.sin(app.time * 46) * 7;
  for (const [px, py] of [[-11, -9], [11, -9], [-11, 9], [11, 9]]) {
    ctx.beginPath();
    ctx.moveTo(px - blade, py);
    ctx.lineTo(px + blade, py);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px, py - blade * .4);
    ctx.lineTo(px, py + blade * .4);
    ctx.stroke();
  }

  /* Fuselaje */
  ctx.shadowColor = "#00e5ff";
  ctx.shadowBlur = 18;
  const body = ctx.createLinearGradient(0, -10, 0, 10);
  body.addColorStop(0, "#dff9ff");
  body.addColorStop(.5, "#00b4d8");
  body.addColorStop(1, "#0077b6");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(0, 0, 16, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  /* Cabina */
  ctx.fillStyle = "rgba(255, 255, 255, .9)";
  ctx.beginPath();
  ctx.ellipse(6, -2, 5, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  /* Brazos + patas */
  ctx.strokeStyle = "#dff9ff";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(-11, -9); ctx.lineTo(11, -9);
  ctx.moveTo(-11, 9); ctx.lineTo(11, 9);
  ctx.moveTo(0, 8); ctx.lineTo(0, 12);
  ctx.stroke();
  ctx.restore();
}

function drawScreen(ctx) {
  world.draw();
  drawDrone(ctx);

  /* Cuenta atrás con calibración */
  if (app.state === S.CALIB) {
    const n = Math.ceil(app.countT);
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "#00e5ff";
    ctx.shadowColor = "#00e5ff";
    ctx.shadowBlur = 26;
    ctx.font = "800 " + Math.round(world.H * .16) + "px Consolas, monospace";
    ctx.fillText(n > 3 ? "3" : String(n), world.W / 2, world.H * .3);
    ctx.shadowBlur = 0;
    ctx.font = "600 " + Math.round(world.H * .032) + "px 'Segoe UI', sans-serif";
    ctx.fillStyle = "#dfe9ff";
    const L = hands.left.present;
    ctx.fillText(L ? "¡Mano izquierda capturada! Sube y baja la muñeca…" : "Muestra la mano IZQUIERDA para calibrar la altitud", world.W / 2, world.H * .45);
    if (n <= 1) {
      ctx.fillStyle = "#ffd166";
      ctx.fillText("¡AL VUELO!", world.W / 2, world.H * .55);
    }
    ctx.restore();
  }

  /* Aviso de turbo */
  if (drone.turbo > 0.4 && app.state === S.PLAY) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.font = "800 20px Consolas, monospace";
    ctx.fillStyle = `rgba(255, 159, 28, ${.5 + .5 * Math.sin(app.time * 14)})`;
    ctx.fillText("⚡ TURBO · PUNTOS x2", world.W / 2, world.H - 26);
    ctx.restore();
  }
}
/* =========================================================
   Bucle principal
   ========================================================= */
let lastT = performance.now();
let camW = 0, camH = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000) || 0.016;
  lastT = now;
  app.time += dt;

  /* FPS medidos */
  fps.n++;
  if (now - fps.t >= 500) { fps.v = fps.n * 1000 / (now - fps.t); fps.t = now; fps.n = 0; }

  /* Webcam + gestos */
  if (video && camOverlay && !app.keyboardOnly && app.state !== S.START && app.state !== S.LOADING && app.state !== S.ERROR) {
    hands.update(video, now);
    if (video.videoWidth && (video.videoWidth !== camW || video.videoHeight !== camH)) {
      camW = video.videoWidth; camH = video.videoHeight;
      camOverlay.width = camW; camOverlay.height = camH;
    }
    camCtx.clearRect(0, 0, camOverlay.width, camOverlay.height);
    hands.drawOverlay(camCtx, camW, camH);
  }

  /* Estados */
  if (app.state === S.CALIB) {
    app.countT -= dt;
    const cDigit = Math.ceil(app.countT);
    if (app.lastCount !== cDigit && cDigit >= 1 && cDigit <= 3) { app.lastCount = cDigit; sfx.blip(340, 340, .07, "sine", .12); }
    readControls(dt);
    world.update(dt * 120, drone);
    if (app.countT <= 0) finishCalibration();
  } else if (app.state === S.PLAY) {
    readControls(dt);
    world.update(drone.spd * dt, drone);
    scoring(dt);
    if (app.invuln > 0) app.invuln -= dt;

    /* Auto-pausa si se pierden las manos (o el modo teclado detecta inactividad) */
    if (!app.keyboardOnly) {
      const seen = hands.left.present || hands.right.present;
      if (seen) { app.handsSeenT += dt; } else { app.handsSeenT = Math.max(0, app.handsSeenT - dt); }

      app.handsLostT = app.handsLostT || 0;
      if (!seen) {
        app.handsLostT = (app.handsLostT || 0) + dt;
        if (app.handsLostT > 2.2) { app.handsLostT = 0; setGameState(S.HANDS_LOST); }
      } else app.handsLostT = 0;
    }
  } else if (app.state === S.HANDS_LOST) {
    const seen = app.keyboardOnly || (hands.left.present || hands.right.present);
    if (seen) {
      app.handsSeenT += dt;
      if (app.handsSeenT > 0.7) { app.handsSeenT = 0; setGameState(S.PLAY); }
    } else app.handsSeenT = 0;
  } else if (app.state === S.GAMEOVER && !app.keyboardOnly) {
    /* Reintento con pinza derecha mantenida */
    if (hands.right.present && hands.right.pinch > 0.55) {
      app.pinchHold += dt;
      if (app.pinchHold > 1.5) { app.pinchHold = 0; startCalibration(); }
    } else { app.pinchHold = 0; $("#go-retry-fill").style.width = "0%"; }
    $("#go-retry-fill").style.width = Math.min(100, (app.pinchHold / 1.5) * 100) + "%";
  }

  if (app.state === S.PLAY || app.state === S.CALIB) updateHud();
  updateGesturePanel();
  drawScreen(world.ctx);
}

/* =========================================================
   Entrada de teclado (respaldo)
   ========================================================= */
window.addEventListener("keydown", (e) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(e.code)) e.preventDefault();
  KEY.left = e.code === "ArrowLeft" || KEY.left;
  KEY.right = e.code === "ArrowRight" || KEY.right;
  KEY.up = e.code === "ArrowUp" || KEY.up;
  KEY.down = e.code === "ArrowDown" || KEY.down;
  KEY.space = e.code === "Space" || KEY.space;
  if (e.code === "KeyP" || e.code === "Escape") {
    if (app.state === S.PLAY) setGameState(S.PAUSE);
    else if (app.state === S.PAUSE) setGameState(S.PLAY);
  }
  if (e.code === "Enter") {
    if (app.state === S.START) $("#btn-start").click();
    else if (app.state === S.GAMEOVER) $("#btn-retry").click();
    else if (app.state === S.PAUSE) $("#btn-resume").click();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "ArrowLeft") KEY.left = false;
  if (e.code === "ArrowRight") KEY.right = false;
  if (e.code === "ArrowUp") KEY.up = false;
  if (e.code === "ArrowDown") KEY.down = false;
  if (e.code === "Space") KEY.space = false;
});

/* =========================================================
   Arranque y eventos de UI
   ========================================================= */
function bindUI() {
  $("#diff-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-diff]");
    if (!b) return;
    app.diff = b.dataset.diff;
    for (const x of document.querySelectorAll("#diff-seg button")) x.classList.toggle("active", x === b);
  });
  $("#opt-invert").addEventListener("change", (e) => hands.setSwapHands(e.target.checked));
  $("#btn-start").addEventListener("click", initSession);
  $("#btn-retry").addEventListener("click", startCalibration);
  $("#btn-resume").addEventListener("click", () => { setGameState(S.PLAY); app.handsSeenT = 0.7; });
  $("#btn-pause").addEventListener("click", () => { if (app.state === S.PLAY) setGameState(S.PAUSE); });
  $("#btn-mute").addEventListener("click", () => {
    const m = !sfx.muted;
    sfx.setMuted(m);
    $("#btn-mute").textContent = m ? "🔇" : "🔊";
  });
  $("#btn-keyboard").addEventListener("click", () => {
    app.keyboardOnly = true;
    $("#gesture-panel").classList.add("hidden");
    $("#cam-wrap").classList.add("hidden");
    $("#g-backend").textContent = "MODO TECLADO";
    startCalibration();
  });
  window.addEventListener("resize", () => world.resize());
  window.addEventListener("blur", () => { if (app.state === S.PLAY) setGameState(S.PAUSE); });
}

async function initSession() {
  sfx.resume();
  if (app.keyboardMode || app.keyboardOnly) return startCalibration();
  try {
    setGameState(S.LOADING);
    setStatus("Descargando MediaPipe (una sola vez)…");
    video = $("#cam");
    camOverlay = $("#cam-overlay");
    camCtx = camOverlay.getContext("2d");
    await hands.init(video, setStatus);
    setStatus("Solicitando acceso a la cámara…");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false });
    video.srcObject = stream;
    await video.play().catch(() => {});
    setStatus("Calibrando…");
    $("#g-backend").textContent = "WASM · " + hands.backend;
    startCalibration();
  } catch (err) {
    console.error(err);
    $("#error-msg").textContent = (err && err.message ? err.message : String(err)) + " — Comprueba el permiso de cámara (se requiere HTTPS o localhost).";
    setGameState(S.ERROR);
  }
}

/* Init */
world.resize();
bindUI();
setGameState(S.START);
requestAnimationFrame(frame);