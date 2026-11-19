import type { Lang } from "../../landing/copy";
import { browserCopy, SITE } from "../copy";
import { Lines, Squares, Window } from "./parts";
import s from "./pictures.module.css";

/*
 * The hero's picture: the three promises in one window. The identity is signed in, most of its
 * pages are parked, and a password is something the model only sees as a mark.
 */

const TABS: { name: string; parked: boolean; current?: boolean }[] = [
  { name: "blank", parked: true },
  { name: "blank", parked: true },
  { name: "blank", parked: true },
  { name: "docs", parked: false },
  { name: "courses", parked: false, current: true },
];

export function HeroPicture({ lang }: { lang: Lang }) {
  const copy = browserCopy(lang);
  const t = copy.pictures;
  const running = TABS.filter((tab) => !tab.parked).length;
  return (
    <div className={s.heroShot} role="img" aria-label={copy.hero.figure}>
      <div className={s.frame}>
        <div className={s.inner}>
          <Window
            win="open"
            url={`${SITE}/courses`}
            strip={
              <div className={s.stripWrap} style={{ paddingTop: 10 }}>
                <div className={s.strip}>
                  {TABS.map((tab, index) => (
                    // A fixed row of tabs: their order never changes.
                    <span key={index} className={s.tab} data-state={tab.parked ? "park" : "run"} data-current={tab.current || undefined} style={{ gridColumn: "span 2" }}>
                      <i aria-hidden />
                      <span>{tab.name}</span>
                    </span>
                  ))}
                </div>
              </div>
            }
          >
            <div className={s.page}>
              <span className={s.signed}>
                <span aria-hidden>✓</span> {t.identities.signedIn}
              </span>
              <span className={s.heading}>{t.identities.page}</span>
              <Lines />
            </div>
            <div className={s.readouts}>
              <span className={s.readout}>
                <span className={s.signed}>
                  <span aria-hidden>✓</span> {t.identities.signedIn} <span className={s.quiet}>· {t.identities.kept}</span>
                </span>
                <span>{t.identities.onDisk}</span>
              </span>
              <span className={s.readout}>
                <span className={s.meter}>
                  <span className={s.count}>
                    {t.tabs.running} <b>{running}</b>
                    <Squares n={running} kind="run" />
                  </span>
                  <span className={s.count}>
                    {t.tabs.parked} <b>{TABS.length - running}</b>
                    <Squares n={TABS.length - running} kind="park" />
                  </span>
                </span>
              </span>
              <span className={s.readout}>
                <span>
                  {t.vault.password} <span className={s.vaulted}>[vault: ...]</span>
                </span>
                <span>{t.vault.model}</span>
              </span>
            </div>
          </Window>
        </div>
      </div>
    </div>
  );
}
