"use client";

import { type CSSProperties, Fragment, type ReactNode, useEffect, useRef, useState } from "react";

/** The accounts the page talks about, and turno itself: the part that stays when they change. */
export type Tone = "work" | "personal" | "third" | "keep";

/** The CSS color of a tone, for inline styles and SVG. */
export function toneColor(tone: Tone): string {
  return `var(--tone-${tone})`;
}

/** Sets `--tone` on an element so its children can use `var(--tone)` and `var(--tone-soft)`. */
export function toneStyle(tone: Tone): CSSProperties {
  return { "--tone": `var(--tone-${tone})`, "--tone-soft": `var(--tone-${tone}-soft)` } as CSSProperties;
}

/** An account, as the status line draws it: a small filled pill. */
export function AccountPill({ tone, children, quiet = false }: { tone: Tone; children: ReactNode; quiet?: boolean }) {
  return (
    <span className={`t-pill ${quiet ? "t-pill-quiet" : ""}`} style={toneStyle(tone)}>
      <span aria-hidden className="t-pill-dot" />
      {children}
    </span>
  );
}

/** A framed area with a mono label on its top edge. */
export function Panel({ label, tone, className = "", children }: { label?: ReactNode; tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <div className={`t-panel ${className}`} style={tone ? toneStyle(tone) : undefined}>
      {label ? <div className="t-panel-label">{label}</div> : null}
      {children}
    </div>
  );
}

/** One terminal line: a prompt and what was typed, or an output line when `out` is set. */
export function TermLine({ children, out = false, tone }: { children: ReactNode; out?: boolean; tone?: Tone }) {
  return (
    <div className={`t-term-line ${out ? "t-term-out" : ""}`} style={tone ? toneStyle(tone) : undefined}>
      <span aria-hidden className="t-term-prompt">
        {out ? "→" : "$"}
      </span>
      <span>{children}</span>
    </div>
  );
}

/** A command the reader can copy with one click. The whole row is the button. */
export function CopyCommand({ run, copyLabel, copiedLabel, prompt = "$" }: { run: string; copyLabel: string; copiedLabel: string; prompt?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    void navigator.clipboard?.writeText(run).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button type="button" className="t-cmd" onClick={copy} aria-label={`${copyLabel}: ${run}`}>
      <span aria-hidden className="t-cmd-prompt">
        {prompt}
      </span>
      <code className="t-cmd-text">
        {run.split(" ").map((word, index) => (
          // The words of one fixed command: their order never changes.
          <Fragment key={index}>
            {index > 0 ? " " : null}
            <span className="t-cmd-word">{word}</span>
          </Fragment>
        ))}
      </code>
      <span className="t-cmd-state" aria-live="polite">
        {copied ? copiedLabel : copyLabel}
      </span>
    </button>
  );
}
