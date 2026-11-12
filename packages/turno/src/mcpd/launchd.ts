import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { paths } from "../core/paths.js";

const run = promisify(execFile);

export const LABEL = "dev.turno.mcpd";

export function plistPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(paths(env).home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** LaunchAgent that keeps `turno mcpd run` alive, with the caller's PATH (launchd's is minimal). */
export function plist(opts: { node: string; script: string; env: NodeJS.ProcessEnv }): string {
  const p = paths(opts.env);
  const vars: Record<string, string> = {
    PATH: opts.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: p.home,
  };
  for (const k of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "LANG"]) if (opts.env[k]) vars[k] = opts.env[k] as string;
  const envXml = Object.entries(vars)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(opts.node)}</string>
      <string>${xml(opts.script)}</string>
      <string>mcpd</string>
      <string>run</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(join(p.logsDir, "mcpd.stdout.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(join(p.logsDir, "mcpd.stderr.log"))}</string>
  </dict>
</plist>
`;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export async function isLoaded(): Promise<boolean> {
  try {
    await run("launchctl", ["print", `${domain()}/${LABEL}`], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function install(opts: { node: string; script: string; env: NodeJS.ProcessEnv }): Promise<string> {
  const file = plistPath(opts.env);
  mkdirSync(join(paths(opts.env).home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(paths(opts.env).logsDir, { recursive: true });
  writeFileSync(file, plist(opts));
  if (await isLoaded()) await run("launchctl", ["bootout", `${domain()}/${LABEL}`], { timeout: 10_000 }).catch(() => {});
  await run("launchctl", ["bootstrap", domain(), file], { timeout: 10_000 });
  return file;
}

export async function uninstall(): Promise<void> {
  await run("launchctl", ["bootout", `${domain()}/${LABEL}`], { timeout: 10_000 });
}

export async function restart(): Promise<void> {
  await run("launchctl", ["kickstart", "-k", `${domain()}/${LABEL}`], { timeout: 10_000 });
}
