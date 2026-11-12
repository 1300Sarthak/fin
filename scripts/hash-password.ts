/**
 * Print a FIN_PASSWORD_HASH for the owner password.
 *
 *   bun run scripts/hash-password.ts                 # prompts twice, input hidden
 *   printf '%s' "$PW" | bun run scripts/hash-password.ts   # piped, e.g. on the homelab
 *
 * The password is read from stdin only — never argv, which lands in shell
 * history and `ps`. Only the hash goes to stdout; prompts go to stderr.
 */
import { hashPassword, MAX_PASSWORD_LENGTH } from "../src/lib/auth/password";

if (process.argv.length > 2) {
  console.error("hash-password takes no arguments; it reads the password from stdin.");
  process.exit(1);
}

/** Hidden prompt on a terminal: raw mode, no echo, Backspace and Ctrl-C handled. */
function prompt(label: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(label);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\u0003") { process.stderr.write("\n"); process.exit(130); }
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

let password: string;
if (process.stdin.isTTY) {
  password = await prompt("Password: ");
  if ((await prompt("Again: ")) !== password) {
    console.error("The two entries did not match.");
    process.exit(1);
  }
} else {
  password = await readPiped();
}
if (password.length < 12 || password.length > MAX_PASSWORD_LENGTH) {
  console.error(`Use a password of 12-${MAX_PASSWORD_LENGTH} characters.`);
  process.exit(1);
}
console.log(await hashPassword(password));
