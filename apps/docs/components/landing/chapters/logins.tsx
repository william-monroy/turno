"use client";

import { type CSSProperties, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { landingCopy, type Lang } from "../copy";
import type { Tone } from "../kit";
import { BEAT } from "../story";
import { type ChapterCommand, DRAW_BEATS, type PictureProps } from "./section";
import { type Lane, place, Stage, TRAVEL, usePhase } from "./stage";
import s from "./logins.module.css";

/*
 * Chapter 2: remote MCP logins and secrets, as docs/concepts/gateway.mdx describes them ("Remote
 * servers", "One server, two accounts", "Secrets"). mcpd is the OAuth client of a server with
 * auth = "oauth", one login per variant (ADR 0029, cli/commands/mcp-oauth.ts); without variants
 * `turno mcp login linear` is the login every profile uses, kept in the secret store as
 * turno/oauth/linear@default (mcpd/oauth.ts, oauthService). A variant runs as its own process
 * with its own env, so a profile reaches another account; its keychain: value is read from the
 * Keychain or the Secret Service when the server starts, and `turno secret set` stores it with
 * the input hidden (cli/commands/secret.ts).
 */

const LINEAR_TOKEN = "turno/oauth/linear@default";
const ISSUES_TOKEN = "turno/issues/work";

/** Agent sessions in each lane: any agent of an account reaches the service the same way. */
const AGENTS: [string[], string[]] = [
  ["Claude Code", "Codex"],
  ["Claude Code", "Cursor CLI"],
];

export const LOGINS_TEXT = {
  en: {
    figure: "Two accounts and their agents over the gateway, and a service outside both. Choose a command to run it here.",
    gateway: {
      login: "logs in once per account; no agent logs in on its own",
      variant: "each variant runs as its own process",
      secret: "reads keychain: values when the server starts",
    },
    host: "mcp.linear.app",
    oneAccount: "one account",
    account: (who: string) => `${who}'s account`,
    missing: "missing",
    stored: "stored",
    result: {
      everyAgent: "every agent reaches linear through mcpd; none of them logged in",
      twoAccounts: "work reaches its own account of issues; personal keeps the other",
    },
  },
  es: {
    figure: "Dos cuentas y sus agentes sobre el gateway, y un servicio fuera de las dos. Elige un comando para correrlo aquí.",
    gateway: {
      login: "inicia sesión una vez por cuenta; ningún agente inicia sesión por su lado",
      variant: "cada variante corre como su propio proceso",
      secret: "lee los valores keychain: cuando arranca el servidor",
    },
    host: "mcp.linear.app",
    oneAccount: "una cuenta",
    account: (who: string) => `cuenta de ${who}`,
    missing: "falta",
    stored: "guardado",
    result: {
      everyAgent: "todos los agentes llegan a linear a través de mcpd; ninguno inició sesión",
      twoAccounts: "work llega a su propia cuenta de issues; personal se queda con la otra",
    },
  },
};

/** The section's commands from copy.ts. The mcp.toml block is read, not typed. */
export function loginsCommands(lang: Lang): ChapterCommand[] {
  return landingCopy(lang).sections.logins.commands.map((command) =>
    command.run.startsWith("[") ? { ...command, prompt: "mcp.toml", copyable: false } : { ...command, prompt: "$" },
  );
}

/** The token's short way up from the service to the gateway, in beats. */
const HOP = 4;

/*
 * The phases of each command and how many beats each holds. The login: typing, the browser,
 * the token's hop up to the gateway, then each agent's first call, one per beat. The variant:
 * typing, its env line and the work token, the service divides and each half glides under its
 * lane, then says whose account it is. The secret: typing, the hidden input, stored.
 */
const BEATS: Record<number, number[]> = {
  0: [4, 3, HOP, 2, 1, 1, 1, 1],
  1: [4, 3, TRAVEL, 1],
  2: [4, 4, 1],
};

export default function LoginsPicture({ lang, chosen, run, drawn, armed, reduced, say }: PictureProps) {
  const t = LOGINS_TEXT[lang];
  const beats = BEATS[chosen] ?? BEATS[0]!;
  const phase = usePhase(`${chosen}-${run}`, beats, run > 0, reduced);
  const p = run > 0 ? phase : 0;

  /* The line under the picture. */
  let prompt = "$";
  let cmd = "turno mcp login linear";
  let result: string | undefined;
  if (chosen === 0) {
    if (p >= 1) result = "Opening the browser to log in to linear (every profile).";
    if (p >= 3) result = `The tokens are in the Keychain as ${LINEAR_TOKEN}`;
    if (p >= 7) result = t.result.everyAgent;
  } else if (chosen === 1) {
    prompt = "mcp.toml";
    cmd = "[server.issues.variant.work]";
    if (p >= 1) result = `env = { ISSUES_TOKEN = "keychain:${ISSUES_TOKEN}" }`;
    if (p >= 3) result = t.result.twoAccounts;
  } else {
    cmd = `turno secret set ${ISSUES_TOKEN}`;
    if (p >= 1) result = "value (input hidden, end with Enter):";
    if (p >= 2) result = `stored keychain:${ISSUES_TOKEN}`;
  }
  useEffect(() => {
    if (run > 0) say({ prompt, cmd, result });
  }, [run, prompt, cmd, result, say]);

  /* The login's token hops up from the service into the gateway. */
  const frame = useRef<HTMLDivElement>(null);
  const service = useRef<HTMLDivElement>(null);
  const landing = useRef<HTMLDivElement>(null);
  const traveler = useRef<HTMLDivElement>(null);
  useTravel({ on: chosen === 0 && p === 2 && !reduced, frame, from: service, to: landing, node: traveler, beats: HOP, align: "center" });

  /* A variant divides the service: both halves start where the one service was and glide apart. */
  const below = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  useDivide(chosen === 1 && p === 2 && !reduced, below, left, right);

  /* What each command draws. */
  const linear = chosen === 0;
  const checked = linear ? Math.max(0, p - 3) : 0;
  const split = chosen === 2 || (chosen === 1 && p >= 2);
  const named = chosen === 2 || (chosen === 1 && p >= 3);
  const workKey = chosen === 2 || (chosen === 1 && p >= 1);
  const keyState = chosen === 2 ? (p >= 2 ? "stored" : p >= 1 ? "typing" : "missing") : "referenced";
  const barText = chosen === 0 ? t.gateway.login : chosen === 1 ? t.gateway.variant : t.gateway.secret;

  let order = 0;
  const lanes = AGENTS.map((names, lane) =>
    names.map((name, index) => {
      order += 1;
      return <Agent key={`${lane}-${name}`} lane={lane as Lane} y={index * 44} name={name} reached={checked >= order ? "linear" : undefined} />;
    }),
  );

  return (
    <Frame frameRef={frame} drawn={drawn} armed={armed} reduced={reduced}>
      <Stage
        active={[true, true]}
        sub={["", workKey ? "issues.variant.work" : ""]}
        bar={{ name: "mcpd", text: barText }}
        cut={run > 0 && p === 0}
        drawn={drawn}
        armed={armed}
        reduced={reduced}
      >
        {lanes}
        {linear ? (
          <div ref={landing} className={s.onBar} style={{ visibility: p >= 3 ? "visible" : "hidden" }}>
            <Key tone="keep" name={LINEAR_TOKEN} />
          </div>
        ) : null}
        {workKey ? (
          <div className={s.at} style={place(1, "calc(var(--slot) - 34px)")}>
            <Key tone="work" name={`keychain:${ISSUES_TOKEN}`} state={chosen === 2 ? keyState : undefined} labels={t} />
          </div>
        ) : null}
      </Stage>

      <Below split={split} belowRef={below}>
        {split ? (
          <>
            <Service serviceRef={left} tone={named ? "personal" : undefined} name="issues" note={named ? t.account("personal") : undefined} />
            <Service serviceRef={right} tone={named ? "work" : undefined} name="issues" note={named ? t.account("work") : undefined} />
          </>
        ) : (
          <Service serviceRef={service} name={linear ? "linear" : "issues"} note={linear ? t.host : t.oneAccount} />
        )}
      </Below>

      <div ref={traveler} aria-hidden className={s.traveler}>
        <Key tone="keep" name={LINEAR_TOKEN} />
      </div>
    </Frame>
  );
}

/* Parts --------------------------------------------------------------------------------------- */

/** An agent session in a lane: the same compact shape as the conversation card, in hairline. */
function Agent({ lane, y, name, reached }: { lane: Lane; y: number; name: string; reached?: string }) {
  return (
    <div className={`${s.at} ${s.agent}`} style={place(lane, y)}>
      <span className={s.agentName}>{name}</span>
      {reached ? (
        <span className={s.agentReached}>
          <span aria-hidden>✓</span> {reached}
        </span>
      ) : null}
    </div>
  );
}

/** A secret store entry: a key and the item's name, outlined in the tone of who uses it. */
function Key({ tone, name, state, labels }: { tone: Tone; name: string; state?: "missing" | "typing" | "stored" | "referenced"; labels?: { missing: string; stored: string } }) {
  return (
    <span className={s.key} style={{ "--tone": `var(--tone-${tone})` } as CSSProperties} data-state={state}>
      <span aria-hidden className={s.keyGlyph}>
        <i />
      </span>
      <span className={s.keyName}>{name}</span>
      {state === "missing" ? <span className={s.keyState}>{labels?.missing}</span> : null}
      {state === "typing" ? (
        <span aria-hidden className={`${s.keyState} ${s.keyDots}`}>
          ••••••••
        </span>
      ) : null}
      {state === "stored" ? <span className={s.keyState}>{labels?.stored}</span> : null}
    </span>
  );
}

/** The service, outside both lanes: one chip, or one per account once a variant splits it. */
function Service({ name, note, tone, serviceRef }: { name: string; note?: string; tone?: Tone; serviceRef?: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={serviceRef} className={s.service} style={tone ? ({ "--tone": `var(--tone-${tone})` } as CSSProperties) : undefined} data-tone={tone}>
      <span aria-hidden className={s.square} />
      <span className={s.serviceName}>{name}</span>
      {note ? <span className={s.serviceNote}>{note}</span> : null}
    </div>
  );
}

/**
 * The halves of a divided service start together where the one service stood (centered at the
 * top of the row under the bar) and glide to their own places. Measured once, never per frame.
 */
function useDivide(on: boolean, row: RefObject<HTMLDivElement | null>, left: RefObject<HTMLDivElement | null>, right: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const box = row.current?.getBoundingClientRect();
    if (!on || !box) return;
    const animations = [left, right].map((half) => {
      const node = half.current;
      if (!node) return null;
      const r = node.getBoundingClientRect();
      const dx = box.left + box.width / 2 - (r.left + r.width / 2);
      const dy = box.top - r.top;
      return node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: TRAVEL * BEAT,
        easing: "cubic-bezier(0.65, 0, 0.35, 1)",
        fill: "backwards",
      });
    });
    return () => {
      for (const animation of animations) animation?.cancel();
    };
  }, [on, row, left, right]);
}

