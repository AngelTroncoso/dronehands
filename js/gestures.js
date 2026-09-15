/* =========================================================
   DRONE HANDS · Gestos con MediaPipe Hand Landmarker
   Prototipo IoT · procesamiento 100% local (WASM + GPU)
   Mano IZQUIERDA  -> altitud/velocidad vertical (Y de la muñeca)
   Mano DERECHA    -> dirección (ángulo muñeca->índice) + palma
   ========================================================= */
import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";

const VISION_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/* Conexiones del esqueleto de la mano (pares de índices) */
const HAND_LINKS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
];

const TIP = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
const PIP = { index: 6, middle: 10, ring: 14, pinky: 18 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

export class HandController {
  constructor() {
    this.landmarker = null;
    this.backend = "";
    this.lastVideoTime = -1;
    this.lastTs = 0;

    /* Estado de cada mano (relativo, ya espejado para el jugador) */
    this.resetState = () => ({
      present: false,
      score: 0,
      altRaw: 0,       // -1 arriba .. +1 abajo (mano izquierda)
      alt: 0,
      altPoint: 0,     // -1 apunta arriba .. +1 apunta abajo (señal de apuntado)
      pointDeg: 0,     // ángulo crudo de apuntado (muñeca -> índice, en grados)
      pinch: 0,        // 0 abierta .. 1 cerrada (pinza índice-pulgar)
      fist: 0,         // 0 mano abierta .. 1 puño
      fingers: 0,      // número de dedos extendidos (0..5)
      turbo: 0,        // 1 = índice+corazón extendidos (TURBO ×2)
      palm: 0,         // 1 = palma abierta (aerofreno)
      dir: 0,          // -1 apunta arriba .. +1 apunta derecha (mano derecha)
      side: 0,         // -1 izquierda .. +1 derecha (orientación de la palma)
      landmarks: null
    });
    this.left = this.resetState();
    this.right = this.resetState();
    this.swapHands = false;

    /* Suavizado EMA */
    this.smooth = 0.35;
    /* Decaimiento a neutro cuando la mano desaparece */
    this.release = { dir: 2.2, side: 2.0, alt: 2.5 };

    this.calib = { leftCenter: null, leftAngle: null, rightAngle: null };
  }

  async init(video, onStatus) {
    onStatus?.("Descargando runtime de MediaPipe…");
    const fileset = await FilesetResolver.forVisionTasks(VISION_WASM);
    onStatus?.("Cargando modelo hand_landmarker.task…");
    const opts = {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    };
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts);
      this.backend = "GPU";
    } catch (e) {
      onStatus?.("GPU no disponible · usando CPU…");
      opts.baseOptions.delegate = "CPU";
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts);
      this.backend = "CPU";
    }
    onStatus?.("¡IA lista!");
  }

  setSwapHands(swap) {
    this.swapHands = !!swap;
  }

  /** Centro de altitud + ángulos neutros capturados en la cuenta atrás */
  captureAltCenter() {
    if (this.left.present) {
      this.calib.leftCenter = this.left.altRaw;
      this.calib.leftAngle = this.left.pointDeg;
    }
    if (this.right.present) this.calib.rightAngle = this.right.pointDeg;
  }
  get altCenter() {
    return this.calib.leftCenter;
  }
  clearAltCenter() {
    this.calib.leftCenter = null;
    this.calib.leftAngle = null;
    this.calib.rightAngle = null;
  }

  /** Procesa el fotograma actual del vídeo */
  update(video, now) {
    if (!this.landmarker || video.readyState < 2) return;
    if (video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;
    this.lastTs = now;

    let res = null;
    try {
      res = this.landmarker.detectForVideo(video, now);
    } catch (_) {
      return;
    }

    const buckets = { Left: this.resetState(), Right: this.resetState() };
    const hands = res?.landmarks || [];
    const handedList = res?.handedness || res?.handednesses || [];

    for (let i = 0; i < hands.length; i++) {
      const lm = hands[i];
      if (!lm || lm.length < 21) continue;
      /* El gesto se clasifica en espacio YA ESPEJADO (como se ve el vídeo en pantalla).
         MediaPipe reporta handedness desde la cámara: "Left" aparece como mano derecha
         del jugador, por eso invertimos la etiqueta. */
      let label = handedList[i]?.[0]?.categoryName || "Right"; // "Left" | "Right"
      label = label === "Left" ? "Right" : "Left";
      if (this.swapHands) label = label === "Left" ? "Right" : "Left";

      const st = buckets[label];
      st.present = true;
      st.score = handedList[i]?.[0]?.score ?? 0;
      st.landmarks = lm;
      this.extractFeatures(st, lm);
    }

    for (const side of ["Left", "Right"]) {
      const fresh = buckets[side];
      const cur = side === "Left" ? this.left : this.right;
      const dt = this.lastDt || 1 / 60;

      if (fresh.present) {
        cur.present = true;
        cur.score = fresh.score;
        cur.landmarks = fresh.landmarks;
        /* EMA hacia el nuevo valor */
        cur.altRaw = lerp(cur.altRaw, fresh.altRaw, this.smooth);
        cur.alt = lerp(cur.alt, fresh.alt, this.smooth);
        cur.altPoint = lerp(cur.altPoint, fresh.altPoint, this.smooth);
        cur.pointDeg = lerp(cur.pointDeg, fresh.pointDeg, this.smooth);
        cur.dir = lerp(cur.dir, fresh.dir, this.smooth);
        cur.side = lerp(cur.side, fresh.side, this.smooth);
        cur.pinch = fresh.pinch > 0.6 ? Math.min(1, cur.pinch + dt * 6) : (fresh.pinch < 0.35 ? Math.max(0, cur.pinch - dt * 6) : cur.pinch);
        cur.fist = fresh.fist > 0.6 ? Math.min(1, cur.fist + dt * 6) : (fresh.fist < 0.35 ? Math.max(0, cur.fist - dt * 6) : cur.fist);
        cur.turbo = fresh.turbo > 0.5 ? Math.min(1, cur.turbo + dt * 8) : Math.max(0, cur.turbo - dt * 8);
        cur.palm = fresh.palm > 0.5 ? Math.min(1, cur.palm + dt * 8) : Math.max(0, cur.palm - dt * 8);
        cur.fingers = fresh.fingers;
      } else if (cur.present) {
        /* La mano desapareció: decaer a neutro */
        cur.score = 0;
        cur.landmarks = null;
        cur.pinch = Math.max(0, cur.pinch - dt * 3);
        cur.fist = Math.max(0, cur.fist - dt * 3);
        cur.turbo = Math.max(0, cur.turbo - dt * 3);
        cur.palm = Math.max(0, cur.palm - dt * 3);
        cur.fingers = 0;
        cur.dir = this.decay(cur.dir, this.release.dir, dt);
        cur.side = this.decay(cur.side, this.release.side, dt);
        if (Math.abs(cur.altRaw) < 0.04) cur.altRaw = 0; else cur.altRaw = this.decay(cur.altRaw, this.release.alt, dt);
        if (Math.abs(cur.alt) < 0.04) cur.alt = 0; else cur.alt = this.decay(cur.alt, this.release.alt, dt);
        cur.altPoint = this.decay(cur.altPoint, 2.5, dt);
        if (Math.abs(cur.pointDeg) < 1) cur.pointDeg = 0; else cur.pointDeg = this.decay(cur.pointDeg, 60, dt);
        if (Math.abs(cur.dir) < 0.03 && Math.abs(cur.side) < 0.03 && Math.abs(cur.alt) < 0.02 &&
            cur.pinch === 0 && cur.fist === 0 && cur.turbo === 0 && cur.palm === 0) cur.present = false;
      }
    }
  }

  decay(v, rate, dt) {
    const step = rate * dt;
    if (v > 0) return Math.max(0, v - step);
    return Math.min(0, v + step);
  }

  /** Extrae las features de control de una mano a partir de sus 21 landmarks */
  extractFeatures(st, lm) {
    const W = lm[0], I = lm[TIP.index];

    /* --- Mano IZQUIERDA · altitud ---
       Dos señales combinadas:
       1) Posición vertical de la muñeca respecto al centro calibrado.
       2) Dirección del APUNTADO (ángulo muñeca -> índice):
          índice hacia arriba = SUBIR, hacia abajo = BAJAR.
       Se usa la de mayor magnitud, así funciona tanto bajando la mano
       como simplemente apuntando hacia abajo. */
    st.altRaw = (W.y - 0.5) * 2; // -1 arriba .. +1 abajo
    const span = Math.max(0.18, Math.abs(lm[9].y - W.y) * 2.6);
    const altWrist = clamp(((W.y - 0.5) * 2) / span, -1, 1);

    /* Apuntado: índice hacia ABAJO = BAJAR, hacia ARRIBA = SUBIR.
       Zona muerta alrededor de la horizontal (±25°), pleno a 70°. */
    const angL = Math.atan2(I.y - W.y, I.x - W.x);
    const degL = (angL * 180) / Math.PI;
    let altPoint = 0;
    if (degL >= 25) altPoint = clamp((degL - 25) / 45, 0, 1);          // apunta abajo -> +1 (BAJAR)
    else if (degL <= -25) altPoint = clamp((degL + 25) / 45, -1, 0);   // apunta arriba -> -1 (SUBIR)
    st.pointDeg = degL;

    st.alt = Math.abs(altPoint) > Math.abs(altWrist) ? altPoint : altWrist;
    st.altPoint = altPoint;   // señal pura de apuntado (para combinar en el juego)

    /* --- Mano DERECHA · dirección (ángulo muñeca -> índice) --- */
    const ang = Math.atan2(I.y - W.y, I.x - W.x); // 0 = derecha, -PI/2 = arriba, +PI/2 = abajo
    const deg = (ang * 180) / Math.PI;
    let d = 0;
    st.altPoint = 0;   // apuntar hacia ABAJO con la derecha también BAJA (señal solo descendente)
    if (deg > -20 && deg < 55) d = deg / 55;              // 0..1 -> acelerar (apuntar al frente)
    else if (deg >= 55) {                                  // apunta abajo -> BAJAR
      st.altPoint = clamp((deg - 55) / 30, 0, 1);
      if (deg >= 106) d = (deg - 106) / 74 * -0.6;         // muy a la izquierda -> retroceso
    }
    st.dir = clamp(d, -1, 1);
    st.pointDeg = deg;

    /* --- Orientación de la palma (muñeca -> nudillo medio) = manillar lateral --- */
    const M = lm[9];
    const sideAng = Math.atan2(M.y - W.y, M.x - W.x);
    const sideDeg = (sideAng * 180) / Math.PI;
    let s = 0;
    if (sideDeg > -20 && sideDeg < 74) s = sideDeg / 74;
    else if (sideDeg >= 74) s = 1;
    else if (sideDeg >= 106) s = (sideDeg - 106) / 74 * -1;
    else if (sideDeg >= 90) s = 0;
    st.side = clamp(s, -1, 1);

    /* --- Pinza índice-pulgar (RECOGER / ENTREGAR pedido) --- */
    const Th = lm[TIP.thumb];
    const handSize = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 0.1;
    const pinchDist = Math.hypot(Th.x - I.x, Th.y - I.y) / handSize;
    st.pinch = clamp(1 - (pinchDist - 0.35) / 0.5, 0, 1);

    /* --- Dedos extendidos: TURBO (2 dedos) y AEROFRENO (palma abierta) --- */
    let extended = [];
    let folded = 0;
    for (const f of ["index", "middle", "ring", "pinky"]) {
      const tip = lm[TIP[f]], pip = lm[PIP[f]];
      if (Math.hypot(tip.x - W.x, tip.y - W.y) < Math.hypot(pip.x - W.x, pip.y - W.y)) folded++;
      else extended.push(f);
    }
    st.fingers = extended.length;
    /* TURBO: índice + corazón extendidos, anular y meñique plegados (✌️) */
    st.turbo = (extended.includes("index") && extended.includes("middle") && folded >= 2) ? 1 : 0;
    /* AEROFRENO: palma abierta (4 dedos extendidos) */
    st.palm = (extended.length >= 4) ? 1 : 0;

    /* --- Puño (hover) --- */
    st.fist = folded / 4;
  }

  /** Dibuja el esqueleto de las manos sobre el canvas de la webcam */
  drawOverlay(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    for (const hand of [this.left, this.right]) {
      if (!hand.present || !hand.landmarks) continue;
      const lm = hand.landmarks;
      const stroke = hand === this.left ? "rgba(0,229,255,.9)" : "rgba(255,209,102,.9)";
      const fill = hand === this.left ? "#00e5ff" : "#ffd166";

      ctx.lineWidth = 2;
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      for (const [a, b] of HAND_LINKS) {
        ctx.moveTo(lm[a].x * w, lm[a].y * h);
        ctx.lineTo(lm[b].x * w, lm[b].y * h);
      }
      ctx.stroke();

      ctx.fillStyle = fill;
      for (let i = 0; i < lm.length; i++) {
        const r = i === 0 ? 4 : 2.4;
        ctx.beginPath();
        ctx.arc(lm[i].x * w, lm[i].y * h, r, 0, Math.PI * 2);
        ctx.fill();
      }

      /* Indicador de pinza (recoger/entregar pedido) */
      if (hand.pinch > 0.35) {
        ctx.strokeStyle = `rgba(61,220,132,${hand.pinch})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(lm[4].x * w, lm[4].y * h);
        ctx.lineTo(lm[8].x * w, lm[8].y * h);
        ctx.stroke();
      }
      /* Indicador TURBO ✌️ */
      if (hand.turbo > 0.5) {
        ctx.strokeStyle = "rgba(255,159,28,.95)";
        ctx.lineWidth = 3;
        for (const f of [TIP.index, TIP.middle]) {
          ctx.beginPath();
          ctx.moveTo(lm[0].x * w, lm[0].y * h);
          ctx.lineTo(lm[f].x * w, lm[f].y * h);
          ctx.stroke();
        }
      }
    }
  }
}