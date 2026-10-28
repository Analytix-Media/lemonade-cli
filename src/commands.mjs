/**
 * The four commands, and the one HTTP call underneath them.
 *
 * Everything here talks to the deploy API a browser session also uses — the
 * CLI is an adapter onto it, not a second way in, so the gate order it meets
 * (401 → concealed 404 → 409 → 429 → 413 → the gauntlet) is the same one the
 * portal meets and is pinned by the app's own specs.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { CONFIG_PATH, looksLikeToken, normalizeSite, resolve, save } from "./config.mjs";
import { explain } from "./messages.mjs";
import { collect, zipFiles } from "./zip.mjs";
import { deviceLogin } from "./device.mjs";

const MAX_UPLOAD = 256 * 1024 * 1024;

/** Folders that hold BUILT output, in the order we would guess. */
const BUILD_DIRS = ["dist", "build", "out", "public", "_site"];

const bold = (s) => (stdout.isTTY ? `\u001b[1m${s}\u001b[0m` : s);
const dim = (s) => (stdout.isTTY ? `\u001b[2m${s}\u001b[0m` : s);
const green = (s) => (stdout.isTTY ? `\u001b[32m${s}\u001b[0m` : s);

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A CLI error that is the user's situation, not a stack trace. */
export class Refused extends Error {
  constructor(message, { code = null } = {}) {
    super(message);
    this.code = code;
    this.expected = true;
  }
}

/** CI has no person to approve anything: a token comes from the environment there. */
const inCI = () => Boolean(process.env.CI) && process.env.CI !== "false";

/**
 * The token, or, with none anywhere and a person present, the browser
 * approval (src/device.mjs), saved for next time. In CI it refuses with
 * the one fix: LEMONADE_TOKEN.
 */
async function ensureAuth(flags) {
  const cfg = resolve(flags);
  // Only with a person at a terminal: a script (or an AI assistant) runs `lemonade login` first, on purpose, and is never left waiting by a deploy.
  if (cfg.token || inCI() || flags.json || !stdin.isTTY) return requireAuth(flags);
  const got = await approveInBrowser(cfg.origin);
  return requireAuth({ ...flags, token: got.token, site: got.site.id });
}

async function approveInBrowser(origin) {
  const got = await deviceLogin({ origin, client: process.env.LEMONADE_CLIENT === "mcp" ? "mcp" : "cli" });
  const where = save({ token: got.token, site: got.site.id, origin });
  console.log(`\n${green("Approved.")} Publishing to ${bold(got.site.name)}${got.site.address ? ` (${got.site.address})` : ""}`);
  console.log(dim(`  Saved to ${where} (readable only by you).`));
  return got;
}

function requireAuth(flags) {
  const cfg = resolve(flags);
  if (!cfg.token) {
    throw new Refused(
      "No deploy token.\n" +
        "  Run: lemonade login  (you approve it in your browser)\n" +
        "  Or set LEMONADE_TOKEN in the environment (which is what CI wants).",
    );
  }
  if (!looksLikeToken(cfg.token)) {
    throw new Refused(
      `That does not look like a deploy token (they start with lm_).\n` +
        `  It came from ${cfg.from.token}.`,
    );
  }
  // The site is OPTIONAL here. A token is minted for exactly one site, so
  // the credential already implies it — asking for both was making people
  // repeat something we know, and it made the documented promise ("set
  // LEMONADE_TOKEN once and never touch it again") untrue. When it is
  // absent, ask the server: `resolveSite` below.
  const site = cfg.site ? normalizeSite(cfg.site) : null;
  if (cfg.site && !site) {
    throw new Refused(`"${cfg.site}" is not a site id — they look like st_….`);
  }
  return { ...cfg, site };
}

/**
 * The site this run is about: the one configured, or the one the token was
 * minted for. One round trip, and only when it is needed.
 */
async function resolveSite(cfg) {
  if (cfg.site) return cfg.site;
  const me = await call(cfg, `${cfg.origin}/api/deploy/whoami`);
  if (!me.site) {
    throw new Refused(
      "That token did not resolve to a site.\n  Run: lemonade login  (or make a new token in your dashboard under Developers).",
    );
  }
  return me.site;
}

