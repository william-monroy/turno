import { describe, expect, it } from "vitest";
import {
  MAX_TYPED,
  Rng,
  clickTiming,
  hashSeed,
  keyDelays,
  moveDuration,
  personaFor,
  pickPoint,
  planMove,
  planTime,
  planWheel,
} from "../src/humanize.js";

/** The planning half of human-like input: pure, and the same plan for the same seed. */

const persona = personaFor(1);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe("the random source and the persona", () => {
  it("gives the same numbers for the same seed and different ones for another", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
    for (const x of seqA) expect(x >= 0 && x < 1).toBe(true);
  });

  it("keeps one persona per seed, within human ranges", () => {
    expect(personaFor(hashSeed("work"))).toEqual(personaFor(hashSeed("work")));
    expect(hashSeed("work")).not.toBe(hashSeed("school"));
    for (let seed = 0; seed < 50; seed++) {
      const p = personaFor(seed);
      expect(p.speed).toBeGreaterThanOrEqual(0.85);
      expect(p.speed).toBeLessThanOrEqual(1.2);
      expect(p.keyMs).toBeGreaterThanOrEqual(120);
      expect(p.keyMs).toBeLessThanOrEqual(190);
    }
  });
});

describe("planMove", () => {
  const from = { x: 100, y: 100 };
  const to = { x: 600, y: 400 };

  it("is repeatable with a seed, ends exactly on the target and travels in many small steps", () => {
    for (const level of ["light", "full"] as const) {
      const a = planMove(from, to, 40, level, new Rng(7), persona);
      const b = planMove(from, to, 40, level, new Rng(7), persona);
      expect(a).toEqual(b);
      expect(a.at(-1)).toMatchObject(to);
      expect(a.length).toBeGreaterThan(8);
      // No jump: consecutive points are close (a teleport would be the whole 583 px).
      let prev = from;
      for (const s of a) {
        expect(Math.hypot(s.x - prev.x, s.y - prev.y)).toBeLessThan(150);
        prev = s;
      }
    }
  });

  it("bends: the path leaves the straight line", () => {
    const steps = planMove(from, to, 40, "light", new Rng(3), persona);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    const off = Math.max(...steps.map((s) => Math.abs((s.x - from.x) * dy - (s.y - from.y) * dx) / len));
    expect(off).toBeGreaterThan(5);
  });

  it("light never goes past the target; full overshoots and corrects on long moves", () => {
    const ux = (to.x - from.x) / Math.hypot(to.x - from.x, to.y - from.y);
    const uy = (to.y - from.y) / Math.hypot(to.x - from.x, to.y - from.y);
    const past = (s: { x: number; y: number }) => (s.x - to.x) * ux + (s.y - to.y) * uy;
    let overshoots = 0;
    for (let seed = 0; seed < 40; seed++) {
      const light = planMove(from, to, 40, "light", new Rng(seed), persona);
      expect(Math.max(...light.map(past))).toBeLessThan(2);
      if (Math.max(...planMove(from, to, 40, "full", new Rng(seed), persona).map(past)) > 5) overshoots++;
    }
    expect(overshoots).toBeGreaterThan(15);
    // A short move never overshoots.
    for (let seed = 0; seed < 20; seed++) {
      const short = planMove(from, { x: 180, y: 140 }, 40, "full", new Rng(seed), persona);
      const u = { x: 80 / Math.hypot(80, 40), y: 40 / Math.hypot(80, 40) };
      expect(Math.max(...short.map((s) => (s.x - 180) * u.x + (s.y - 140) * u.y))).toBeLessThan(3);
    }
  });

  it("takes human time: about 0.1-0.4 s light, Fitts' law for full (longer for far and small targets)", () => {
    const light = planTime(planMove(from, to, 40, "light", new Rng(1), personaFor(5)));
    expect(light).toBeGreaterThan(80);
    expect(light).toBeLessThan(560);
    // The published reference: 630 px to a 20 px target takes a person about 750-850 ms.
    const far = mean(Array.from({ length: 20 }, (_, i) => moveDuration(630, 20, "full", new Rng(i))));
    expect(far).toBeGreaterThan(600);
    expect(far).toBeLessThan(1000);
    const near = mean(Array.from({ length: 20 }, (_, i) => moveDuration(100, 80, "full", new Rng(i))));
    expect(near).toBeLessThan(far / 2);
    expect(planMove(to, to, 40, "full", new Rng(1), persona)).toEqual([]);
  });
});

