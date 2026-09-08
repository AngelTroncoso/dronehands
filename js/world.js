/* =========================================================
   DRONE HANDS · Mundo del juego (canvas 2D)
   Puertas con hueco, anillos, chips IoT, partículas, parallax
   ========================================================= */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rnd = (a, b) => a + Math.random() * (b - a);

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.W = 0;
    this.H = 0;
    this.dpr = 1;

    this.gates = [];
    this.chips = [];
    this.parts = [];
    this.rings = [];
    this.stars = [];
    this.skyline = [];
    this.gateDist = 0;    // píxeles hasta la siguiente puerta
    this.gateW = 92;      // hueco en píxeles
    this.gateCount = 0;
    this.bgScroll = 0;

    this.palette = {
      gate: "rgba(0, 229, 255, .95)",
      gateWarn: "rgba(255, 77, 109, .95)",
      ring: "#ffd166",
      chip: "#3ddc84"
    };
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = this.canvas.clientWidth || window.innerWidth;
    this.H = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.buildBackground();
  }

  buildBackground() {
    this.stars = [];
    for (let i = 0; i < 110; i++) {
      this.stars.push({ x: Math.random() * this.W, y: Math.random() * this.H, r: rnd(.4, 1.5), tw: rnd(0, 6), spd: rnd(.2, .8) });
    }
    this.skyline = [];
    let x = 0;
    while (x < this.W * 1.4) {
      const w = rnd(26, 64);
      this.skyline.push({ x, w, h: rnd(30, 150), win: Math.random() < .7 });
      x += w + rnd(4, 14);
    }
  }

  /** Dificultad 0..1 (según progreso de puntos) */
  setDifficulty(d) {
    this.gateW = lerpN(150, 86, clamp(d, 0, 1));
  }

  reset() {
    this.gates = [];
    this.chips = [];
    this.rings = [];
    this.parts = [];
    this.gateDist = 260;
    this.gateCount = 0;
    this.bgScroll = 0;
    this.setDifficulty(0);
  }

  /** Avanza el mundo una distancia `dtPx` (píxeles) */
  update(dtPx, drone) {
    const d = dtPx;
    this.bgScroll = (this.bgScroll + d * .25) % Math.max(1, this.W);

    /* Generación */
    this.gateDist -= d;
    if (this.gateDist <= 0) {
      this.gateDist = clamp(300 - this.gateCount * 1.2, 200, 300) + rnd(-30, 40);
      const gapY = rnd(this.H * .22, this.H * .78);
      this.gates.push({ x: this.W + 60, gapY, w: this.gateW, passed: false, warn: 0, id: this.gateCount++ });
      if (Math.random() < .35) {
        this.chips.push({ x: this.W + 60 + rnd(90, 150), y: rnd(this.H * .18, this.H * .82), taken: false, tw: 0 });
      }
      if (Math.random() < .45) {
        this.rings.push({ x: this.W + 60 + rnd(120, 170), y: rnd(this.H * .2, this.H * .8), r: 26, passed: false, tw: 0 });
      }
    }

    /* Movimiento + colisiones */
    const r = 14; // radio del dron
    for (const g of this.gates) {
      g.x -= d;
      if (g.x < -80) g.dead = true;
      if (!g.passed && g.x < drone.x) {
        g.passed = true;
        if (drone.y < g.gapY - g.w / 2 - r || drone.y > g.gapY + g.w / 2 + r) {
          g.warn = 1;
          g.hitDrone = true;
        }
      }
      /* Colisión lateral con el muro mientras se cruza */
      if (!g.hitDrone && Math.abs(g.x - drone.x) < 22) {
        if (drone.y < g.gapY - g.w / 2 - r * .4 || drone.y > g.gapY + g.w / 2 + r * .4) {
          g.warn = 1;
          g.hitDrone = true;
        }
      }
    }
    this.gates = this.gates.filter(g => !g.dead);

    for (const c of this.chips) {
      c.x -= d;
      c.tw += .12;
      if (c.x < -40) c.dead = true;
      if (!c.taken && Math.hypot(c.x - drone.x, c.y - drone.y) < r + 15) c.taken = true;
    }
    this.chips = this.chips.filter(c => !c.dead);

    for (const ring of this.rings) {
      ring.x -= d;
      ring.tw += .1;
      if (ring.x < -60) ring.dead = true;
      if (!ring.passed && ring.x < drone.x) {
        ring.passed = true;
        ring.hitDrone = Math.abs(ring.y - drone.y) < ring.r + r;
      }
    }
    this.rings = this.rings.filter(r2 => !r2.dead);

    for (const p of this.parts) {
      p.x += p.vx - d * p.world;
      p.y += p.vy;
      p.life -= p.decay;
    }
    this.parts = this.parts.filter(p => p.life > 0);
  }

  burst(x, y, color, n = 16, spd = 3) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rnd(.4, 1) * spd;
      this.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, decay: rnd(.02, .05), color, world: .4, r: rnd(1.5, 3.5) });
    }
  }

  draw() {
    const ctx = this.ctx;
    this.drawBackground(ctx);
    this.drawRings(ctx);
    this.drawGates(ctx);
    this.drawChips(ctx);
    this.drawParts(ctx);
  }

  drawBackground(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, "#060a18");
    g.addColorStop(.55, "#0a1226");
    g.addColorStop(1, "#0d0a1c");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);

    /* Estrellas */
    ctx.fillStyle = "#9db8ff";
    for (const s of this.stars) {
      const x = (s.x - this.bgScroll * s.spd) % this.W;
      const xx = x < 0 ? x + this.W : x;
      const tw = .35 + .65 * Math.abs(Math.sin(s.tw + this.bgScroll * .002));
      ctx.globalAlpha = .5 * tw;
      ctx.fillRect(xx, s.y, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    /* Skyline lejano */
    const off = (this.bgScroll * .5) % Math.max(1, this.W * .4);
    ctx.fillStyle = "#0f1530";
    for (const b of this.skyline) {
      const x = ((b.x - off) % (this.W * 1.4));
      const xx = x < 0 ? x + this.W * 1.4 : x;
      ctx.fillRect(xx, this.H - b.h, b.w, b.h);
    }
    ctx.fillStyle = "rgba(0, 229, 255, .18)";
    for (const b of this.skyline) {
      const x = ((b.x - off) % (this.W * 1.4));
      const xx = x < 0 ? x + this.W * 1.4 : x;
      if (b.win) for (let wy = this.H - b.h + 8; wy < this.H - 10; wy += 14) {
        for (let wx = xx + 5; wx < xx + b.w - 6; wx += 11) ctx.fillRect(wx, wy, 3, 5);
      }
    }

    /* Suelo neón en perspectiva */
    ctx.strokeStyle = "rgba(0, 229, 255, .16)";
    ctx.lineWidth = 1;
    const horizon = this.H * .84;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(this.W, horizon);
    ctx.stroke();
    ctx.strokeStyle = "rgba(0, 229, 255, .09)";
    for (let i = 0; i < 16; i++) {
      const t = (i / 15 + (this.bgScroll * .001) % 1) % 1;
      const y = horizon + t * t * (this.H - horizon) + 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.W, y);
      ctx.stroke();
    }
    for (let i = -8; i <= 24; i++) {
      const x0 = i * 90 - (this.bgScroll * .8) % 90;
      ctx.beginPath();
      ctx.moveTo(x0, horizon);
      ctx.lineTo((x0 - this.W / 2) * 2.4 + this.W / 2, this.H);
      ctx.stroke();
    }
  }

  drawGates(ctx) {
    for (const g of this.gates) {
      const top = g.gapY - g.w / 2;
      const bot = g.gapY + g.w / 2;
      const color = g.warn ? this.palette.gateWarn : this.palette.gate;
      const grad = ctx.createLinearGradient(g.x - 26, 0, g.x + 26, 0);
      grad.addColorStop(0, "rgba(10, 18, 38, .0)");
      grad.addColorStop(.5, "rgba(16, 28, 58, .92)");
      grad.addColorStop(1, "rgba(10, 18, 38, .0)");

      ctx.fillStyle = grad;
      ctx.fillRect(g.x - 26, -10, 52, top + 10);
      ctx.fillRect(g.x - 26, bot, 52, this.H - bot + 10);

      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.moveTo(g.x - 26, top);
      ctx.lineTo(g.x + 26, top);
      ctx.moveTo(g.x - 26, bot);
      ctx.lineTo(g.x + 26, bot);
      ctx.stroke();
      ctx.shadowBlur = 0;

      /* Marcas centrales del hueco */
      ctx.strokeStyle = g.warn ? "rgba(255, 77, 109, .5)" : "rgba(0, 229, 255, .35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.moveTo(g.x, g.gapY - 6);
      ctx.lineTo(g.x, g.gapY + 6);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  drawRings(ctx) {
    for (const r of this.rings) {
      const hit = r.passed && r.hitDrone;
      const col = hit ? this.palette.chip : this.palette.ring;
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.globalAlpha = .55 + .35 * Math.abs(Math.sin(r.tw));
      ctx.shadowColor = col;
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.fillStyle = col;
      ctx.font = "700 11px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText("+15", r.x, r.y - r.r - 7);
    }
  }

  drawChips(ctx) {
    for (const c of this.chips) {
      if (c.taken) continue;
      const s = 10 + Math.sin(c.tw) * 1.5;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(Math.sin(c.tw * .7) * .3);
      ctx.shadowColor = this.palette.chip;
      ctx.shadowBlur = 14;
      ctx.fillStyle = "rgba(61, 220, 132, .2)";
      ctx.strokeStyle = this.palette.chip;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(-s, -s, s * 2, s * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = this.palette.chip;
      ctx.fillRect(-4, -4, 8, 8);
      ctx.restore();
      ctx.shadowBlur = 0;
    }
  }

  drawParts(ctx) {
    for (const p of this.parts) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function lerpN(a, b, t) { return a + (b - a) * t; }