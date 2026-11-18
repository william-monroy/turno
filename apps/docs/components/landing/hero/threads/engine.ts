import { Cloth, SAMPLES } from "./cloth";
import { ACCOUNTS, type Account, createScene, curtainAt, fitAbove, hangRight, hemY, layoutScene, liveHemY, TONES, threadY } from "./layout";
import { createPalette, createRenderer, type Frame, type Palette, type Renderer } from "./renderer";
import { CURTAINS, GLYPHS, PULSES, RECTS } from "./shaders";

/**
 * Runs the threads hero: curtains of light that the pointer pushes like cloth, and one thread
 * through them along which messages travel. The page only hears about what matters (where the
 * labels go, which account a message is in, when it arrives); everything per frame stays here.
 */

/** Where the small labels go, in CSS pixels from the hero's top left corner. */
export interface Placement {
  curtains: { account: Account; x: number; y: number }[];
  session: { x: number; y: number; below: boolean };
}

export type Moment =
  | { kind: "drawn" }
  | { kind: "sent"; by: "you" | "idle" }
  | { kind: "crossing"; account: Account }
  | { kind: "arrived"; account: Account; crossed: number }
  | { kind: "parted"; account: Account }
  | { kind: "still"; account: Account };

export interface Hooks {
  placed(placement: Placement): void;
  /** How much of the intro has shown: 0 nothing, 1 the session id, 2 to 4 each account. */
  reveal(count: number): void;
  account(account: Account): void;
  moment(moment: Moment): void;
  /** WebGL2 could not start: the page shows its still picture instead. */
  failed(): void;
}

export interface Engine {
  /** Sends a message along the thread from its start, as the keyboard does. */
  send(): void;
  /** The account labels, in curtain order: each one rides its curtain's hem. */
  attach(labels: (HTMLElement | null)[]): void;
  destroy(): void;
}

const INTRO = 2.9;
const DRAW_FROM = 0.55;
const DRAW_FOR = 2.1;
/** A moment where the folds sit well: the intro lands on it, reduced motion shows only it. */
const STILL = 45;
const PULSE_SPEED = 0.36;
const PULSE_EASE = 0.35;
/** How far a hand held in a curtain opens it, on each side, in page heights. */
const PART = 0.1;
/** How far under the lowest point of its hem an account's name hangs, in CSS pixels. */
const LABEL_GAP = 30;
/** Where along its curtain each name hangs, as a share of the half width: clear of the copy. */
const LABEL_AT = [-0.5, 0.3, 0.45];

