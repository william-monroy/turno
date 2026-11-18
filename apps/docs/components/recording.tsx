import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";

/**
 * A terminal recording as text that can be selected and copied. The files in content/recordings
 * are rendered from the VHS tapes in tapes/ by scripts/render-tapes.mjs, in a throwaway HOME.
 */
export function Recording({ name, title }: { name: string; title?: string }) {
  const text = readFileSync(join(process.cwd(), "content/recordings", `${name}.txt`), "utf8").replace(/\n+$/, "");
  return (
    <CodeBlock title={title ?? "Terminal"} className="recording" viewportProps={{ className: "max-h-none" }}>
      <Pre>
        <code>
          {text.split("\n").map((line, i) => (
            <span key={i} className="line">
              {line}
              {"\n"}
            </span>
          ))}
        </code>
      </Pre>
    </CodeBlock>
  );
}
