import { CURTAINS } from "./shaders";

/**
 * The curtains as cloth. Each curtain has two damped strings that run across the width of the
 * hero: one for how far the cloth is pushed sideways, one for how far its hem is lifted. A push
 * excites them where it happens and the wave equation carries the bend along the curtain until
 * the damping eats it, so a hand moving through the light leaves a wake instead of a dent.
 *
 * Positions are in page heights; the strings are sampled evenly across the width.
 */

export const SAMPLES = 160;
const STEP = 1 / 120;
/**
 * How fast a bend travels along a curtain, in widths per second. Slow enough that a push stays
 * where the hand is instead of spreading thin across the whole curtain.
 */
const SPEED = 0.12;
/*
 * A stiff, lightly damped hang: a pushed curtain swings back past where it rests, comes back
 * once more and settles in about two seconds, the way heavy cloth does.
 */
const SPRING = 14;
const DAMPING = 1.6;

/** How stiffly a held hand pulls the cloth to its open shape, and how much it calms it there. */
const HOLD = 140;
const HOLD_DAMPING = 16;
/** d e^(-d^2) peaks at this value: the open shape is scaled so its widest point is `open`. */
const OPEN_PEAK = 0.4289;

export class Cloth {
  /** What the field shader samples: per curtain and sample, sway, lift, stir, held height. */
  readonly texels = new Float32Array(SAMPLES * CURTAINS * 4);
  private readonly sway = new Float32Array(SAMPLES * CURTAINS);
  private readonly swayV = new Float32Array(SAMPLES * CURTAINS);
  private readonly lift = new Float32Array(SAMPLES * CURTAINS);
  private readonly liftV = new Float32Array(SAMPLES * CURTAINS);
  private readonly stir = new Float32Array(SAMPLES * CURTAINS);
  /** How high above its hem the cloth was last held: below it the cloth moves whole. */
  private readonly held = new Float32Array(SAMPLES * CURTAINS);
  private leftover = 0;
  private still = 0;

  /**
   * A hand at `u` (0 to 1 across), `at` page heights above the hem, moving at (vx, vy) page
   * heights per second. While it is in the cloth it holds it open: the cloth on either side is
   * pulled out to an open shape `open` page heights wide, firmly and without wobble. Let go, and
   * the cloth swings back past where it hangs and settles. While the hand moves, the cloth also
   * picks up part of its motion (`drag`, 0 for a hand at rest, 1 for a hand in full motion).
   */
  touch(curtain: number, u: number, at: number, vx: number, vy: number, open: number, strength: number, drag: number, dt: number): void {
    if (strength <= 0.001) return;
    const o = curtain * SAMPLES;
    const sigma = 0.045;
    const from = Math.max(0, Math.floor((u - sigma * 3) * (SAMPLES - 1)));
    const to = Math.min(SAMPLES - 1, Math.ceil((u + sigma * 3) * (SAMPLES - 1)));
    const grip = (1 - Math.exp(-14 * strength * dt)) * drag;
    const hold = Math.min(1, strength);
    const reach = Math.min(1, dt * 8);
    for (let i = from; i <= to; i++) {
      const d = (i / (SAMPLES - 1) - u) / sigma;
      const g = Math.exp(-d * d);
      const j = o + i;
      this.swayV[j] += (vx - this.swayV[j]) * g * grip;
      this.liftV[j] += (vy - this.liftV[j]) * g * grip * 0.6;
      if (open > 0) {
        const shape = (open * d * g) / OPEN_PEAK;
        this.swayV[j] += ((shape - this.sway[j]) * HOLD - this.swayV[j] * HOLD_DAMPING) * g * hold * dt;
        this.held[j] += (at - this.held[j]) * g * reach;
      }
    }
    this.still = 0;
  }

  /** A sudden lift of the hem around `u`: a press, or a message going through. */
  kick(curtain: number, u: number, vy: number, sigma = 0.03): void {
    if (Math.abs(vy) < 1e-4) return;
    const o = curtain * SAMPLES;
    const from = Math.max(0, Math.floor((u - sigma * 3) * (SAMPLES - 1)));
    const to = Math.min(SAMPLES - 1, Math.ceil((u + sigma * 3) * (SAMPLES - 1)));
    for (let i = from; i <= to; i++) {
      const d = (i / (SAMPLES - 1) - u) / sigma;
      this.liftV[o + i] += vy * Math.exp(-d * d);
    }
    this.still = 0;
  }

  /** Advances with a fixed step so the motion does not depend on the frame rate. */
  advance(dt: number): void {
    this.leftover = Math.min(this.leftover + dt, STEP * 6);
    const dx = 1 / (SAMPLES - 1);
    const c2 = (SPEED * SPEED) / (dx * dx);
    let energy = 0;
    while (this.leftover >= STEP) {
      this.leftover -= STEP;
      for (let c = 0; c < CURTAINS; c++) {
        energy += integrate(this.sway, this.swayV, c * SAMPLES, c2);
        energy += integrate(this.lift, this.liftV, c * SAMPLES, c2);
      }
    }
    const ease = Math.min(1, dt * 5);
    // Once the cloth has swung back, where it was held stops mattering.
    const forget = Math.min(1, dt * 0.4);
    for (let j = 0; j < SAMPLES * CURTAINS; j++) {
      const motion = Math.min(1, (Math.abs(this.swayV[j]) + Math.abs(this.liftV[j])) * 3);
      this.stir[j] += (motion - this.stir[j]) * ease;
      this.held[j] -= this.held[j] * forget;
      const t = j * 4;
      this.texels[t] = this.sway[j];
      this.texels[t + 1] = this.lift[j];
      this.texels[t + 2] = this.stir[j];
      this.texels[t + 3] = this.held[j];
    }
    this.still = energy < 1e-8 ? this.still + dt : 0;
  }

  /** True once the cloth has hung still for a moment. */
  get resting(): boolean {
    return this.still > 0.5;
  }

  reset(): void {
    for (const a of [this.sway, this.swayV, this.lift, this.liftV, this.stir, this.held, this.texels]) a.fill(0);
  }
}

function integrate(pos: Float32Array, vel: Float32Array, o: number, c2: number): number {
  const last = o + SAMPLES - 1;
  let energy = 0;
  for (let i = o; i <= last; i++) {
    // Free ends: the cloth goes on past the edge of the screen instead of being nailed to it.
    const left = i > o ? pos[i - 1] : pos[i];
    const right = i < last ? pos[i + 1] : pos[i];
    const accel = c2 * (left + right - 2 * pos[i]) - SPRING * pos[i] - DAMPING * vel[i];
    vel[i] += accel * STEP;
    energy += vel[i] * vel[i];
  }
  for (let i = o; i <= last; i++) pos[i] += vel[i] * STEP;
  return energy;
}