function cellSizeFor(width: number): number {
  if (width < 520) return 11;
  if (width < 1100) return 13;
  if (width < 1700) return 14;
  return 15;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** Resolves any CSS color to linear RGB through a one pixel canvas. */
function makeProbe() {
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  return (value: string, into: Float32Array, at = 0) => {
    if (!ctx) return;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    into[at] = toLinear((r ?? 0) / 255);
    into[at + 1] = toLinear((g ?? 0) / 255);
    into[at + 2] = toLinear((b ?? 0) / 255);
  };
}

function mixInto(into: Float32Array, at: number, from: Float32Array, fromAt: number, to: [number, number, number], t: number) {
  for (let j = 0; j < 3; j++) into[at + j] = (from[fromAt + j] ?? 0) + (to[j] - (from[fromAt + j] ?? 0)) * t;
}

function readPalette(palette: Palette, probe: ReturnType<typeof makeProbe>): void {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const light = !document.documentElement.classList.contains("dark");
  palette.light = light;
  probe(token("--color-fd-background", light ? "#ffffff" : "#07080a"), palette.skyLow);
  probe(token("--tone-keep", light ? "#2457f5" : "#6a93ff"), palette.keep);
  const sky = palette.skyLow;
  const keep = palette.keep;
  // The sky darkens toward navy at the top in the dark, and barely tints on paper.
  const high: [number, number, number] = [keep[0] ?? 0, keep[1] ?? 0, keep[2] ?? 0];
  mixInto(palette.skyHigh, 0, sky, 0, high, light ? 0.018 : 0.016);
  if (light) {
    // On paper a message glows in the purest blue of the same hue: the brightest ink there is.
    const peak = Math.max(keep[0] ?? 0, keep[1] ?? 0, keep[2] ?? 0, 1e-3);
    for (let j = 0; j < 3; j++) palette.keepHot[j] = (keep[j] ?? 0) / peak;
  } else {
    mixInto(palette.keepHot, 0, keep, 0, [0.92, 0.95, 1.0], 0.62);
  }
  TONES.forEach((tone, i) => {
    probe(token(`--tone-${tone}`, "#888888"), palette.tone, i * 3);
    // Near the hem a curtain burns paler; high up it deepens. Both stay inside the account's hue.
    mixInto(palette.toneHot, i * 3, palette.tone, i * 3, [1, 1, 1], light ? 0.0 : 0.42);
    mixInto(palette.toneDeep, i * 3, palette.tone, i * 3, [0, 0, 0], light ? 0.12 : 0.38);
  });
}

export function startThreads(root: HTMLElement, canvas: HTMLCanvasElement, calm: HTMLElement[], hooks: Hooks): Engine | null {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
  if (!gl) return null;

  const font = getComputedStyle(canvas).fontFamily || "ui-monospace, monospace";
  const scene = createScene();
  const cloth = new Cloth();
  const palette = createPalette();
  const probe = makeProbe();
  readPalette(palette, probe);
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = motion.matches;

  const frame: Frame = {
    time: STILL - INTRO,
    fade: 0,
    drop: 0.35,
    frame: 0,
    threadHead: -0.05,
    threadFade: 0,
    pulses: new Float32Array(PULSES * 4),
    rects: new Float32Array(RECTS * 4),
    calmMargin: 0.035,
  };

  const view = { width: 1, height: 1, aspect: 1 };
  const pointer = { u: 0, y: 0, prevU: 0, prevY: 0, vx: 0, vy: 0, seen: false, inside: false, movedAt: -10, partedAt: -100 };
  interface Pulse {
    from: number;
    age: number;
    strength: number;
    alive: boolean;
    curtain: number;
    crossed: number;
    draws: boolean;
  }
  const pulses: Pulse[] = Array.from({ length: PULSES }, () => ({ from: 0, age: 0, strength: 0, alive: false, curtain: -1, crossed: 0, draws: false }));
  let lead: Pulse | null = null;
  const breeze = { curtain: 0, u: 0, vx: 0, age: 0, life: 0, next: 4.5 };
  let clock = 0;
  let intro = 0;
  let revealed = 0;
  let nextIdle = INTRO + 3.4;
  let renderer: Renderer | null = null;
  let raf = 0;
  let last = 0;
  let onScreen = true;
  let disposed = false;
  let stillAt = 1;
  let labels: (HTMLElement | null)[] = [];
  const labelU = [0, 0, 0];
  /** Half of each name's width, in widths: measured once when the names are attached. */
  const labelHalf = [0.03, 0.03, 0.03];

  /** The hem of curtain j at u as it is drawn now, cloth included; Infinity where j has no cloth. */
  const liveAt = (j: number, u: number) => {
    const o = j * 4;
    if (Math.abs(u - (scene.span[o] ?? 0)) > (scene.span[o + 1] ?? 0) + (scene.span[o + 2] ?? 0)) return Number.POSITIVE_INFINITY;
    const at = Math.max(0, Math.min(SAMPLES - 1, Math.round(u * (SAMPLES - 1))));
    const texel = (j * SAMPLES + at) * 4;
    const lift = (cloth.texels[texel + 1] ?? 0) + Math.abs(cloth.texels[texel] ?? 0) * 0.5;
    return liveHemY(scene, j, u, view.aspect, frame.time, frame.drop, lift);
  };

  /**
   * Moves each account's name with the cloth: under the lowest hem anywhere across the name's
   * width, of its own curtain or a neighbour's, so no type ever runs into it. A DOM write per
   * label, no layout read.
   */
  const ride = () => {
    for (let i = 0; i < CURTAINS; i++) {
      const el = labels[i];
      if (!el) continue;
      const u = labelU[i] ?? 0;
      const half = labelHalf[i] ?? 0.03;
      let lowest = liveAt(i, u);
      for (let k = -1; k <= 1; k += 2) {
        for (let j = 0; j < CURTAINS; j++) lowest = Math.min(lowest, liveAt(j, u + k * half));
      }
      if (!Number.isFinite(lowest)) lowest = hemY(scene, i, u);
      const at = Math.max(0, Math.min(SAMPLES - 1, Math.round(u * (SAMPLES - 1))));
      const sway = cloth.texels[(i * SAMPLES + at) * 4] ?? 0;
      const dy = (hemY(scene, i, u) - lowest) * view.height;
      el.style.transform = `translate(calc(-50% + ${(sway * view.height).toFixed(1)}px), ${dy.toFixed(1)}px)`;
    }
  };

  const pulseU = (p: Pulse) => p.from + PULSE_SPEED * (p.age - PULSE_EASE * (1 - Math.exp(-p.age / PULSE_EASE)));

  const setRects = () => {
    const box = root.getBoundingClientRect();
    const h = Math.max(1, box.height);
    const range = document.createRange();
    for (let i = 0; i < RECTS; i++) {
      const el = calm[i];
      frame.rects.fill(0, i * 4, i * 4 + 4);
      if (!el) continue;
      // The words themselves, not their boxes: a paragraph's box spans the whole column. Text
      // is measured node by node; controls (the command box, the buttons) by their own boxes.
      let left = Number.POSITIVE_INFINITY;
      let top = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      const add = (r: DOMRect) => {
        if (r.width <= 0 || r.height <= 0) return;
        left = Math.min(left, r.left);
        top = Math.min(top, r.top);
        right = Math.max(right, r.right);
        bottom = Math.max(bottom, r.bottom);
      };
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (!node.textContent?.trim()) continue;
          range.selectNodeContents(node);
          add(range.getBoundingClientRect());
        } else if ((node as Element).matches("a, button, input, pre, code, [data-copy]")) {
          add((node as Element).getBoundingClientRect());
        }
      }
      if (!Number.isFinite(left)) continue;
      frame.rects[i * 4] = (left - box.left) / h;
      frame.rects[i * 4 + 1] = 1 - (bottom - box.top) / h;
      frame.rects[i * 4 + 2] = (right - box.left) / h;
      frame.rects[i * 4 + 3] = 1 - (top - box.top) / h;
    }
    range.detach();
  };

  const place = () => {
    const curtains = ACCOUNTS.map((account, i) => {
      // The name hangs under the hem, toward the open side of the curtain, in dark sky where it
      // reads at full contrast; the folds lift and drop the hem a little, so it keeps clear.
      const u = (scene.span[i * 4] ?? 0) + (scene.span[i * 4 + 1] ?? 0) * (LABEL_AT[i] ?? 0);
      const x = Math.min(u * view.width, view.width - 56);
      labelU[i] = x / view.width;
      return { account, x, y: (1 - hemY(scene, i, x / view.width)) * view.height + LABEL_GAP };
    });
    const startU = Math.min(0.2, Math.max(16, view.width * 0.035) / view.width);
    // The id sits over the thread, or under it when the thread runs close to the top edge.
    const lineY = (1 - threadY(scene, startU)) * view.height;
    hooks.placed({ curtains, session: { x: startU * view.width, y: lineY, below: lineY < 44 } });
  };

  const draw = () => {
    renderer?.render(frame, cloth.texels, palette);
    ride();
  };

  const writePulses = () => {
    for (let i = 0; i < PULSES; i++) {
      const p = pulses[i];
      const o = i * 4;
      if (!p || !p.alive) {
        frame.pulses[o + 1] = 0;
        continue;
      }
      const u = pulseU(p);
      const fadeIn = Math.min(1, p.age / 0.12);
      const fadeOut = 1 - Math.min(1, Math.max(0, (u - 1.0) / 0.08));
      frame.pulses[o] = u;
      frame.pulses[o + 1] = p.strength * fadeIn * fadeOut * (p.draws ? 0.75 : 1);
    }
  };

  /** The still frame: everything in place, one message caught inside a curtain. */
  const showStill = (curtain: number) => {
    stillAt = curtain;
    frame.time = STILL;
    frame.fade = 1;
    frame.drop = 0;
    frame.threadHead = 1.2;
    frame.threadFade = 1;
    cloth.reset();
    for (const p of pulses) p.alive = false;
    frame.pulses.fill(0);
    frame.pulses[0] = scene.span[curtain * 4] ?? 0.5;
    frame.pulses[1] = 1;
    revealed = 4;
    hooks.reveal(4);
    const account = ACCOUNTS[curtain] ?? "client";
    hooks.account(account);
    hooks.moment({ kind: "still", account });
    draw();
  };

  const resize = () => {
    if (!renderer) return;
    view.width = Math.max(1, root.clientWidth);
    view.height = Math.max(1, root.clientHeight);
    view.aspect = view.width / view.height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = `${view.width}px`;
    canvas.style.height = `${view.height}px`;
    layoutScene(scene, view.aspect);
    renderer.resize(view.width, view.height, cellSizeFor(view.width), ratio);
    setRects();
    // The words are the first calm rect: the band hangs over them, never on them.
    const top = frame.rects[3] ?? 0;
    const right = (frame.rects[2] ?? 0) / view.aspect;
    const at = ACCOUNTS.map((_, i) => Math.min((scene.span[i * 4] ?? 0) + (scene.span[i * 4 + 1] ?? 0) * (LABEL_AT[i] ?? 0), 1 - 56 / view.width));
    // A name is about 20 pixels tall with its scrap of paper.
    fitAbove(scene, top, right, at, (LABEL_GAP + 22) / view.height);
    // Right of the copy there is open page: the curtains hang down into it, above the rail.
    const copyRight = Math.max(right, (frame.rects[6] ?? 0) / view.aspect) + 0.035;
    const rail = Number.parseFloat(getComputedStyle(root).getPropertyValue("--rail")) || 44;
    const floor = Math.max(0.2, (rail + LABEL_GAP + 40) / view.height);
    hangRight(scene, view.aspect > 1.15 ? copyRight : 1, floor);
    place();
    draw();
    wake();
  };

  const launch = (from: number, strength: number, draws = false): Pulse => {
    let slot = pulses[0] as Pulse;
    for (const p of pulses) {
      if (!p.alive) {
        slot = p;
        break;
      }
      if (p.age > slot.age) slot = p;
    }
    slot.from = from;
    slot.age = 0;
    slot.strength = strength;
    slot.alive = true;
    slot.curtain = -1;
    slot.crossed = 0;
    slot.draws = draws;
    lead = slot;
    return slot;
  };

  /** How strongly a hand at (u, y) holds curtain i: inside the light, and a little under the hem. */
  const grip = (i: number, u: number, y: number) => {
    const o = i * 4;
    const centre = scene.span[o] ?? 0;
    const half = (scene.span[o + 1] ?? 0) + (scene.span[o + 2] ?? 0) + 0.04;
    if (Math.abs(u - centre) > half) return 0;
    const d = y - hemY(scene, i, u);
    const height = scene.body[o + 1] ?? 0.4;
    return (d >= 0 ? Math.exp(-d / (height * 1.8)) : Math.exp(-(d * d) / (0.06 * 0.06))) * (scene.reach[i] ?? 1);
  };

  const step = (dt: number) => {
    clock += dt;
    frame.time += dt;
    frame.frame = (frame.frame + 1) % 101;

    if (intro < 1) {
      intro = Math.min(1, clock / INTRO);
      const settle = 1 - (1 - intro) ** 3;
      frame.drop = (1 - settle) * 0.35;
      frame.fade = Math.min(1, intro * 1.5) ** 1.4;
    }
    if (revealed === 0 && clock >= DRAW_FROM) {
      revealed = 1;
      hooks.reveal(1);
      const draw = launch(-0.04, 1, true);
      // The intro message is timed to draw the whole thread in DRAW_FOR seconds.
      draw.age = 0;
    }
    frame.threadFade = Math.min(1, Math.max(0, (clock - DRAW_FROM) / 0.25));

    // The pointer: its velocity, smoothed, and what it does to each curtain it is inside.
    const rawX = ((pointer.u - pointer.prevU) * view.aspect) / dt;
    const rawY = (pointer.y - pointer.prevY) / dt;
    pointer.prevU = pointer.u;
    pointer.prevY = pointer.y;
    const follow = 1 - Math.exp(-dt * 18);
    pointer.vx += (Math.max(-4, Math.min(4, rawX)) - pointer.vx) * follow;
    pointer.vy += (Math.max(-4, Math.min(4, rawY)) - pointer.vy) * follow;
    const active = pointer.seen && clock - pointer.movedAt < 0.3;
    if (pointer.inside && !reduced) {
      let strongest = 0;
      let which = -1;
      const speed = Math.hypot(pointer.vx, pointer.vy);
      const drag = active ? Math.min(1, speed / 0.5) : 0;
      for (let i = 0; i < CURTAINS; i++) {
        const k = grip(i, pointer.u, pointer.y);
        const at = Math.max(0, pointer.y - hemY(scene, i, pointer.u));
        cloth.touch(i, pointer.u, at, pointer.vx * 0.42, pointer.vy * 0.3, PART, k, drag, dt);
        if (k > strongest) {
          strongest = k;
          which = i;
        }
      }
      if (which >= 0 && strongest > 0.5 && speed > 0.6 && clock - pointer.partedAt > 6) {
        pointer.partedAt = clock;
        hooks.moment({ kind: "parted", account: ACCOUNTS[which] ?? "work" });
      }
    }

    // When nobody touches it, a slow draft moves through one curtain now and then.
    breeze.next -= dt;
    if (breeze.next <= 0 && breeze.life <= 0) {
      breeze.curtain = Math.floor(Math.random() * CURTAINS);
      const o = breeze.curtain * 4;
      const dir = Math.random() < 0.5 ? -1 : 1;
      breeze.u = (scene.span[o] ?? 0.5) - dir * (scene.span[o + 1] ?? 0.1);
      breeze.vx = dir * (0.05 + Math.random() * 0.05);
      breeze.age = 0;
      breeze.life = 2.2 + Math.random();
      breeze.next = (active ? 10 : 5) + Math.random() * 4;
    }
    if (breeze.life > 0) {
      breeze.age += dt;
      breeze.u += breeze.vx * dt;
      const envelope = Math.sin(Math.PI * Math.min(1, breeze.age / breeze.life));
      cloth.touch(breeze.curtain, breeze.u, 0, breeze.vx * view.aspect * 0.5, 0, 0, 0.45 * envelope, 1, dt);
      if (breeze.age >= breeze.life) breeze.life = 0;
    }
    cloth.advance(dt);

    // Messages: each one runs along the thread and says which account it is crossing.
    for (const p of pulses) {
      if (!p.alive) continue;
      p.age += p.draws ? (dt * (1.08 / DRAW_FOR)) / PULSE_SPEED : dt;
      const u = pulseU(p);
      if (p.draws) frame.threadHead = u;
      const inside = curtainAt(scene, u);
      if (inside >= 0 && inside !== p.curtain) {
        p.curtain = inside;
        p.crossed += 1;
        // The curtain stirs where the message goes through it.
        cloth.kick(inside, u, 0.08, 0.04);
        if (p.draws && revealed < 2 + inside) {
          revealed = 2 + inside;
          hooks.reveal(revealed);
        }
        if (p === lead) {
          const account = ACCOUNTS[inside] ?? "work";
          hooks.account(account);
          if (!p.draws) hooks.moment({ kind: "crossing", account });
        }
      }
      if (u > 1.1) {
        p.alive = false;
        if (p.draws) {
          frame.threadHead = 1.2;
          revealed = 4;
          hooks.reveal(4);
          hooks.moment({ kind: "drawn" });
        } else if (p === lead && p.curtain >= 0) {
          hooks.moment({ kind: "arrived", account: ACCOUNTS[p.curtain] ?? "personal", crossed: p.crossed });
        }
      }
    }
    writePulses();

    nextIdle -= dt;
    if (nextIdle <= 0 && intro >= 1 && revealed >= 4) {
      launch(-0.04, 0.85);
      hooks.moment({ kind: "sent", by: "idle" });
      nextIdle = (clock - pointer.movedAt < 8 ? 16 : 9) + Math.random() * 3;
    }
  };

  const tick = (now: number) => {
    raf = 0;
    if (disposed || !onScreen || document.hidden || !renderer || reduced) return;
    const dt = last ? Math.min(0.05, Math.max(0.001, (now - last) / 1000)) : 1 / 60;
    last = now;
    step(dt);
    draw();
    raf = requestAnimationFrame(tick);
  };

  function wake() {
    if (reduced || raf || disposed || !onScreen || document.hidden || !renderer) return;
    last = 0;
    raf = requestAnimationFrame(tick);
  }

  const locate = (event: PointerEvent) => {
    const box = root.getBoundingClientRect();
    pointer.u = (event.clientX - box.left) / Math.max(1, box.width);
    pointer.y = 1 - (event.clientY - box.top) / Math.max(1, box.height);
    if (!pointer.seen) {
      pointer.prevU = pointer.u;
      pointer.prevY = pointer.y;
      pointer.seen = true;
    }
    pointer.movedAt = clock;
  };

  const onMove = (event: PointerEvent) => {
    locate(event);
    pointer.inside = true;
  };

  const onLeave = () => {
    pointer.inside = false;
  };

  const send = (from: number, by: "you" | "idle") => {
    if (reduced) {
      // No travel with reduced motion: the message is simply shown in the next account.
      showStill((stillAt + 1) % CURTAINS);
      return;
    }
    if (!renderer || revealed < 4) return;
    launch(from, 1);
    hooks.moment({ kind: "sent", by });
    nextIdle = 14 + Math.random() * 4;
    wake();
  };

  const onDown = (event: PointerEvent) => {
    const target = event.target as Element | null;
    // The copy and its controls keep their own clicks.
    if (target?.closest("a, button, input, [data-copy]")) return;
    locate(event);
    if (!reduced && renderer) {
      for (let i = 0; i < CURTAINS; i++) cloth.kick(i, pointer.u, 0.16 * grip(i, pointer.u, pointer.y));
    }
    // The message leaves from where the thread passes under the press, or from its start.
    send(Math.max(-0.04, Math.min(0.9, pointer.u)), "you");
  };

  const onVisibility = () => {
    last = 0;
    wake();
  };

  const onMotion = () => {
    reduced = motion.matches;
    if (reduced) {
      cancelAnimationFrame(raf);
      raf = 0;
      showStill(1);
    } else {
      wake();
    }
  };

  const start = (): boolean => {
    renderer = createRenderer(gl, scene, font);
    if (!renderer) return false;
    renderer.setWeight(palette.light ? 600 : 500);
    resize();
    if (reduced) showStill(1);
    return true;
  };

  const onLost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(raf);
    raf = 0;
    renderer = null;
  };

  const onRestored = () => {
    if (disposed) return;
    cloth.reset();
    if (start()) wake();
  };

  const theme = new MutationObserver(() => {
    readPalette(palette, probe);
    renderer?.setWeight(palette.light ? 600 : 500);
    draw();
  });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  const sizes = new ResizeObserver(() => resize());
  sizes.observe(root);
  for (const el of calm) sizes.observe(el);
  const seen = new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    wake();
  });
  seen.observe(root);
  root.addEventListener("pointermove", onMove, { passive: true });
  root.addEventListener("pointerleave", onLeave, { passive: true });
  root.addEventListener("pointerdown", onDown, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  motion.addEventListener("change", onMotion);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  const cleanup = () => {
    disposed = true;
    cancelAnimationFrame(raf);
    theme.disconnect();
    sizes.disconnect();
    seen.disconnect();
    root.removeEventListener("pointermove", onMove);
    root.removeEventListener("pointerleave", onLeave);
    root.removeEventListener("pointerdown", onDown);
    document.removeEventListener("visibilitychange", onVisibility);
    motion.removeEventListener("change", onMotion);
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    renderer?.dispose();
    renderer = null;
  };

  // The glyphs come from the mono font: wait for it so the atlas is not drawn in a fallback.
  let begun = false;
  const begin = () => {
    if (disposed || begun) return;
    begun = true;
    if (!start()) {
      cleanup();
      hooks.failed();
      return;
    }
    canvas.dataset.ready = "true";
    wake();
  };
  const family = font.split(",")[0] ?? "monospace";
  void document.fonts
    .load(`500 64px ${family}`, GLYPHS.join(""))
    .catch(() => undefined)
    .then(begin);
  // Never wait long for a font.
  const fontTimer = setTimeout(begin, 1200);

  return {
    send: () => send(-0.04, "you"),
    attach(next) {
      labels = next;
      for (let i = 0; i < CURTAINS; i++) {
        const el = labels[i];
        // One layout read per name when they are attached, never per frame.
        if (el) labelHalf[i] = (el.offsetWidth / 2 + 10) / Math.max(1, view.width);
      }
      ride();
    },
    destroy() {
      if (disposed) return;
      clearTimeout(fontTimer);
      cleanup();
    },
  };
}
