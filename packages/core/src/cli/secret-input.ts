/**
 * Reading a secret from a person or a pipe, for `turno secret set` and `turno browser vault add`.
 * On a terminal the input is hidden (raw mode, nothing echoed); otherwise stdin is read to the
 * end. Neither path ever prints what was read.
 */

/** Whether stdin is a terminal a person types into. */
export function stdinIsTty(): boolean {
  return Boolean(process.stdin.isTTY);
}

/** A line typed on the terminal without echo; Ctrl-C exits 130. */
export function readHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** A line typed on the terminal, shown as typed (a username). */
export async function readVisible(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/** All of stdin, without one trailing line break. */
export async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}