/* Shared with chapter 3 (browser): the frame, the row under the bar, the traveler ------------ */

/**
 * The picture's frame: the stage, what hangs under its bar, and the layer a traveler flies on.
 * It hides and draws in the parts it owns the way the stage draws its own.
 */
export function Frame({ frameRef, drawn, armed, reduced, children }: { frameRef: RefObject<HTMLDivElement | null>; drawn: boolean; armed: boolean; reduced: boolean; children: ReactNode }) {
  const drawing = useDrawing(drawn, reduced);
  return (
    <div ref={frameRef} className={s.frame} data-wait={(armed && !drawn) || undefined} data-drawing={drawing || undefined}>
      {children}
    </div>
  );
}

/**
 * What hangs under the bar: one thing outside both lanes, reached through turno, centered; or,
 * split, one thing under each lane.
 */
export function Below({ split = false, belowRef, children }: { split?: boolean; belowRef?: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  return (
    <div ref={belowRef} className={s.below} data-split={split || undefined}>
      {children}
    </div>
  );
}

/** True for the beats the picture spends drawing itself, as the stage counts them. */
function useDrawing(drawn: boolean, reduced: boolean): boolean {
  const [drawing, setDrawing] = useState(false);
  useEffect(() => {
    if (!drawn || reduced) return;
    setDrawing(true);
    const timer = setTimeout(() => setDrawing(false), (DRAW_BEATS + 2) * BEAT);
    return () => clearTimeout(timer);
  }, [drawn, reduced]);
  return drawing;
}

/**
 * Flies `node` from one element to another over `beats`, eased, measured once when it starts
 * and never per frame. `align` picks which point of the two boxes meet: their centers, or their
 * top-left corners, the target's moved by `offset` (where something will print inside it).
 */
export function useTravel({
  on,
  frame,
  from,
  to,
  node,
  beats,
  align = "center",
  offset = [0, 0],
}: {
  on: boolean;
  frame: RefObject<HTMLElement | null>;
  from: RefObject<HTMLElement | null>;
  to: RefObject<HTMLElement | null>;
  node: RefObject<HTMLElement | null>;
  beats: number;
  align?: "center" | "start";
  offset?: [number, number];
}) {
  const [ox, oy] = offset;
  useLayoutEffect(() => {
    const el = node.current;
    if (!on || !el || !frame.current || !from.current || !to.current) return;
    const base = frame.current.getBoundingClientRect();
    const a = from.current.getBoundingClientRect();
    const b = to.current.getBoundingClientRect();
    const me = el.getBoundingClientRect();
    const point = (r: DOMRect) => (align === "center" ? [r.left + r.width / 2 - me.width / 2, r.top + r.height / 2 - me.height / 2] : [r.left, r.top]);
    const [x0, y0] = point(a).map((v, i) => v - (i === 0 ? base.left : base.top));
    const [x1, y1] = point(b).map((v, i) => v - (i === 0 ? base.left - ox : base.top - oy));
    const animation = el.animate(
      [
        { transform: `translate(${x0}px, ${y0}px)`, opacity: 1 },
        { transform: `translate(${x1}px, ${y1}px)`, opacity: 1 },
      ],
      { duration: beats * BEAT, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" },
    );
    return () => animation.cancel();
  }, [on, frame, from, to, node, beats, align, ox, oy]);
}
