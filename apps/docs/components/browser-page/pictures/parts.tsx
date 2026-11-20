import type { ReactNode } from "react";
import { AccountPill } from "../../landing/kit";
import s from "./pictures.module.css";

/** A Chrome window that runs, the profile it leaves on disk when closed, or no identity yet. */
export type Win = "open" | "closed" | "none";

/** The frame every picture of the page lives in. Hidden until the chapter is first seen. */
export function Shot({ drawn, armed, children }: { drawn: boolean; armed: boolean; children: ReactNode }) {
  return (
    <div className={s.frame} data-wait={(armed && !drawn) || undefined}>
      <div className={s.inner}>{children}</div>
    </div>
  );
}

/** The window of the identity `school`: its address strip, then whatever the page holds. */
export function Window({ win, url, strip, children }: { win: Win; url: string; strip?: ReactNode; children: ReactNode }) {
  return (
    <div className={s.win} data-win={win}>
      {strip}
      <div className={s.address}>
        <span aria-hidden className={s.lights}>
          <i />
          <i />
          <i />
        </span>
        <span className={s.url}>{url}</span>
        {win === "none" ? null : (
          <AccountPill tone="third" quiet={win === "closed"}>
            school
          </AccountPill>
        )}
      </div>
      {children}
    </div>
  );
}

/** Three bars that stand for a page's text. */
export function Lines() {
  return (
    <span aria-hidden className={s.lines}>
      <i />
      <i />
      <i />
    </span>
  );
}

/** One field of a sign-in form: its name and, once filled, its value (dots for a secret). */
export function Field({ name, value }: { name: string; value?: string }) {
  return (
    <span className={s.field} data-filled={value ? true : undefined}>
      <span>{name}</span>
      <span className={s.value}>{value ?? ""}</span>
    </span>
  );
}

/**
 * The agent cursor as turno-browser draws it on a page someone can see: an arrow and a pill
 * with the agent's name and the identity.
 */
export function AgentCursor({ at }: { at: "page" | "field" }) {
  return (
    <span aria-hidden className={s.agentCursor} data-at={at}>
      <i />
      <b>Claude Code · school</b>
    </span>
  );
}

/** `n` small squares: one per page. */
export function Squares({ n, kind }: { n: number; kind: "run" | "park" }) {
  return (
    <span aria-hidden className={s.squares} data-kind={kind}>
      {Array.from({ length: n }, (_, index) => (
        // Identical marks: their order never changes.
        <i key={index} />
      ))}
    </span>
  );
}
