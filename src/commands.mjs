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

function requireAuth(flags) {
  const cfg = resolve(flags);
  if (!cfg.token) {
    throw new Refused(
      "No deploy token.\n" +
        "  Mint one in your dashboard under Deploy tools, then run: lemonade login\n" +
        "  Or set LEMONADE_TOKEN in the environment (which is what CI wants).",
    );
  }
  if (!looksLikeToken(cfg.token)) {
    throw new Refused(
      `That does not look like a deploy token (they start with lm_).\n` +
        `  It came from ${cfg.from.token}.`,
    );
  }
  if (!cfg.site) {
    throw new Refused(
      "No site id.\n" +
        "  Pass --site st_… , set LEMONADE_SITE, or run: lemonade login\n" +
        "  The id is in the address bar of the site's page in your dashboard.",
    );
  }
  const site = normalizeSite(cfg.site);
  if (!site) {
    throw new Refused(`"${cfg.site}" is not a site id — they look like st_….`);
  }
  return { ...cfg, site };
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
  const cfg = requireAuth(flags);
  const { dir, guessed } = chooseDir(args[0]);

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
  const cfg = requireAuth(flags);
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
    const when = row.createdAt ? new Date(row.createdAt).toISOString().replace("T", " ").slice(0, 16) : "";
    const mark = row.status === "active" ? green("●") : row.status === "failed" ? "✗" : dim("○");
    console.log(
      `${mark} ${when}  ${String(row.status).padEnd(10)} ${dim(`${row.source ?? ""} ${row.fileCount ?? ""} files`)}`,
    );
  }
  return 0;
}

/* ── whoami ──────────────────────────────────────────────────────────────── */

export async function whoami(_args, flags) {
  const cfg = requireAuth(flags);
  // Asking the SERVER rather than reading the config back: the question is
  // "does this token still work, and what does it reach", and only one of
  // those two can be answered locally.
  await call(cfg, `${cfg.origin}/api/deploy/${cfg.site}/deployments`);
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, site: cfg.site, origin: cfg.origin }, null, 2));
    return 0;
  }
  console.log(`Token is valid and reaches ${bold(cfg.site)}`);
  console.log(dim(`  ${cfg.origin} · token from ${cfg.from.token}, site from ${cfg.from.site}`));
  return 0;
}

/* ── login ───────────────────────────────────────────────────────────────── */

export async function login(_args, flags) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log("Mint a deploy token in your dashboard, under Deploy tools.");
    console.log(dim("It is shown once — there is no copy on our side to read back.\n"));

    const token = (flags.token ?? (await rl.question("Deploy token (lm_…): "))).trim();
    if (!looksLikeToken(token)) {
      throw new Refused("That does not look like a deploy token — they start with lm_.");
    }
    const siteRaw = flags.site ?? (await rl.question("Site id (st_…, or paste the URL): "));
    const site = normalizeSite(siteRaw);
    if (!site) throw new Refused("That is not a site id — they look like st_….");

    const origin = (flags.origin ?? process.env.LEMONADE_ORIGIN ?? "https://app.lemonadehost.com").replace(/\/+$/, "");

    // Proved before it is saved. Writing an unverified token means the
    // first real deploy is where you learn it was wrong, and by then the
    // one place the raw token existed has usually been closed.
    const probe = { token, site, origin, from: { token: "prompt", site: "prompt" } };
    await call(probe, `${origin}/api/deploy/${site}/deployments`);

    const where = save({ token, site, origin });
    console.log(`\n${green("Saved.")} ${dim(where)} (readable only by you)`);
    console.log(dim("Now: lemonade deploy"));
    return 0;
  } finally {
    rl.close();
  }
}

export const CONFIG_FILE = CONFIG_PATH;
