import "./landing.css";
import { asLang, landingCopy } from "./copy";
import ThreadsHero from "./hero/threads";
import { Chapters } from "./chapters/chapters";
import { ChapterList, Thread } from "./chapters/thread";

/**
 * The landing page: the hero, then the story under it (where to start, the eight chapters) with
 * the conversation's thread down its left gutter, and the footer where the thread ends.
 */
export function LandingPage({ lang: given }: { lang: string }) {
  const lang = asLang(given);
  const t = landingCopy(lang);

  return (
    <main className="t-site flex-1">
      <section id="hero" className="t-hero" aria-labelledby="hero-title">
        <ThreadsHero lang={lang} />
      </section>

      <div className="t-story">
        <Thread />

        {/* The handover: the thread comes in here, under the hero, and the reader picks a way in. */}
        <div className="t-wrap t-start">
          <p className="t-label">{t.pains.title}</p>
          <nav className="t-pains" aria-label={t.pains.title}>
            {t.pains.items.map((pain) => (
              <a key={pain.to} href={`#${pain.to}`} className="t-pain t-swap">
                <span>{pain.text}</span>
                <span aria-hidden className="font-mono text-xs">
                  ↓
                </span>
              </a>
            ))}
          </nav>
          <ChapterList lang={lang} where="start" />
        </div>

        <Chapters lang={lang} />
      </div>

      <footer className="t-section">
        <div className="t-wrap t-foot">
          <ChapterList lang={lang} where="end" />
          <div className="flex flex-col gap-4 text-xs leading-relaxed text-fd-muted-foreground md:flex-row md:items-end md:justify-between">
            <p className="max-w-xl">{t.footer.disclaimer}</p>
            <p className="font-mono">
              {t.footer.madeBy}{" "}
              <a href="https://wimo.dev" className="text-fd-foreground underline underline-offset-4">
                {t.footer.site}
              </a>
            </p>
          </div>
        </div>
      </footer>
    </main>
  );
}
