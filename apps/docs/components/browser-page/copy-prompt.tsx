"use client";

import { useEffect, useRef, useState } from "react";
import s from "./page.module.css";

/** Copies a prompt the reader pastes into their coding agent, which then sets the tool up. */
export function CopyPrompt({ label, copied, text }: { label: string; copied: string; text: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 2400);
    });
  };

  return (
    <button type="button" className={`t-swap ${s.prompt}`} onClick={copy} title={text}>
      <span aria-hidden className={s.promptMark}>
        ❯
      </span>
      <span aria-live="polite">{done ? copied : label}</span>
    </button>
  );
}
