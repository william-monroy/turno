import Link from "next/link";
import { localePath, REPO } from "@/lib/layout.shared";
import { type Headline, type Lang, landingCopy } from "../copy";
import { CopyCommand } from "../kit";

/**
 * The pieces of the hero copy, so each hero concept can arrange them its own way. All of them
 * take the language and read the words from copy.ts.
 */

function Title({ parts }: { parts: Headline }) {
  const [before, mark, after] = parts;
  return (
    <>
      {before}
      <span className="t-mark">{mark}</span>
      {after}
    </>
  );
}

export function HeroEyebrow({ lang, className = "" }: { lang: Lang; className?: string }) {
  return <p className={`t-label ${className}`}>{landingCopy(lang).hero.eyebrow}</p>;
}

/** The page's only h1. Render it exactly once per hero. */
export function HeroTitle({ lang, className = "" }: { lang: Lang; className?: string }) {
  return (
    <h1 id="hero-title" className={`t-h1 ${className}`}>
      <Title parts={landingCopy(lang).hero.headline} />
    </h1>
  );
}

export function HeroHook({ lang, className = "" }: { lang: Lang; className?: string }) {
  return <p className={`text-[clamp(20px,2vw,28px)] font-medium leading-tight tracking-tight ${className}`}>{landingCopy(lang).hero.hook}</p>;
}

export function HeroLead({ lang, className = "" }: { lang: Lang; className?: string }) {
  return <p className={`t-lead ${className}`}>{landingCopy(lang).hero.lead}</p>;
}

export function HeroDemo({ lang, className = "" }: { lang: Lang; className?: string }) {
  const t = landingCopy(lang);
  return (
    <div className={`flex max-w-xl flex-col gap-3 ${className}`}>
      <p className="t-label">{t.hero.demoLabel}</p>
      <CopyCommand run="npx turno-cli demo" copyLabel={t.rail.copy} copiedLabel={t.rail.copied} />
      <p className="text-sm text-fd-muted-foreground">{t.hero.demoNote}</p>
    </div>
  );
}

export function HeroActions({ lang, className = "" }: { lang: Lang; className?: string }) {
  const t = landingCopy(lang);
  return (
    <div className={`flex flex-wrap gap-3 ${className}`}>
      <Link href={localePath(lang, "/docs")} className="inline-flex items-center gap-2 border border-fd-primary bg-fd-primary px-4 py-2.5 text-sm font-medium text-fd-primary-foreground hover:border-fd-foreground hover:bg-fd-foreground hover:text-fd-background">
        {t.hero.docs} <span aria-hidden>→</span>
      </Link>
      <a href={REPO} rel="noreferrer noopener" className="t-swap inline-flex items-center border px-4 py-2.5 text-sm font-medium">
        GitHub
      </a>
    </div>
  );
}
