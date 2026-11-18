"use client";

import { type CSSProperties, type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { AccountPill, type Tone } from "../kit";
import { BEAT } from "../story";
import { useDrawBeats } from "./section";
import s from "./stage.module.css";

/*
 * The one picture every chapter draws on, shaped like the logo: sessions above, one blue bar
 * below. Two lanes, one per account (personal, work), each with its own login; under both, the
 * bar is what every profile keeps (the shared hub, turno's cache, the gateway). Things that
 * change account travel between the lanes; the bar never moves.
 */

export type Lane = 0 | 1;

/** The lanes' accounts, fixed for every chapter so a reader learns them once. */
export const LANES: [Tone, Tone] = ["personal", "work"];

/** How long a travel between lanes lasts, in beats. The crossing is at half of it. */
export const TRAVEL = 6;

/* A clock of phases -------------------------------------------------------------------------- */

/**
 * The phase of the run on screen: 0 when `key` changes, then one step every `beats[phase]` beats,
 * resting on the last. Before the first run, and with reduced motion, it does not tick: before
 * the first run it rests on 0, with reduced motion it jumps to the last phase.
 */
export function usePhase(key: string, beats: number[], live: boolean, reduced: boolean): number {
  const [state, setState] = useState({ key, phase: 0 });
  const beatsRef = useRef(beats);
  beatsRef.current = beats;

  useEffect(() => {
    const last = beatsRef.current.length - 1;
    if (!live) {
      setState({ key, phase: 0 });
      return;
    }
    if (reduced) {
      setState({ key, phase: last });
      return;
    }
    setState({ key, phase: 0 });
    let phase = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (phase >= last) return;
      timer = setTimeout(
        () => {
          phase += 1;
          setState({ key, phase });
          tick();
        },
        (beatsRef.current[phase] ?? 4) * BEAT,
      );
    };
    tick();
    return () => clearTimeout(timer);
  }, [key, live, reduced]);

  // A new key shows its first phase from the very first render, never the old run's phase.
  if (state.key !== key) return reduced && live ? beats.length - 1 : 0;
  return state.phase;
}

/** True for the beats the picture spends drawing itself, so remounts later never replay it. */
function useDrawing(drawn: boolean, reduced: boolean): boolean {
  const [drawing, setDrawing] = useState(false);
  // Fewer beats after the first chapter (see useDrawBeats); stage.module.css matches the count.
  const beats = useDrawBeats();
  useEffect(() => {
    if (!drawn || reduced) return;
    setDrawing(true);
    const timer = setTimeout(() => setDrawing(false), (beats + 2) * BEAT);
    return () => clearTimeout(timer);
  }, [drawn, reduced, beats]);
  return drawing;
}

/* The stage ---------------------------------------------------------------------------------- */

export interface StageProps {
  /** Which lanes hold a running session: their pill is filled, the other one is quiet. */
  active: [boolean, boolean];
  /** What each lane says under its account. */
  sub: [string, string];
  bar: { name: string; text: ReactNode; end?: ReactNode };
  /** Phase 0 of a run is a cut to its first state: nothing eases into it. */
  cut: boolean;
  drawn: boolean;
  armed: boolean;
  reduced: boolean;
  layerRef?: Ref<HTMLDivElement>;
  barRef?: Ref<HTMLDivElement>;
  /** What sits on the lanes. Optional: an empty stage (a picture still being built) is valid. */
  children?: ReactNode;
}

