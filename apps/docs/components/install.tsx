import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";

const MANAGERS: [string, string][] = [
  ["npm", "npm install --global"],
  ["pnpm", "pnpm add --global"],
  ["bun", "bun add --global"],
  ["yarn", "yarn global add"],
];

const BREW: Record<string, { install: string; upgrade: string }> = {
  "turno-cli": {
    install: "brew tap wimo-dev/turno && brew trust wimo-dev/turno && brew install turno",
    upgrade: "brew update && brew upgrade turno",
  },
};

/**
 * Install tabs for a package: npm, pnpm, bun, yarn, and Homebrew when there is a formula. With
 * `upgrade`, the commands `turno upgrade` itself runs (core/version.ts in turno-cli): the package
 * at `@latest`, and `brew upgrade` for the formula.
 */
export function Install({ pkg = "turno-cli", upgrade = false }: { pkg?: string; upgrade?: boolean }) {
  const brew = BREW[pkg];
  const items = [...MANAGERS.map(([name]) => name), ...(brew ? ["Homebrew"] : [])];
  const target = upgrade ? `${pkg}@latest` : pkg;
  return (
    <Tabs items={items} groupId="package-manager" persist>
      {MANAGERS.map(([name, command]) => (
        <Tab key={name} value={name}>
          <DynamicCodeBlock lang="sh" code={`${command} ${target}`} />
        </Tab>
      ))}
      {brew ? (
        <Tab value="Homebrew">
          <DynamicCodeBlock lang="sh" code={upgrade ? brew.upgrade : brew.install} />
        </Tab>
      ) : null}
    </Tabs>
  );
}
