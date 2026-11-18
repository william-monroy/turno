import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";

const MANAGERS: [string, string][] = [
  ["npm", "npm install --global"],
  ["pnpm", "pnpm add --global"],
  ["bun", "bun add --global"],
  ["yarn", "yarn global add"],
];

const BREW: Record<string, string> = {
  "turno-cli": "brew tap wimo-dev/turno && brew trust wimo-dev/turno && brew install turno",
};

/** Install tabs for a package: npm, pnpm, bun, yarn, and Homebrew when there is a formula. */
export function Install({ pkg = "turno-cli" }: { pkg?: string }) {
  const brew = BREW[pkg];
  const items = [...MANAGERS.map(([name]) => name), ...(brew ? ["Homebrew"] : [])];
  return (
    <Tabs items={items} groupId="package-manager" persist>
      {MANAGERS.map(([name, command]) => (
        <Tab key={name} value={name}>
          <DynamicCodeBlock lang="sh" code={`${command} ${pkg}`} />
        </Tab>
      ))}
      {brew ? (
        <Tab value="Homebrew">
          <DynamicCodeBlock lang="sh" code={brew} />
        </Tab>
      ) : null}
    </Tabs>
  );
}
