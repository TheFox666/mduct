import { listSecretNames, rmSecret, setSecret } from "../shared/secrets";

/** `mduct secret set|list|rm`. `set` reads the value from stdin (pipe) or a hidden TTY prompt. */
export async function cmdSecret(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === "list") {
    for (const n of listSecretNames()) console.log(n);
    return 0;
  }
  if (sub === "rm") {
    if (!argv[1]) { console.error("usage: mduct secret rm <NAME>"); return 1; }
    rmSecret(argv[1]);
    console.log(`removed secret: ${argv[1]}`);
    return 0;
  }
  if (sub === "set") {
    const name = argv[1];
    if (!name) { console.error("usage: mduct secret set <NAME>   (value from stdin or hidden prompt)"); return 1; }
    let value: string;
    if (!process.stdin.isTTY) {
      value = (await new Response(Bun.stdin.stream()).text()).replace(/\n$/, "");
    } else {
      process.stdout.write(`value for ${name} (hidden): `);
      value = (await readHidden()).replace(/\n$/, "");
    }
    if (!value) { console.error("empty value — nothing stored"); return 1; }
    setSecret(name, value);
    console.log(`stored secret: ${name}`);
    return 0;
  }
  console.error("usage: mduct secret set <NAME> | mduct secret list | mduct secret rm <NAME>");
  return 1;
}

/** Read one line from the TTY without echoing it. */
async function readHidden(): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // @ts-expect-error _writeToOutput is the standard trick to suppress echo
  rl._writeToOutput = () => {};
  return await new Promise((resolve) => rl.question("", (a) => { rl.close(); process.stdout.write("\n"); resolve(a); }));
}
