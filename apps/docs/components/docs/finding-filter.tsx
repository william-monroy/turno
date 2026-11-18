"use client";

import { useI18n } from "fumadocs-ui/contexts/i18n";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

const TEXT: Record<string, { label: string; placeholder: string; all: (n: number) => string; some: (n: number, of: number) => string; none: string; clear: string }> = {
  en: {
    label: "Filter findings",
    placeholder: "A symptom or a check: port, token, chrome, launcher...",
    all: (n) => `${n} findings`,
    some: (n, of) => `${n} of ${of} findings`,
    none: "No finding matches. Try one word, or search all the docs.",
    clear: "Clear",
  },
  es: {
    label: "Filtrar hallazgos",
    placeholder: "Un síntoma o una revisión: port, token, chrome, launcher...",
    all: (n) => `${n} hallazgos`,
    some: (n, of) => `${n} de ${of} hallazgos`,
    none: "Ningún hallazgo coincide. Prueba con una palabra, o busca en toda la documentación.",
    clear: "Borrar",
  },
};

/** Lower case, with dashes, underscores and runs of spaces as one space: `port-in-use` finds "port in use". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A filter over the tables it wraps: each row stays when every word typed appears in its text or
 * in the page it links to. The tables are plain Markdown, so the page reads the same without
 * JavaScript and in its Markdown copy; this only hides rows, and the headings of groups that
 * end up empty.
 */
export function FindingFilter({ children }: { children: ReactNode }) {
  const t = TEXT[useI18n().locale ?? "en"] ?? TEXT.en!;
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [counts, setCounts] = useState<{ shown: number; total: number } | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const words = normalize(query).split(" ").filter(Boolean);
    let shown = 0;
    let total = 0;
    for (const table of el.querySelectorAll("table")) {
      let visible = 0;
      for (const row of table.querySelectorAll("tbody tr")) {
        total++;
        const href = row.querySelector("a")?.getAttribute("href") ?? "";
        const haystack = normalize(`${row.textContent ?? ""} ${href.split("/").pop() ?? ""}`);
        const match = words.every((word) => haystack.includes(word));
        (row as HTMLElement).hidden = !match;
        if (match) visible++;
      }
      shown += visible;
      // A group is its heading and the scroll box Fumadocs puts around the table.
      const box = table.parentElement;
      const heading = box?.previousElementSibling;
      if (box) box.hidden = visible === 0;
      if (heading && /^H[2-4]$/.test(heading.tagName)) (heading as HTMLElement).hidden = visible === 0;
    }
    setCounts({ shown, total });
  }, [query]);

  // ?q= fills the filter, so a link can point at the rows for one symptom; typing keeps the URL in step.
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get("q");
    if (initial) setQuery(initial);
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    window.history.replaceState(window.history.state, "", url);
  }, [query]);

  // "/" jumps to the filter from anywhere on the page, unless the reader is typing somewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="d-filter">
      <div className="d-filter-bar not-prose">
        <label htmlFor={id} className="d-filter-label">
          {t.label}
        </label>
        <div className="d-filter-field">
          <input
            ref={input}
            id={id}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
            placeholder={t.placeholder}
            autoComplete="off"
            spellCheck={false}
            className="d-filter-input"
          />
          {query ? (
            <button
              type="button"
              className="d-filter-clear"
              onClick={() => {
                setQuery("");
                input.current?.focus();
              }}
            >
              {t.clear}
            </button>
          ) : (
            <kbd aria-hidden className="d-filter-key">
              /
            </kbd>
          )}
        </div>
        <p className="d-filter-count" aria-live="polite">
          {counts ? (query ? t.some(counts.shown, counts.total) : t.all(counts.total)) : null}
        </p>
      </div>
      {counts && query && counts.shown === 0 ? <p className="d-filter-none">{t.none}</p> : null}
      <div ref={root}>{children}</div>
    </div>
  );
}
