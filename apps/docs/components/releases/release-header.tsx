import { releaseDate, releasedPackage } from "./data";
import { ReleaseNeighbors } from "./neighbors";

/**
 * The facts of a release, first thing under the title of its page:
 *
 *   <ReleaseHeader date="2026-11-17" packages={["turno-cli@0.2.0", "turno-browser@0.2.0"]} />
 *
 * Each package is written as its git tag and gets its GitHub release and its changelog section.
 * Its presence also turns on the release look of the page's change lists (docs-theme.css).
 */
export function ReleaseHeader({ date, packages }: { date: string; packages: string[] }) {
  const list = packages.map(releasedPackage);
  return (
    <div className="d-rel not-prose">
      <dl className="d-rel-facts">
        <div className="d-rel-fact">
          <dt>Released</dt>
          <dd>
            <time dateTime={date}>{releaseDate(date)}</time>
          </dd>
        </div>
        <div className="d-rel-fact">
          <dt>{list.length === 1 ? "Package" : "Packages"}</dt>
          <dd>
            <ul className="d-rel-pkgs">
              {list.map((pkg) => (
                <li key={pkg.name} className="d-rel-pkg">
                  <PackageChip name={pkg.name} version={pkg.version} />
                  <span className="d-rel-pkg-links">
                    <a href={pkg.release} rel="noreferrer noopener">
                      GitHub release<span aria-hidden> ↗</span>
                    </a>
                    <a href={pkg.changelog} rel="noreferrer noopener">
                      Changelog<span aria-hidden> ↗</span>
                    </a>
                  </span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
      <ReleaseNeighbors />
    </div>
  );
}

/** A package and its version as one mono chip: `turno-cli 0.2.0`. */
export function PackageChip({ name, version }: { name: string; version: string }) {
  return (
    <span className="d-chip">
      <span>{name}</span>
      <span className="d-chip-version">{version}</span>
    </span>
  );
}
