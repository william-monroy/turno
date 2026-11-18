import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Cards and callouts in the landing's look, with the props of Fumadocs' own (`<Card title href
 * description>`, `<Callout title type>`), so the MDX pages do not change. Styles: app/docs-theme.css.
 */
export function Cards({ children }: { children: ReactNode }) {
  return <div className="d-cards not-prose">{children}</div>;
}

export function Card({ title, description, href, children }: { title: ReactNode; description?: ReactNode; href?: string; children?: ReactNode; icon?: ReactNode }) {
  const body = (
    <>
      <span className="d-card-title">
        {title}
        {href ? (
          <span aria-hidden className="d-card-arrow">
            →
          </span>
        ) : null}
      </span>
      {description ? <span className="d-card-text">{description}</span> : null}
      {children ? <span className="d-card-text">{children}</span> : null}
    </>
  );
  if (!href) return <div className="d-card">{body}</div>;
  const external = /^[a-z]+:/i.test(href);
  return external ? (
    <a href={href} className="d-card" rel="noreferrer noopener">
      {body}
    </a>
  ) : (
    <Link href={href} className="d-card">
      {body}
    </Link>
  );
}

type CalloutType = "info" | "tip" | "warn" | "warning" | "error" | "success" | "idea";

export function Callout({ title, type = "info", children }: { title?: ReactNode; type?: CalloutType; children?: ReactNode; icon?: ReactNode }) {
  const strong = type === "warn" || type === "warning" || type === "error";
  return (
    <aside className={`d-callout ${strong ? "d-callout-strong" : ""}`}>
      {title ? <p className="d-callout-title">{title}</p> : null}
      <div className="d-callout-body">{children}</div>
    </aside>
  );
}
