import { join } from "node:path";
import { ensurePrivateDir, paths } from "../core/paths.js";
import { type ServiceBackend, type ServiceSpec, ServiceError, runTool, serviceArgs, serviceEnv } from "./service.js";

export const LABEL = "dev.turno.mcpd";

export function plistPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(paths(env).home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unxml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * LaunchAgent that keeps `turno mcp daemon run` alive. `Interactive` because mcpd answers
 * calls the user is waiting for and starts browsers (a `Background` job gets throttled).
 * KeepAlive only restarts it after a failure: a clean exit (another mcpd already serves) stays down.
 */
export function plist(spec: ServiceSpec): string {
  const p = paths(spec.env);
  const envXml = Object.entries(serviceEnv(spec, "launchd"))
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join("\n");
  const args = serviceArgs(spec)
    .map((a) => `      <string>${xml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${xml(join(p.logsDir, "mcpd.stdout.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(join(p.logsDir, "mcpd.stderr.log"))}</string>
  </dict>
</plist>
`;
}

/** ProgramArguments of a plist written by `plist()` (or an earlier turno). */
export function plistProgram(text: string): string[] {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  if (!m) return [];
  return [...m[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((x) => unxml(x[1]!));
}

function domain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ServiceError("cannot tell the user id for launchctl");
  return `gui/${uid}`;
}

export const launchd: ServiceBackend = {
  kind: "launchd",
  noun: "LaunchAgent",
  file: plistPath,
  render: plist,
  programOf: plistProgram,
  async isLoaded(env) {
    try {
      await runTool("launchctl", ["print", `${domain()}/${LABEL}`], env, 5000);
      return true;
    } catch (err) {
      if (err instanceof ServiceError && /not found on PATH/.test(err.message)) throw err;
      return false;
    }
  },
  async load(env) {
    ensurePrivateDir(paths(env).logsDir, env);
    if (await launchd.isLoaded(env))
      await runTool("launchctl", ["bootout", `${domain()}/${LABEL}`], env).catch(() => {});
    await runTool("launchctl", ["bootstrap", domain(), plistPath(env)], env);
  },
  async unload(env) {
    await runTool("launchctl", ["bootout", `${domain()}/${LABEL}`], env);
  },
  async restart(env) {
    await runTool("launchctl", ["kickstart", "-k", `${domain()}/${LABEL}`], env);
  },
};
