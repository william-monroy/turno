import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import type { ReactNode } from "react";
import { Callout } from "@/components/docs/cards";
import { Install } from "@/components/install";

/**
 * How to upgrade: `turno upgrade`, the same with each package manager, and, as children, what to
 * run afterwards when a version needs it:
 *
 *   <Upgrade>
 *   Run `turno mcp sync` once: ...
 *   </Upgrade>
 *
 * Without children it is only the commands, as on the list of releases.
 */
export function Upgrade({ after = "After upgrading", children }: { after?: string; children?: ReactNode }) {
  return (
    <div className="d-up">
      <div className="d-up-way">
        <p className="d-up-label">One command</p>
        <DynamicCodeBlock lang="sh" code="turno upgrade" />
        <p className="d-up-note">
          Updates turno with the tool that installed it (npm, pnpm, yarn, bun, Volta, Homebrew or a git checkout), then rewrites the
          launchers.
        </p>
      </div>
      <div className="d-up-way">
        <p className="d-up-label">Or with your package manager</p>
        <Install upgrade />
        <p className="d-up-note">
          Then run <code>turno upgrade --finish</code>: it rewrites the launchers, checks the config and shows what changed.
        </p>
      </div>
      {children ? (
        <Callout type="warn" title={after}>
          {children}
        </Callout>
      ) : null}
    </div>
  );
}
