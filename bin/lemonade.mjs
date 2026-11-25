#!/usr/bin/env node
/**
 * `npx lemonade-host …` — the whole entry point.
 *
 * Argument parsing is by hand and stays that way: a flag parser is a
 * dependency, and this package's promise is that `npx lemonade-host deploy`
 * downloads one thing and runs.
 *
 * EVERY ERROR PATH PRINTS SOMETHING A PERSON CAN ACT ON. Everything we
 * anticipated is a sentence and a fix; with --json it is a JSON object on
 * stdout (exit 1) so a script can read it. Even an unexpected exception is
 * a sentence, never a stack trace at somebody publishing their first
 * website: set LEMONADE_DEBUG=1 to see the trace when reporting a bug.
 */

import { deploy, login, Refused, rollback, status, whoami } from "../src/commands.mjs";

const USAGE = `npx lemonade-host: publish a folder to Lemonade Host

  npx lemonade-host deploy [folder]   zip it and publish it (defaults to the built output)
  npx lemonade-host status            the last deploys for this site, with ids and failures
  npx lemonade-host rollback [id]     go back to an earlier version
  npx lemonade-host login             approve this computer in your browser (or --token lm_… to paste one)
  npx lemonade-host whoami            check the token, and which site it reaches

Options
  --token lm_…       a deploy token (or set LEMONADE_TOKEN)
  --dir FOLDER       which folder to publish (same as the positional argument)
  --site st_…        which site (only needed if you name one yourself)
  --origin URL       point at another instance, e.g. staging
  --yes, -y          do not ask first
  --json             machine-readable output, errors included
  --allow-project-root  let deploy publish a project folder (source, package.json) when no build folder is found
  --include-hidden   publish dotfiles and node_modules too (secret files, like .env and keys, are never published)
  --version, -v      print the version
  --help, -h         this (or: npx lemonade-host help <command>)

Installed globally the command is just: lemonade
A token reaches exactly one site. A Read-only token can read; a Publish token
can also publish and roll back. It cannot spend money, cancel anything, or see
another site.
`;

const HELP = {
  deploy: `npx lemonade-host deploy [folder]

Zip a folder and publish it to your site.

  folder           what to publish. With none, it picks dist/, build/, out/,
                   public/ or _site/ if one holds an index.html; if none does it
                   asks before publishing the current folder (default No).
  --dir FOLDER     the same as the folder argument
  --yes, -y        do not ask (CI). It never publishes a project root: with no
                   folder named and no build folder, a folder that holds
                   package.json, src/, .git or .env is refused (exit code 2).
  --allow-project-root  publish that project folder anyway (rare; usually you want dist/)
  --include-hidden also publish dotfiles and node_modules. Secret files (.env,
                   .env.*, *.pem, *.key, credentials.json, ssh keys) are never published.
  --json           print the server's answer as JSON

It says "Live." only when the site is serving. Otherwise it tells you the
version is checking, waiting for you to publish the site, or offline.
Exit code: 0 published (or checking), 1 offline or refused, 2 a project root was not published.
`,
  status: `npx lemonade-host status

The site's address and its last deploys: id, when, how it arrived, whether it
worked, and why it failed if it did. The live one is marked.
`,
  rollback: `npx lemonade-host rollback [id]

Put an earlier version back live.

  id        the version to restore (from: npx lemonade-host status). With none,
            the newest version that was live before the current one.
  --yes     do not ask first

Needs a token with the Publish scope or higher. Versions stay restorable for 7 days.
`,
  login: `npx lemonade-host login

Approve this computer in your browser: it shows a short code and a page, you
sign in there, pick your site and press Approve. Nothing to copy.

  --token lm_…   paste a token from Developers > Tokens instead (no browser)
  --wait         wait for approval even without a terminal (an assistant that relays the code)

With no terminal and no --token it stops at once rather than waiting.
`,
  whoami: `npx lemonade-host whoami

Check that the token works and which site it reaches, with its scope and
whether the site is live. A token that ended or was revoked says so.
`,
};

const BOOLEAN = new Set(["yes", "y", "json", "include-hidden", "allow-project-root", "help", "h", "version", "v", "wait"]);
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
    if (name === "json") flags.json = true; // known before anything else can fail, so even a bad flag answers in JSON
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

const COMMANDS = { deploy, status, rollback, login, whoami };

let jsonMode = process.argv.includes("--json");

async function main() {
  const { args, flags } = parse(process.argv.slice(2));
  jsonMode = Boolean(flags.json);

  if (flags.version || flags.v) {
    const { default: pkg } = await import("../package.json", { with: { type: "json" } });
    console.log(pkg.version);
    return 0;
  }
  const command = args.shift();
  // `help [command]` and `<command> --help`: per-command help. Asking for help
  // is not an error: exit 0 so a script that pipes it does not fail.
  if (command === "help") {
    const named = args.shift();
    console.log(named && HELP[named] ? HELP[named] : USAGE);
    return 0;
  }
  if (flags.help || flags.h) {
    console.log(command && HELP[command] ? HELP[command] : USAGE);
    return 0;
  }
  if (!command) {
    console.log(USAGE);
    return 1;
  }
  const run = COMMANDS[command];
  if (!run) {
    throw new Refused(`Unknown command: ${command}\n\n${USAGE}`, { code: "unknown_command" });
  }
  // The two spellings of the same intent, normalised once.
  flags.yes = flags.yes || flags.y || false;
  flags.includeHidden = flags["include-hidden"] || false;
  flags.allowProjectRoot = flags["allow-project-root"] || false;
  return (await run(args, flags)) ?? 0;
}

/** One place that turns any failure into output: JSON for scripts, sentences for people. */
function fail(err) {
  const expected = err instanceof Refused || err?.expected;
  const message = expected ? err.message : `Something unexpected went wrong: ${err?.message ?? err}\n  Nothing was published. If it happens again, email support@lemonadehost.com.`;
  if (jsonMode) {
    console.log(
      JSON.stringify({
        ok: false,
        error: err?.code ?? (expected ? "refused" : "unexpected"),
        message,
        ...(err?.status ? { status: err.status } : {}),
        ...(err?.retryAfter ? { retryAfter: err.retryAfter } : {}),
      }),
    );
  } else {
    console.error(`\n${message}`);
    if (!expected && process.env.LEMONADE_DEBUG) console.error(err?.stack ?? err);
  }
  process.exit(err?.exitCode ?? 1);
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch(fail);
