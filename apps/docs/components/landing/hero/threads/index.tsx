"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useNarrate } from "../../story";
import { HeroActions, HeroDemo, HeroEyebrow, HeroHook, HeroLead, HeroTitle } from "../parts";
import { type Engine, type Moment, type Placement, startThreads } from "./engine";
import { ACCOUNTS, type Account, TONES } from "./layout";
import s from "./threads.module.css";

interface HeroProps {
  lang: "en" | "es";
}

/** The conversation the thread is. The same id as the conversation in the story below. */
const SESSION = "7f3c9a2e";

interface Words {
  send: string;
  start: string;
  drawn: string;
  sent(by: "you" | "idle"): string;
  crossing(account: Account): string;
  arrived(account: Account, crossed: number): string;
  parted(account: Account): string;
  still(account: Account): string;
}

// Every line fits the rail at 1280 pixels in both languages: under 50 characters.
const TEXT: Record<"en" | "es", Words> = {
  en: {
    send: `Send a message along conversation ${SESSION}`,
    start: `${SESSION}: one conversation`,
    drawn: `${SESSION} runs through work, client and personal`,
    sent: (by) => (by === "you" ? `you sent a message along ${SESSION}` : `a message travels along ${SESSION}`),
    crossing: (a) => `crossing ${a}: still blue, still ${SESSION}`,
    arrived: (a, n) => `reached ${a} unchanged, across ${n} ${n === 1 ? "account" : "accounts"}`,
    parted: (a) => `you moved ${a}; the thread stayed put`,
    still: (a) => `a message inside ${a}, still blue`,
  },
  es: {
    send: `Enviar un mensaje por la conversación ${SESSION}`,
    start: `${SESSION}: una conversación`,
    drawn: `${SESSION} pasa por work, client y personal`,
    sent: (by) => (by === "you" ? `enviaste un mensaje por ${SESSION}` : `un mensaje viaja por ${SESSION}`),
    crossing: (a) => `cruza ${a}: sigue azul, sigue siendo ${SESSION}`,
    arrived: (a, n) => `llegó a ${a} sin cambiar, tras ${n} ${n === 1 ? "cuenta" : "cuentas"}`,
    parted: (a) => `moviste ${a}; el hilo no se movió`,
    still: (a) => `un mensaje dentro de ${a}, sigue azul`,
  },
};

function lineFor(moment: Moment, t: Words): string {
  switch (moment.kind) {
    case "drawn":
      return t.drawn;
    case "sent":
      return t.sent(moment.by);
    case "crossing":
      return t.crossing(moment.account);
    case "arrived":
      return t.arrived(moment.account, moment.crossed);
    case "parted":
      return t.parted(moment.account);
    case "still":
      return t.still(moment.account);
  }
}

/**
 * The threads hero. Accounts are curtains of light, drawn in glyphs and moved by the pointer like
 * cloth; the conversation is one blue thread that runs through all of them and never changes.
 * A press sends a message along it, from curtain to curtain, still blue in each.
 */
export default function Hero({ lang }: HeroProps) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const words = useRef<HTMLDivElement>(null);
  const tools = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const labels = useRef<(HTMLSpanElement | null)[]>([]);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [failed, setFailed] = useState(false);
  const t = TEXT[lang];
  const [line, setLine] = useState(t.start);
  useNarrate("hero", line);

  useEffect(() => {
    const host = root.current;
    const surface = canvas.current;
    if (!host || !surface) return;
    const text = TEXT[lang];
    const calm = [words.current, tools.current].filter((el): el is HTMLDivElement => Boolean(el));
    // The conversation starts under work; the account follows the message from there.
    document.documentElement.dataset.account = "work";
    const started = startThreads(host, surface, calm, {
      placed: setPlacement,
      reveal: setRevealed,
      account(account) {
        document.documentElement.dataset.account = account;
      },
      moment(moment) {
        setLine(lineFor(moment, text));
      },
      failed() {
        setFailed(true);
        setRevealed(0);
      },
    });
    if (!started) setFailed(true);
    engine.current = started;
    return () => {
      started?.destroy();
      engine.current = null;
      delete document.documentElement.dataset.account;
    };
  }, [lang]);

  // The names ride their hems once they exist; the engine moves them, React only places them.
  useEffect(() => {
    if (placement) engine.current?.attach(labels.current);
  }, [placement]);

  // Without WebGL2 the picture is a still drawing; the copy and the controls stay the same.
  useEffect(() => {
    if (!failed) return;
    document.documentElement.dataset.account = "personal";
    setLine(t.drawn);
  }, [failed, t]);

  return (
    <div ref={root} className={s.root} data-lang={lang} data-failed={failed || undefined}>
      <canvas ref={canvas} className={s.canvas} aria-hidden />
      {failed ? <Still /> : null}
      {placement && !failed ? (
        <div className={s.labels} aria-hidden>
          {placement.curtains.map((curtain, i) => (
            <span
              key={curtain.account}
              ref={(el) => {
                labels.current[i] = el;
              }}
              className={s.label}
              data-on={revealed >= 2 + i || undefined}
              style={{ left: curtain.x, top: curtain.y, "--label-tone": `var(--tone-${TONES[i]})` } as CSSProperties}
            >
              {curtain.account}
            </span>
          ))}
        </div>
      ) : null}
      <div className={`t-wrap ${s.copy}`}>
        <div ref={words} className={s.words}>
          <HeroTitle lang={lang} className={s.title} />
          <HeroHook lang={lang} className={s.hook} />
          <HeroLead lang={lang} className={s.lead} />
        </div>
        <div ref={tools} className={s.tools}>
          <HeroDemo lang={lang} className={s.demo} />
          <HeroActions lang={lang} className={s.actions} />
        </div>
        <HeroEyebrow lang={lang} className={s.eyebrow} />
      </div>
      {/* After the copy in the tab order: the picture's one control comes after the page's own. */}
      {placement && !failed ? (
        <button
          type="button"
          className={s.session}
          data-on={revealed >= 1 || undefined}
          data-below={placement.session.below || undefined}
          style={{ left: placement.session.x, top: placement.session.y }}
          onClick={() => engine.current?.send()}
          aria-label={t.send}
          title={t.send}
        >
          <span aria-hidden className={s.node} />
          {SESSION}
        </button>
      ) : null}
    </div>
  );
}

/** The picture without WebGL2: three curtains of strokes, one in each account's tone, and the thread. */
function Still() {
  return (
    <div className={s.still} aria-hidden>
      {ACCOUNTS.map((account, i) => (
        <span key={account} className={s.stillCurtain} data-i={i} style={{ "--label-tone": `var(--tone-${TONES[i]})` } as CSSProperties} />
      ))}
      <svg className={s.stillThread} viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d="M0 10 C 30 13, 60 22, 100 50" fill="none" stroke="var(--tone-keep)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
