#!/usr/bin/env node
/**
 * `npx lemonade …` — the whole entry point.
 *
 * Argument parsing is by hand and stays that way: a flag parser is a
 * dependency, and this package's promise is that `npx lemonade deploy`
 * downloads one thing and runs.
 *
 * EVERY ERROR PATH PRINTS SOMETHING A PERSON CAN ACT ON. An unexpected
 * exception still prints its stack, because hiding one from whoever has to
 * report it helps nobody — but everything we anticipated is a sentence and
 * a fix, never a stack trace at somebody publishing their first website.
 */

import { deploy, login, Refused, status, whoami } from "../src/commands.mjs";

const USAGE = `lemonade — publish a folder to Lemonade Host

  lemonade deploy [folder]   zip it and publish it (defaults to the built output)
  lemonade status            the last few deploys for this site
  lemonade login             approve this computer in your browser (or --token lm_… to paste one)
  lemonade whoami            check the token, and which site it reaches

Options
  --token lm_…       a deploy token (or set LEMONADE_TOKEN)
  --dir FOLDER       which folder to publish (same as the positional argument)
  --site st_…        which site — only needed if the token reaches more than one
  --origin URL       point at another instance, e.g. staging
  --yes, -y          do not ask before publishing
  --json             machine-readable output
  --include-hidden   publish dotfiles and node_modules too
  --version, -v      print the version
  --help, -h         this

A token reaches exactly one site and can only publish to it and read its
deploy history. It cannot spend money, cancel anything, or see another site.
`;

const BOOLEAN = new Set(["yes", "y", "json", "include-hidden", "help", "h", "version", "v"]);
const VALUED = new Set(["token", "site", "origin", "dir"]);

function parse(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      args.push(arg);
      continue;
    }
    const [rawName, inline] = arg.replace(/^-+/, "").split("=");
    const name = rawName;
    if (VALUED.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Refused(`--${name} needs a value.`);
      flags[name] = value;
      continue;
    }
    if (BOOLEAN.has(name)) {
      flags[name] = true;
      continue;
    }
    throw new Refused(`Unknown option: ${arg}\n\n${USAGE}`);
  }
  return { args, flags };
}

const COMMANDS = { deploy, status, login, whoami };

async function main() {
  const { args, flags } = parse(process.argv.slice(2));

  if (flags.version || flags.v) {
    const { default: pkg } = await import("../package.json", { with: { type: "json" } });
    console.log(pkg.version);
    return 0;
  }
  const command = args.shift();
  // Asking for help is not an error: `lemonade --help` exits 0 so a script
  // that pipes it does not fail. Running `lemonade` with nothing at all IS
  // a usage error, and exits 1.
  if (flags.help || flags.h) {
    console.log(USAGE);
    return 0;
  }
  if (!command) {
    console.log(USAGE);
    return 1;
  }
  const run = COMMANDS[command];
  if (!run) {
    console.error(`Unknown command: ${command}\n`);
    console.error(USAGE);
    return 1;
  }
  // The two spellings of the same intent, normalised once.
  flags.yes = flags.yes || flags.y || false;
  flags.includeHidden = flags["include-hidden"] || false;
  return (await run(args, flags)) ?? 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    if (err instanceof Refused || err?.expected) {
      console.error(`\n${err.message}`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });
