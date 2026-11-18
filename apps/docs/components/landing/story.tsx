"use client";

import { createContext, type ReactNode, type RefObject, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { SectionId } from "./copy";

/** The tempo of the page: every stepped change lands on a multiple of this. */
export const BEAT = 125;

/* ---------------------------------------------------------------------------------------------
 * Narration: each scene says what just happened, and the rail repeats it for the section on
 * screen. A scene outside a provider (a docs page) narrates to nobody, without failing.
 * ------------------------------------------------------------------------------------------- */

interface Narration {
  lines: Partial<Record<SectionId, string>>;
  say(id: SectionId, line: string): void;
}

const NarrationContext = createContext<Narration | null>(null);

export function NarrationProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<Partial<Record<SectionId, string>>>({});
  const say = useCallback((id: SectionId, line: string) => {
    setLines((current) => (current[id] === line ? current : { ...current, [id]: line }));
  }, []);
  const value = useMemo(() => ({ lines, say }), [lines, say]);
  return <NarrationContext.Provider value={value}>{children}</NarrationContext.Provider>;
}

/** What a section last said, or undefined before its scene speaks. */
export function useLine(id: SectionId): string | undefined {
  return useContext(NarrationContext)?.lines[id];
}

/** Reports a scene's current line. Call it during render with the line for the current state. */
export function useNarrate(id: SectionId, line: string): void {
  const say = useContext(NarrationContext)?.say;
  useEffect(() => {
    say?.(id, line);
  }, [say, id, line]);
}

/* ---------------------------------------------------------------------------------------------
 * Reduced motion and visibility.
 * ------------------------------------------------------------------------------------------- */

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** True while at least `amount` of the element is on screen. */
export function useInView(ref: RefObject<Element | null>, amount = 0.45): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting)), { threshold: amount });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, amount]);
  return inView;
}

/* ---------------------------------------------------------------------------------------------
 * A story: a short sequence that plays once when the scene scrolls into view and rests on its
 * last step (the payoff). The reader can take over at any point; after a while of no input an
 * optional loop starts the story again.
 * ------------------------------------------------------------------------------------------- */

export interface StoryOptions {
  /** The element that must be on screen for the story to run. */
  ref: RefObject<Element | null>;
  /** How many steps the story has. The last one is the payoff. */
  steps: number;
  /** Beats each step lasts, one number for all or one per step. */
  beats?: number | number[];
  /** Start again this many beats after the payoff (or after the reader lets go). Omit to rest. */
  loopAfter?: number;
}

export interface Story {
  step: number;
  /** True while the story advances by itself. */
  playing: boolean;
  /** The reader picks a step: autoplay stops there. */
  go(step: number): void;
  /** Play again from the first step. */
  replay(): void;
}

export function useStory({ ref, steps, beats = 8, loopAfter }: StoryOptions): Story {
  const reduced = useReducedMotion();
  const inView = useInView(ref);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const started = useRef(false);
  const last = steps - 1;
  // Callers often pass the beats as an inline array: read it through a ref so a new array on
  // each render does not restart the step timer.
  const beatsRef = useRef(beats);
  beatsRef.current = beats;

  // Start once, the first time the scene is seen.
  useEffect(() => {
    if (!inView || started.current) return;
    started.current = true;
    if (reduced) setStep(last);
    else setPlaying(true);
  }, [inView, reduced, last]);

  // Advance while playing and visible.
  useEffect(() => {
    if (!playing || !inView) return;
    if (step >= last) {
      setPlaying(false);
      return;
    }
    const current = beatsRef.current;
    const length = (Array.isArray(current) ? (current[step] ?? 8) : current) * BEAT;
    const timer = setTimeout(() => setStep((s) => Math.min(s + 1, last)), length);
    return () => clearTimeout(timer);
  }, [playing, inView, step, last]);

  // Loop: after resting for a while, tell the story again.
  useEffect(() => {
    if (loopAfter === undefined || reduced || playing || !inView || !started.current) return;
    const timer = setTimeout(() => {
      setStep(0);
      setPlaying(true);
    }, loopAfter * BEAT);
    return () => clearTimeout(timer);
  }, [loopAfter, reduced, playing, inView, step]);

  const go = useCallback(
    (next: number) => {
      started.current = true;
      setPlaying(false);
      setStep(Math.max(0, Math.min(next, last)));
    },
    [last],
  );

  const replay = useCallback(() => {
    started.current = true;
    if (reduced) {
      setStep(last);
      return;
    }
    setStep(0);
    setPlaying(true);
  }, [reduced, last]);

  return { step, playing, go, replay };
}
