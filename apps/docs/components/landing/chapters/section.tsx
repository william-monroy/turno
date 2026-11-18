"use client";

import Link from "next/link";
import {
  type ComponentType,
  createContext,
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { localePath } from "@/lib/layout.shared";
import type { Headline, Lang, SectionCopy, StoryId } from "../copy";
import { BEAT, useNarrate, useReducedMotion } from "../story";
import s from "./section.module.css";

/*
 * The calmer section: a text column (label, headline, lead), then the section's commands as a
 * short list beside one picture. Choosing a command runs it in the picture; a single line under
 * the picture says what was typed and what came of it, and that line is also the narration.
 * On wide, tall screens the picture stays in view while the scroll steps through the commands;
 * a click always works and the scroll is never held.
 */

/** One entry of the list: what the reader can choose, run and (usually) copy. */
export interface ChapterCommand {
  run: string;
  note: string;
  /** What stands before it: "$" a shell, ">" Claude Code's prompt, "tool" a tool call. */
  prompt: string;
  /** False for something the reader does not type themselves, such as a tool call. */
  copyable?: boolean;
}

/** The line under the picture: what was typed, and once it has run, what came of it. */
export interface OutLine {
  prompt: string;
  cmd: string;
  result?: string;
}

export interface PictureProps {
  lang: Lang;
  /** The command on screen, by index. */
  chosen: number;
  /** Counts runs: every choice, even of the same command, plays it again. 0 before the first. */
  run: number;
  /** False until the section is first seen: the picture then draws itself once. */
  drawn: boolean;
  /** True once the page knows whether to hide things before they draw (after hydration). */
  armed: boolean;
  reduced: boolean;
  say(line: OutLine): void;
}

/** How many beats the picture takes to draw itself before the first command runs. */
export const DRAW_BEATS = 9;

/**
 * The first chapter draws itself in full; by the second the reader knows the gesture, so the
 * rest draw in fewer beats. Still whole beats: only the count changes, never the tempo.
 */
const BRISK_BEATS = 5;

const DrawBeats = createContext(DRAW_BEATS);

/**
 * The beats this chapter's picture takes to draw itself: DRAW_BEATS in the first chapter, fewer
 * later. A picture with its own draw-in can pace it by this; the first command runs right after.
 */
export function useDrawBeats(): number {
  return useContext(DrawBeats);
}

/** How far the reader scrolls, as a share of the viewport height, to step to the next command. */
const STEP = 0.3;

/** The header over the page, in px: a pinned body centers in the screen under it. */
const HEADER = 56;

export function Chapter({
  id,
  n,
  lang,
  copy,
  commands,
  Picture,
  labels,
  scrollSteps,
  quiet = false,
}: {
  id: StoryId;
  n: number;
  lang: Lang;
  copy: SectionCopy;
  commands: ChapterCommand[];
  Picture: ComponentType<PictureProps>;
  labels: { list: string; copy: string; copied: string; figure: string };
  /** Let the scroll step through the commands on wide, tall screens. */
  scrollSteps: boolean;
  /** A secondary chapter: tighter and smaller, and never pinned (its commands are chosen by hand). */
  quiet?: boolean;
}) {
  const reduced = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const figureRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLDivElement>(null);

  const [armed, setArmed] = useState(false);
  const headIn = useSeenOnce(headRef, 0.15);
  const sideIn = useSeenOnce(sideRef, 0.15);
  const drawn = useSeenOnce(figureRef, 0.2);
  const current = useCurrent(sectionRef);
  const [chosen, setChosen] = useState(0);
  const [run, setRun] = useState(0);
  const [line, setLine] = useState<OutLine | null>(null);
  const brisk = n > 1;
  const drawBeats = brisk ? BRISK_BEATS : DRAW_BEATS;

  // Hide what has not drawn yet only once React runs: without it the page shows everything.
  useEffect(() => {
    setArmed(true);
    keeper.start();
  }, []);

  // The first command runs by itself once the picture has drawn.
  useEffect(() => {
    if (!drawn || run > 0) return;
    const timer = setTimeout(() => setRun((r) => (r === 0 ? 1 : r)), reduced ? 0 : drawBeats * BEAT);
    return () => clearTimeout(timer);
  }, [drawn, run, reduced, drawBeats]);

  const choose = useCallback((index: number) => {
    setChosen(index);
    setRun((r) => r + 1);
  }, []);

  const pin = usePin({ id, enabled: scrollSteps && !quiet, steps: commands.length, onStep: choose, chosen, reduced });

  // The reader's own choice (click, tap, keys). When pinned, the scroll moves to that command's
  // stretch too, so the next nudge of the wheel continues from it instead of overriding it.
  const pick = useCallback(
    (index: number) => {
      choose(index);
      pin.align(index);
    },
    [choose, pin.align],
  );

  const say = useCallback((next: OutLine) => {
    setLine((current) => (current && current.cmd === next.cmd && current.result === next.result && current.prompt === next.prompt ? current : next));
  }, []);

  useNarrate(id, line?.result ?? copy.rest);

  const notePad = useNotePad(notesRef, commands, chosen);

  const onKey = (event: KeyboardEvent<HTMLOListElement>) => {
    const last = commands.length - 1;
    const to = event.key === "ArrowDown" ? Math.min(chosen + 1, last) : event.key === "ArrowUp" ? Math.max(chosen - 1, 0) : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (to === null) return;
    event.preventDefault();
    if (to !== chosen) pick(to);
    listRef.current?.querySelectorAll<HTMLButtonElement>("[data-choose]")[to]?.focus();
  };

  const state = !armed || reduced ? "still" : "armed";
  const number = String(n).padStart(2, "0");

  return (
    <section
      ref={sectionRef}
      id={id}
      className={s.chapter}
      aria-labelledby={`${id}-title`}
      data-state={state}
      data-pace={brisk ? "brisk" : "full"}
      data-quiet={quiet || undefined}
      data-flip={n % 2 === 0 || undefined}
      data-current={current || undefined}
    >
      <div ref={headRef} className={`t-wrap ${s.head}`} data-play={headIn || undefined}>
        <p className={`t-label ${s.label}`}>
          {/* On wide screens the number hangs on the thread in the gutter instead. */}
          <span aria-hidden className={s.knot}>
            {number}
          </span>
          <span className={s.num}>
            <span className={s.n}>{number}</span> ·{" "}
          </span>
          {copy.label}
        </p>
        <SetHeadline id={`${id}-title`} parts={copy.headline} />
        <p className={`t-lead ${s.lead}`}>{copy.lead}</p>
      </div>

      <div ref={pin.trackRef} className={s.track} data-pinned={pin.on || undefined} style={pin.style}>
        {pin.bands}
        <div ref={pin.bodyRef} className={`t-wrap ${s.body}`}>
          <div ref={sideRef} className={s.side} data-play={sideIn || undefined}>
            <ol ref={listRef} className={s.list} aria-label={labels.list} onKeyDown={onKey} style={{ "--note-pad": `${notePad}px` } as CSSProperties}>
              {commands.map((command, index) => (
                <Row key={command.run} command={command} index={index} chosen={index === chosen} labels={labels} onChoose={pick} />
              ))}
            </ol>
            {/* Every note, laid out unseen at the list's width: the list keeps room for the longest. */}
            <div ref={notesRef} aria-hidden className={s.measure}>
              {commands.map((command) => (
                <p key={command.run} className={s.note}>
                  {command.note}
                </p>
              ))}
            </div>
            {copy.aside ? (
              <p className={s.aside}>
                <Tokens text={copy.aside} />
              </p>
            ) : null}
            <Link href={localePath(lang, copy.more.href)} className={s.more}>
              {copy.more.text} <span aria-hidden>→</span>
            </Link>
          </div>

          <div className={s.picture}>
            <div ref={figureRef} className={s.figure} role="group" aria-label={labels.figure}>
              <DrawBeats.Provider value={drawBeats}>
                <Picture lang={lang} chosen={chosen} run={run} drawn={drawn} armed={state === "armed"} reduced={reduced} say={say} />
              </DrawBeats.Provider>
            </div>
            <Out line={line} rest={copy.rest} drawn={drawn} />
          </div>
        </div>
      </div>
    </section>
  );
}

/* The list ------------------------------------------------------------------------------------ */

function Row({ command, index, chosen, labels, onChoose }: { command: ChapterCommand; index: number; chosen: boolean; labels: { copy: string; copied: string }; onChoose(index: number): void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    void navigator.clipboard?.writeText(command.run).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <li className={s.row} data-chosen={chosen || undefined} style={{ "--i": index } as CSSProperties}>
      <div className={s.rowLine}>
        <button type="button" data-choose className={s.choose} aria-pressed={chosen} tabIndex={chosen ? 0 : -1} onClick={() => onChoose(index)}>
          <span aria-hidden className={s.prompt}>
            {command.prompt}
          </span>
          <code className={s.cmd}>
            <Tokens text={command.run} />
          </code>
        </button>
        {chosen && command.copyable !== false ? (
          <button type="button" className={s.copy} onClick={copy} aria-label={`${labels.copy}: ${command.run}`}>
            <span aria-live="polite">{copied ? labels.copied : labels.copy}</span>
          </button>
        ) : null}
      </div>
      {chosen ? <p className={s.note}>{command.note}</p> : null}
    </li>
  );
}

/** A command that wraps only between its words, never inside a flag like `--fork`. */
function Tokens({ text }: { text: string }) {
  return (
    <>
      {text.split(" ").map((token, index) => (
        // Words of a fixed string: their order never changes. The space stays outside the word,
        // where the line may break.
        <Fragment key={index}>
          {index > 0 ? " " : null}
          <span className={s.token}>{token}</span>
        </Fragment>
      ))}
    </>
  );
}

/**
 * The room the list keeps under its rows: the longest note minus the chosen one. With it the
 * list is as tall whichever command is chosen, so nothing under it moves when a note changes
 * and a pinned body keeps its size. Measured on the unseen copies, again when their width changes.
 */
function useNotePad(ref: RefObject<HTMLDivElement | null>, commands: ChapterCommand[], chosen: number): number {
  const [heights, setHeights] = useState<number[]>([]);
  const key = commands.map((command) => command.note).join("\n");
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !key) return;
    const measure = () => {
      const next = Array.from(node.children, (child) => (child as HTMLElement).offsetHeight);
      setHeights((current) => (current.length === next.length && current.every((h, i) => h === next[i]) ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, key]);
  if (heights.length === 0) return 0;
  return Math.max(0, Math.max(...heights) - (heights[chosen] ?? 0));
}

/* The line under the picture ------------------------------------------------------------------ */

function Out({ line, rest, drawn }: { line: OutLine | null; rest: string; drawn: boolean }) {
  if (!line) {
    return (
      <p className={s.out} data-play={drawn || undefined}>
        <span aria-hidden className={s.outPrompt}>
          #
        </span>
        <span className={s.outRest}>{rest}</span>
      </p>
    );
  }
  const chars = Math.max(6, Math.min(line.cmd.length, 60));
  return (
    <p className={s.out} aria-live="polite" data-play>
      <span aria-hidden className={s.outPrompt}>
        {line.prompt}
      </span>
      <span key={line.cmd} className={s.outCmd} style={{ "--n": chars } as CSSProperties}>
        {line.cmd}
      </span>
      {line.result ? (
        <span key={line.result} className={s.outResult}>
          <span aria-hidden className={s.outArrow}>
            →
          </span>
          {line.result}
        </span>
      ) : null}
    </p>
  );
}

/* The headline, set line by line --------------------------------------------------------------- */

/**
 * The headline's words, each in a span that knows its line (measured once laid out, and again on
 * resize), so the lines can set in one per beat.
 */
function SetHeadline({ id, parts }: { id: string; parts: Headline }) {
  const ref = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      let line = -1;
      let top = Number.NEGATIVE_INFINITY;
      for (const word of node.querySelectorAll<HTMLElement>("[data-w]")) {
        if (word.offsetTop > top + 4) {
          line += 1;
          top = word.offsetTop;
        }
        word.style.setProperty("--l", String(line));
      }
      node.parentElement?.style.setProperty("--lines", String(line + 1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const [before, mark, after] = parts;
  return (
    <h2 ref={ref} id={id} className={`t-h2 ${s.headline}`}>
      <Words text={before} />
      <Words text={mark} mark />
      <Words text={after} />
    </h2>
  );
}

function Words({ text, mark = false }: { text: string; mark?: boolean }) {
  // Keep the spaces as text between the words so the browser still breaks and balances lines.
  return (
    <>
      {text.split(/(\s+)/).map((piece, index) =>
        piece.trim() === "" ? (
          piece
        ) : (
          // Pieces of a fixed string: their order never changes.
          <span key={index} data-w className={`${s.word} ${mark ? "t-mark" : ""}`}>
            {piece}
          </span>
        ),
      )}
    </>
  );
}

/* Seen once, and current ------------------------------------------------------------------------ */

/**
 * True from the first time the element reaches a line `share` of the way up from the bottom of the
 * viewport, and then for good. A line, not a visible fraction: a tall element on a short screen
 * still crosses it.
 */
function useSeenOnce(ref: RefObject<Element | null>, share: number): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || seen) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: `0px 0px -${Math.round(share * 100)}% 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, share, seen]);
  return seen;
}

/** True while the section holds the middle of the screen: its number on the thread is lit. */
function useCurrent(ref: RefObject<Element | null>): boolean {
  const [current, setCurrent] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setCurrent(Boolean(entry?.isIntersecting)), { rootMargin: "-50% 0px -50% 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return current;
}

/* Following the URL's hash ---------------------------------------------------------------------- */

/*
 * The browser jumps to the URL's hash before the chapters pin (pinning makes their tracks taller
 * and moves everything below) and before the webfonts change line heights. Each of those settles
 * the page again, and the jump is made again on the next frame, until the reader touches the page
 * or a few seconds pass. One keeper for the whole page, so eight chapters do not jump eight times.
 */
const keeper = (() => {
  const inputs = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  let startedAt = Number.NEGATIVE_INFINITY;
  let done = true;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const end = () => {
    done = true;
    cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(timer);
    for (const type of inputs) window.removeEventListener(type, end, true);
  };

  const follow = () => {
    frame = 0;
    const name = decodeURIComponent(window.location.hash.slice(1));
    const target = name ? document.getElementById(name) : null;
    if (!target) return;
    if (target.dataset.band === undefined) {
      target.scrollIntoView({ block: "start", behavior: "instant" });
      return;
    }
    // A link to a step lands with the middle of the screen in the middle of its stretch, and
    // chooses it: the band may already have been under the middle before the jump.
    const box = target.getBoundingClientRect();
    const into = Math.min(Number(target.dataset.step) / 2, box.height / 2);
    window.scrollTo({ top: Math.round(window.scrollY + box.top + into - window.innerHeight / 2), behavior: "instant" });
    target.dispatchEvent(new Event("turno-step"));
  };

  return {
    /** A page with chapters has mounted: keep following the hash for a while. */
    start() {
      // Every chapter calls this as it mounts; one page view starts the keeper once.
      if (performance.now() - startedAt < 5000) return;
      startedAt = performance.now();
      done = false;
      for (const type of inputs) window.addEventListener(type, end, { capture: true, passive: true });
      timer = setTimeout(end, 4000);
    },
    /** The layout changed: jump to the hash again on the next frame. */
    settle() {
      if (done || !window.location.hash) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(follow);
    },
    /** True while a jump is pending: a step seen now is about to be wrong. */
    pending() {
      return frame !== 0;
    },
  };
})();

/* Scroll steps ---------------------------------------------------------------------------------- */

interface Pin {
  on: boolean;
  trackRef: RefObject<HTMLDivElement | null>;
  bodyRef: RefObject<HTMLDivElement | null>;
  style: CSSProperties | undefined;
  bands: ReactNode;
  /** Moves the scroll to a command's stretch while pinned; does nothing otherwise. */
  align(step: number): void;
}

/**
 * On a wide, tall screen the list and the picture stay in place for a few screens of scroll, and
 * each stretch of that scroll chooses one command. Invisible bands, one per command, tile the
 * stretch; the band under the middle of the viewport is the step. A choice by hand glides the
 * scroll to its stretch (the body stays pinned; only the page around it moves), so scroll and
 * choice always agree. Nothing stops the page from scrolling on past the last one.
 */
function usePin({ id, enabled, steps, onStep, chosen, reduced }: { id: string; enabled: boolean; steps: number; onStep(step: number): void; chosen: number; reduced: boolean }): Pin {
  const trackRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<{ body: number; top: number; step: number } | null>(null);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const bandRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lastBand = useRef(0);
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;
  // True while the scroll glides to a step chosen by hand: the bands it passes do not choose.
  const gliding = useRef(false);

  // Measure the body and the viewport; pin only when the body fits under the header. Where it
  // pins and how long a step is depend on the viewport alone: if a content change moved the
  // bands, the line in the middle of the screen could land in the neighbor's band, choose it and
  // change the content back, a loop. So a content change only updates the track's height.
  useEffect(() => {
    const body = bodyRef.current;
    if (!enabled || !body) {
      setGeometry(null);
      return;
    }
    const wide = matchMedia("(min-width: 1024px) and (min-height: 700px)");
    const layout = () => {
      const height = body.offsetHeight;
      const viewport = window.innerHeight;
      const top = Math.max(HEADER + 16, Math.round((viewport + HEADER - height) / 2));
      if (!wide.matches || top + height > viewport - 16) setGeometry(null);
      else setGeometry({ body: height, top, step: Math.round(viewport * STEP) });
      keeper.settle();
    };
    const grow = () => setGeometry((current) => (current && current.body !== body.offsetHeight ? { ...current, body: body.offsetHeight } : current));
    layout();
    let cancelled = false;
    // Webfonts change line heights once: lay out again when they are in.
    document.fonts?.ready.then(() => {
      if (!cancelled) layout();
    });
    const observer = new ResizeObserver(grow);
    observer.observe(body);
    window.addEventListener("resize", layout);
    wide.addEventListener("change", layout);
    return () => {
      cancelled = true;
      observer.disconnect();
      window.removeEventListener("resize", layout);
      wide.removeEventListener("change", layout);
    };
  }, [enabled]);

  // The band crossing the middle of the viewport is the step.
  useEffect(() => {
    if (!geometry) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const band = Number((entry.target as HTMLElement).dataset.band);
          if (gliding.current) continue;
          if (keeper.pending()) {
            // The page is about to jump to the hash: forget this band rather than choose it.
            lastBand.current = -1;
            continue;
          }
          if (band === lastBand.current) continue;
          lastBand.current = band;
          if (band !== chosenRef.current) onStepRef.current(band);
        }
      },
      { rootMargin: "-50% 0px -50% 0px" },
    );
    const landed = (event: Event) => {
      const band = Number((event.target as HTMLElement).dataset.band);
      lastBand.current = band;
      if (band !== chosenRef.current) onStepRef.current(band);
    };
    const nodes = bandRefs.current.filter((node): node is HTMLDivElement => Boolean(node));
    for (const node of nodes) {
      observer.observe(node);
      node.addEventListener("turno-step", landed);
    }
    return () => {
      observer.disconnect();
      for (const node of nodes) node.removeEventListener("turno-step", landed);
    };
  }, [geometry]);

  const align = useCallback(
    (step: number) => {
      const track = trackRef.current;
      const g = geometryRef.current;
      if (!track || !g) return;
      // The scroll at which the body pins, and the stretch it stays pinned for.
      const start = track.getBoundingClientRect().top + window.scrollY - g.top;
      const room = (steps - 1) * g.step;
      const y = window.scrollY;
      // Before it pins or after it lets go a jump would show: leave the scroll alone.
      if (y < start - 1 || y > start + room + 1) return;
      const target = Math.round(start + step * g.step);
      lastBand.current = step;
      if (Math.abs(target - y) < 2) return;
      if (reduced) {
        window.scrollTo({ top: target, behavior: "instant" });
        return;
      }
      gliding.current = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        gliding.current = false;
        clearTimeout(timer);
        window.removeEventListener("scrollend", done);
      };
      window.addEventListener("scrollend", done);
      // A browser without scrollend, or a glide the reader interrupts: give the bands back anyway.
      timer = setTimeout(done, 1200);
      window.scrollTo({ top: target, behavior: "smooth" });
    },
    [steps, reduced],
  );

  if (!geometry) return { on: false, trackRef, bodyRef, style: undefined, bands: null, align };

  const { body, top, step } = geometry;
  // The scroll the body stays pinned for: half a step before the second command, then one step
  // per command, and half a step of rest on the last.
  const room = (steps - 1) * step;
  const middle = `calc(50vh - ${top}px)`;
  const bands = Array.from({ length: steps }, (_, index) => {
    const start = index === 0 ? "0px" : `calc(${(index - 0.5) * step}px + ${middle})`;
    const end = index === steps - 1 ? "100%" : `calc(${(index + 0.5) * step}px + ${middle})`;
    return (
      <div
        key={index}
        ref={(node) => {
          bandRefs.current[index] = node;
        }}
        aria-hidden
        id={`${id}-step-${index}`}
        className={s.band}
        data-band={index}
        data-step={step}
        style={{ top: start, height: `calc(${end} - ${start})` }}
      />
    );
  });
  return {
    on: true,
    trackRef,
    bodyRef,
    style: { "--body": `${body}px`, "--room": `${room}px`, "--pin-top": `${top}px` } as CSSProperties,
    bands,
    align,
  };
}