export function Stage({ active, sub, bar, cut, drawn, armed, reduced, layerRef, barRef, children }: StageProps) {
  const drawing = useDrawing(drawn, reduced);
  return (
    <div className={s.wrap}>
      <div className={s.stage} data-cut={cut || undefined} data-wait={(armed && !drawn) || undefined} data-drawing={drawing || undefined}>
        {LANES.map((tone, lane) => (
          <div key={tone} className={s.head} data-lane={lane}>
            <AccountPill tone={tone} quiet={!active[lane]}>
              {tone}
            </AccountPill>
            <span className={s.sub} style={{ color: `var(--tone-${tone})` }}>
              {sub[lane]}
            </span>
          </div>
        ))}
        <span aria-hidden className={s.divider} />
        {/* On a phone, an empty lane shows where things go (stage.module.css, .vacant). */}
        <span aria-hidden className={s.vacant} data-lane={0} />
        <span aria-hidden className={s.vacant} data-lane={1} />
        <div ref={layerRef} className={s.layer}>
          {children}
        </div>
        <div className={s.bar}>
          <div ref={barRef} aria-hidden className={s.barLine} />
          <p className={s.barCaption}>
            <span className={s.barName}>{bar.name}</span>
            <span className={s.barText}>{bar.text}</span>
            {bar.end ? <span className={s.barEnd}>{bar.end}</span> : null}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Where a thing sits: its lane, and how far down the lane, in px or any CSS length. */
export function place(lane: Lane, y: number | string = 0, more?: Record<string, string | number>): CSSProperties {
  return { "--lane": lane, "--y": typeof y === "number" ? `${y}px` : y, ...more } as CSSProperties;
}

/* The conversation --------------------------------------------------------------------------- */

export interface Turn {
  who: "user" | "agent";
  text: string;
  /** The account that ran the turn: a conversation remembers who said what, as whom. */
  tone: Tone;
}

/**
 * The conversation: the same card in every chapter. Its outline and id are blue because every
 * profile keeps it; each turn carries the tone of the account that ran it.
 */
export function Session({
  id,
  where,
  turns,
  lane,
  y = 0,
  travel = false,
  compact = false,
  quiet = false,
  peel = false,
  cardRef,
  children,
}: {
  id: string;
  where: string;
  turns: Turn[];
  lane: Lane;
  y?: number;
  /** True while it travels to another lane: it rises a little on the way, like a thing carried. */
  travel?: boolean;
  /** Only its id, when the chapter is about something else. */
  compact?: boolean;
  quiet?: boolean;
  /** A copy just lifted off its original, before it travels. */
  peel?: boolean;
  cardRef?: Ref<HTMLDivElement>;
  children?: ReactNode;
}) {
  return (
    <div ref={cardRef} className={s.mover} style={place(lane, y)} data-lane={lane} data-travel={travel || undefined} data-peel={peel || undefined}>
      <div className={s.card} data-quiet={quiet || undefined} data-compact={compact || undefined} data-draw="card">
        <div className={s.cardHead}>
          <span className={s.cardId}>{id}</span>
          <span className={s.cardWhere}>{where}</span>
        </div>
        {compact ? null : (
          <ol className={s.turns}>
            {turns.map((turn) => (
              <li key={turn.text} className={s.turn} data-who={turn.who} style={{ "--turn": `var(--tone-${turn.tone})` } as CSSProperties}>
                <span aria-hidden className={s.turnMark}>
                  {turn.who === "user" ? "›" : "●"}
                </span>
                <span className={s.turnText}>{turn.text}</span>
              </li>
            ))}
          </ol>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * A place, not a session: a dashed outline. Where a session will continue once its printed
 * command runs (blue), or where one was before it moved on (quiet).
 */
export function Place({ lane, label, quiet = false }: { lane: Lane; label: ReactNode; quiet?: boolean }) {
  return (
    <div className={`${s.mover} ${s.place}`} style={place(lane)} data-lane={lane} data-quiet={quiet || undefined}>
      <span>{label}</span>
    </div>
  );
}

/* Things other than sessions ---------------------------------------------------------------- */

/** A claude.ai artifact: its outline is the account that owns it. */
export function Artifact({ lane, y, tone, name, tag, travel = false }: { lane: Lane; y: number | string; tone: Tone; name: string; tag?: string; travel?: boolean }) {
  return (
    <div className={`${s.mover} ${s.artifact}`} style={{ ...place(lane, y), "--tone": `var(--tone-${tone})` } as CSSProperties} data-lane={lane} data-travel={travel || undefined}>
      <span aria-hidden className={s.page}>
        <i />
        <i />
        <i />
      </span>
      <span className={s.artifactName}>{name}</span>
      {tag ? <span className={s.artifactTag}>{tag}</span> : null}
    </div>
  );
}

/** The package between export and import: turno's cache, so blue. */
export function Package({ lane, y, label }: { lane: Lane; y: number | string; label: string }) {
  return (
    <div className={`${s.mover} ${s.package}`} style={place(lane, y)} data-lane={lane}>
      {label}
    </div>
  );
}

/** A service account that one profile reaches, such as a Linear workspace. */
export function Service({ lane, y, name, serviceRef }: { lane: Lane; y: number | string; name: string; serviceRef?: Ref<HTMLDivElement> }) {
  return (
    <div ref={serviceRef} className={`${s.mover} ${s.service}`} style={place(lane, y)} data-lane={lane} data-draw="object">
      <span aria-hidden className={s.serviceDot} />
      {name}
    </div>
  );
}

/** The class of the dot a call rides on; the picture that owns it animates it. */
export const DOT = s.dot;