/**
 * Which folder to publish.
 *
 * An explicit argument always wins. With none, a build folder is preferred
 * over the project root — publishing a repository root uploads the source,
 * the README and often a stray .env, and the thing a customer meant is
 * nearly always the built output. It says which one it chose, every time.
 */
export function chooseDir(arg, cwd = process.cwd()) {
  if (arg) {
    const abs = path.resolve(cwd, arg);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Refused(`${abs} is not a folder.`);
    }
    return { dir: abs, guessed: false };
  }
  for (const name of BUILD_DIRS) {
    const abs = path.join(cwd, name);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const hasIndex = fs.existsSync(path.join(abs, "index.html"));
      if (hasIndex) return { dir: abs, guessed: true };
    }
  }
  return { dir: cwd, guessed: false };
}

async function confirm(question) {
  if (!stdin.isTTY) return true;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return answer === "" || answer === "y" || answer === "yes";
}

async function call(cfg, url, init = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${cfg.token}`, ...(init.headers ?? {}) },
    });
  } catch (err) {
    throw new Refused(
      `Could not reach ${cfg.origin}.\n  ${err.message}\n` +
        `  Nothing was published. Check the address, or your connection.`,
    );
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* a proxy or an error page — handled below */
  }
  if (!res.ok || (body && body.ok === false)) {
    const code = body?.error ?? body?.errorCode ?? null;
    throw new Refused(explain(code, body?.message ?? null), { code });
  }
  if (!body) {
    throw new Refused(
      `${cfg.origin} answered with something that was not JSON (HTTP ${res.status}).`,
    );
  }
  return body;
}

/* ── deploy ──────────────────────────────────────────────────────────────── */

export async function deploy(args, flags) {
  const base = await ensureAuth(flags);
  // `--dir` is what the documentation has always shown; the positional form
  // is what a shell user reaches for. Both work, and the flag wins.
  const { dir, guessed } = chooseDir(flags.dir ?? args[0]);

  const { files, skipped } = collect(dir, { includeHidden: flags.includeHidden });
  if (files.length === 0) {
    throw new Refused(
      `${dir} has no files to publish.\n` +
        `  If everything in it is hidden, pass --include-hidden.`,
    );
  }

  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  const hasIndex = files.some((f) => f.rel === "index.html");

  if (!flags.json) {
    console.log(`${bold("Publishing")} ${dir}`);
    if (guessed) console.log(dim(`  chose the built output — pass a folder to override`));
    console.log(
      dim(
        `  ${files.length} file${files.length === 1 ? "" : "s"}, ${human(bytes)}` +
          (skipped.hidden || skipped.symlink || skipped.secret
            ? ` · skipped ${skipped.hidden} hidden, ${skipped.symlink} link${skipped.symlink === 1 ? "" : "s"}, ${skipped.secret} secret${skipped.secret === 1 ? "" : "s"}`
            : ""),
      ),
    );
    // Said BEFORE the upload, not after. A site with no index.html serves a
    // 404 at its own address, and finding that out from the live URL is a
    // worse minute than finding it out here.
    if (!hasIndex) {
      console.log(
        `  ${bold("No index.html at the top level")} — visitors will get a 404 at the site's address.`,
      );
    }
  }

  if (bytes > MAX_UPLOAD) {
    throw new Refused(
      `That folder is ${human(bytes)}, over the 256 MB upload limit.\n` +
        `  Publish the built output rather than the whole project.`,
    );
  }

  const cfg = { ...base, site: await resolveSite(base) };

  if (!flags.yes && !flags.json && !(await confirm(`Publish to ${cfg.site}?`))) {
    console.log("Nothing was published.");
    return 1;
  }

  const zip = zipFiles(files);
  const body = await call(cfg, `${cfg.origin}/api/deploy/${cfg.site}`, {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: zip,
  });

  if (flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return body.blocked ? 1 : 0;
  }

  // Truthful about the two states a "successful" upload can land in. The
  // app's own route learned this the hard way: a publish that the safety
  // scan blocked used to come back as a plain success, and every door
  // printed the live URL of a site that was now offline.
  if (body.blocked) {
    console.log("");
    console.log(bold("Uploaded, but this version is offline."));
    console.log(`  ${body.message ?? "Our safety check flagged it and it is under review."}`);
    console.log(dim("  Nothing was deleted. Check your email."));
    return 1;
  }

  console.log("");
  console.log(green(bold("Live.")));
  if (body.url) console.log(`  ${body.url}`);
  console.log(
    dim(`  ${body.fileCount} file${body.fileCount === 1 ? "" : "s"} · ${body.deploymentId}`),
  );
  if (body.serving === false) {
    console.log("");
    console.log(
      `  ${bold("Not serving yet")} — this site has not been published from your dashboard.`,
    );
    console.log(dim(`  Your files are here and will go live the moment it is.`));
  }
  return 0;
}

