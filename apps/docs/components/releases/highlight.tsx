import Link from "next/link";
import type { ReactNode } from "react";

/**
 * One headline feature of a release:
 *
 *   <Highlight area="Gateway" title="Each folder sees only its servers" href="/docs/concepts/folder-rules" more="Folder rules">
 *   Two or three lines on what it does for the reader.
 *
 *   ```toml title="~/.config/turno/config.toml"
 *   ...
 *   ```
 *   </Highlight>
 *
 * `area` is a mono label (CLI, Gateway, Browser, Accounts, Docs), never a color: color on this
 * site means an account. On wide screens the first code block moves beside the text.
 */
export function Highlight({
  area,
  title,
  href,
  more = "How it works",
  children,
}: {
  area: string;
  title: string;
  href?: string;
  more?: string;
  children?: ReactNode;
}) {
  return (
    <section className="d-hl">
      <p className="d-hl-area">{area}</p>
      <h3 className="d-hl-title">{title}</h3>
      <div className="d-hl-body">{children}</div>
      {href ? (
        <Link href={href} className="d-hl-more">
          {more}
          <span aria-hidden>→</span>
        </Link>
      ) : null}
    </section>
  );
}