describe("pickPoint and clickTiming", () => {
  it("lands inside the target, off its exact center and away from its edges", () => {
    const box = { x: 10, y: 20, width: 100, height: 30 };
    const rng = new Rng(11);
    let centered = 0;
    for (let i = 0; i < 200; i++) {
      const p = pickPoint(box, rng);
      expect(p.x).toBeGreaterThanOrEqual(box.x + 20);
      expect(p.x).toBeLessThanOrEqual(box.x + 80);
      expect(p.y).toBeGreaterThanOrEqual(box.y + 7.5);
      expect(p.y).toBeLessThanOrEqual(box.y + 22.5);
      if (p.x === 60 && p.y === 35) centered++;
    }
    expect(centered).toBe(0);
  });

  it("holds the button down for tens of milliseconds", () => {
    const rng = new Rng(2);
    for (let i = 0; i < 50; i++) {
      const light = clickTiming("light", rng);
      expect(light.press).toBeGreaterThanOrEqual(40);
      expect(light.press).toBeLessThanOrEqual(90);
      const full = clickTiming("full", rng);
      expect(full.press).toBeGreaterThanOrEqual(45);
      expect(full.press).toBeLessThanOrEqual(170);
      expect(full.beforePress).toBeGreaterThanOrEqual(60);
    }
  });
});

describe("keyDelays", () => {
  it("gives one human delay per character, never the impossible few milliseconds", () => {
    const text = "hello world, again";
    for (const level of ["light", "full"] as const) {
      const d = keyDelays(text, level, new Rng(4), persona);
      expect(d).toHaveLength([...text].length);
      expect(Math.min(...d)).toBeGreaterThan(40);
      expect(keyDelays(text, level, new Rng(4), persona)).toEqual(d);
    }
    expect([...keyDelays("ñandú", "light", new Rng(1), persona)]).toHaveLength(5);
  });

  it("is slower across a space than inside a word with full", () => {
    const text = "ab cd ef gh ij kl mn op qr st uv wx yz ".repeat(3);
    const d = keyDelays(text, "full", new Rng(9), persona);
    const chars = [...text];
    const afterSpace = d.filter((_, i) => i > 0 && chars[i - 1] === " ");
    const inWord = d.filter((_, i) => i > 0 && chars[i - 1] !== " ");
    expect(mean(afterSpace)).toBeGreaterThan(mean(inWord) + 40);
  });

  it("types no more than MAX_TYPED characters (longer text is pasted)", () => {
    expect(MAX_TYPED).toBe(80);
  });
});

describe("planWheel", () => {
  it("breaks a scroll into notches of about 100 px that add up exactly", () => {
    const steps = planWheel(0, 1234, new Rng(5));
    expect(steps.length).toBe(12);
    expect(steps.reduce((s, x) => s + x.dy, 0)).toBe(1234);
    expect(steps.every((s) => s.dx === 0 && Math.abs(s.dy - 103) < 10)).toBe(true);
    expect(planWheel(0, -250, new Rng(5)).reduce((s, x) => s + x.dy, 0)).toBe(-250);
    expect(planWheel(0, 0, new Rng(5))).toEqual([]);
    // Bursts: some gaps are much longer than the others.
    const waits = steps.slice(1).map((s) => s.wait);
    expect(Math.max(...waits)).toBeGreaterThan(120);
    expect(Math.min(...waits)).toBeLessThan(75);
  });
});