/* ── status ──────────────────────────────────────────────────────────────── */

export async function status(_args, flags) {
  const base = requireAuth(flags);
  const cfg = { ...base, site: await resolveSite(base) };
  const body = await call(cfg, `${cfg.origin}/api/deploy/${cfg.site}/deployments`);
  const rows = body.deployments ?? [];

  if (flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log("No deploys yet.");
    return 0;
  }
  for (const row of rows.slice(0, 10)) {
    // The person's own clock, not UTC (developers walkthrough, 26 Oct 2026).
    const when = row.createdAt
      ? new Date(row.createdAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "";
    const mark = row.status === "active" ? green("●") : row.status === "failed" ? "✗" : dim("○");
    const files = typeof row.fileCount === "number" ? `${row.fileCount} file${row.fileCount === 1 ? "" : "s"}` : "";
    console.log(`${mark} ${when}  ${String(row.status).padEnd(10)} ${dim(`${row.source ?? ""} ${files}`.trim())}`);
  }
  return 0;
}

/* ── whoami ──────────────────────────────────────────────────────────────── */

export async function whoami(_args, flags) {
  const cfg = requireAuth(flags);
  // Asking the SERVER rather than reading the config back: the question is
  // "does this token still work, and what does it reach", and neither half
  // can be answered locally.
  const me = await call(cfg, `${cfg.origin}/api/deploy/whoami`);
  if (flags.json) {
    console.log(JSON.stringify(me, null, 2));
    return 0;
  }
  console.log(`Token is valid and reaches ${bold(me.name)} (${me.site})`);
  console.log(`  ${me.url}`);
  if (!me.serving) {
    console.log(dim("  Not serving yet — this site has not been published from the dashboard."));
  }
  console.log(dim(`  ${cfg.origin} · token from ${cfg.from.token}`));
  return 0;
}

/* ── login ───────────────────────────────────────────────────────────────── */

export async function login(_args, flags) {
  // No token given: approve in the browser. --token keeps the paste path (CI, scripts).
  if (!flags.token) {
    const origin = (flags.origin ?? process.env.LEMONADE_ORIGIN ?? "https://app.lemonadehost.com").replace(/\/+$/, "");
    await approveInBrowser(origin);
    console.log(dim("Now: lemonade deploy"));
    return 0;
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log("Paste a deploy token from your dashboard, under Developers > Tokens.");
    console.log(dim("It is shown once — there is no copy on our side to read back.\n"));

    const token = (flags.token ?? (await rl.question("Deploy token (lm_…): "))).trim();
    if (!looksLikeToken(token)) {
      throw new Refused("That does not look like a deploy token — they start with lm_.");
    }
    const origin = (flags.origin ?? process.env.LEMONADE_ORIGIN ?? "https://app.lemonadehost.com").replace(/\/+$/, "");

    // No site prompt. The token names its own site, so asking would be
    // asking somebody to look up an id we are about to be told anyway —
    // and this is also how the token is PROVED before it is written down.
    // Saving an unverified token means the first real deploy is where you
    // learn it was wrong, by which time the one place the raw value existed
    // has usually been closed.
    const probe = { token, origin, from: { token: "prompt", site: null } };
    const me = await call(probe, `${origin}/api/deploy/whoami`);

    const where = save({ token, site: me.site, origin });
    console.log(`\n${green("Saved.")} ${dim(where)} (readable only by you)`);
    console.log(`Publishing to ${bold(me.name)} — ${me.url}`);
    console.log(dim("Now: lemonade deploy"));
    return 0;
  } finally {
    rl.close();
  }
}

export const CONFIG_FILE = CONFIG_PATH;
