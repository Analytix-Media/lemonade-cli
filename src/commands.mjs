/**
 * The commands, and the one HTTP call underneath them.
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
import { explain, MESSAGES, waitWords } from "./messages.mjs";
import { Refused } from "./errors.mjs";
import { collect, zipFiles } from "./zip.mjs";
import { deviceLogin } from "./device.mjs";

// 100 MB per upload (25 MB per file), the server's limit (decision 1, Nov 2026).
const MAX_UPLOAD = 100 * 1024 * 1024;

/** Folders that hold BUILT output, in the order we would guess. */
const BUILD_DIRS = ["dist", "build", "out", "public", "_site"];

const bold = (s) => (stdout.isTTY ? `\u001b[1m${s}\u001b[0m` : s);
const red = (s) => (stdout.isTTY ? `\u001b[31m${s}\u001b[0m` : s);
const dim = (s) => (stdout.isTTY ? `\u001b[2m${s}\u001b[0m` : s);
const green = (s) => (stdout.isTTY ? `\u001b[32m${s}\u001b[0m` : s);

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { Refused };

/** CI has no person to approve anything: a token comes from the environment there. */
const inCI = () => Boolean(process.env.CI) && process.env.CI !== "false";

/**
 * The token, or, with none anywhere and a person present, the browser
 * approval (src/device.mjs), saved for next time. In CI it refuses with
 * the one fix: LEMONADE_TOKEN.
 */
async function ensureAuth(flags) {
  const cfg = resolve(flags);
  // Only with a person at a terminal: a script (or an AI assistant) runs `npx lemonade-host login` first, on purpose, and is never left waiting by a deploy.
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
        "  Run: npx lemonade-host login  (you approve it in your browser)\n" +
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
  // absent, the commands ask the server (whoami).
  const site = cfg.site ? normalizeSite(cfg.site) : null;
  if (cfg.site && !site) {
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

/**
 * Does this folder look like a project (source, config, secrets) rather than a
 * finished site? A top-level index.html with none of the markers is a plain
 * static site and is fine. package.json, .git or .env mark a project root even
 * with an index.html; a src/ (or app/, lib/) with no index.html does too.
 */
export function looksLikeProjectRoot(dir) {
  const has = (n) => fs.existsSync(path.join(dir, n));
  if (has("package.json") || has(".git") || has(".env")) return true;
  if (has("index.html")) return false;
  return ["src", "app", "lib", "node_modules"].some((n) => has(n) && fs.statSync(path.join(dir, n)).isDirectory());
}

/** Y/n question. No terminal = no answer: callers decide what that means. */
async function confirm(question, { defaultYes = true } = {}) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  rl.close();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

/** The server's limit, if it names one: RateLimit-Limit, X-RateLimit-Limit, or a `limit` in the JSON error. */
const limitFrom = (res, body) => {
  const raw = res.headers.get("ratelimit-limit") ?? res.headers.get("x-ratelimit-limit") ?? body?.limit ?? null;
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const retryAfterSeconds = (res) => {
  const n = Number(res.headers.get("retry-after"));
  return Number.isFinite(n) && n > 0 ? n : null;
};

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
    const retryAfter = retryAfterSeconds(res);
    // A 429 or 503 without a body still has the one thing a person needs: how long.
    const code = body?.reason && body?.error === "unauthorized" ? body.reason : body?.error ?? body?.errorCode ?? (res.status === 429 ? "rate_limited" : res.status === 503 ? "server_busy" : null);
    // A refused token: the server's own sentence says why (and when it ended).
    const serverLine = body?.error === "unauthorized" && body?.message ? body.message : null;
    throw new Refused(serverLine ?? explain(code, body?.message ?? null, { retryAfter, limit: limitFrom(res, body) }), { code, status: res.status, retryAfter });
  }
  if (!body) {
    throw new Refused(
      `${cfg.origin} answered with something that was not JSON (HTTP ${res.status}).`,
    );
  }
  return body;
}

/** Who this token is and what it reaches (name for the prompts, state for the honest messages). */
async function whoIs(cfg) {
  return call(cfg, `${cfg.origin}/api/deploy/whoami`);
}

/* ── deploy ──────────────────────────────────────────────────────────────── */

export async function deploy(args, flags) {
  const base = await ensureAuth(flags);
  // `--dir` is what the documentation has always shown; the positional form
  // is what a shell user reaches for. Both work, and the flag wins.
  const explicitDir = flags.dir ?? args[0];
  const { dir, guessed } = chooseDir(explicitDir);

  // --yes means "do not ask", never "publish my source". A project root is refused
  // unless it is opted into by name. (A folder named on the command line is the person's choice.)
  if (!explicitDir && !guessed && !flags.allowProjectRoot && (flags.yes || flags.json) && looksLikeProjectRoot(dir)) {
    throw new Refused(
      `This folder looks like a project (it has source files, package.json, .git or .env), not a built site, so nothing was published.\n` +
        `  I looked for a build folder with an index.html (${BUILD_DIRS.join(", ")}) and found none.\n` +
        `  Build it, then publish that folder: npx lemonade-host deploy dist\n` +
        `  To publish this whole folder anyway, pass --allow-project-root.`,
      { code: "project_root", exitCode: 2 },
    );
  }

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
    // The secret guard is always on, even with --include-hidden: say which files stayed home.
    if (skipped.secretFiles.length) {
      console.log(dim(`  left out as secrets (never published): ${skipped.secretFiles.slice(0, 5).join(", ")}${skipped.secretFiles.length > 5 ? ", …" : ""}`));
    }
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
      `That folder is ${human(bytes)}, over the 100 MB upload limit.\n` +
        `  Publish the built output rather than the whole project.`,
    );
  }

  // No folder named and no built output found: the current folder is a guess, and it is often the
  // whole project (source, README, notes). Say so and ask, default No.
  if (!explicitDir && !guessed && !flags.allowProjectRoot) {
    if (!flags.json && !flags.yes) {
      console.log(`  ${bold("No dist, build, out, public or _site folder with an index.html here")} - this would publish the current folder as it is.`);
      if (!stdin.isTTY) {
        throw new Refused("Pass the folder to publish (npx lemonade-host deploy ./dist), or --allow-project-root to publish this one.");
      }
      if (!(await confirm("Publish the current folder anyway?", { defaultYes: false }))) {
        console.log("Nothing was published.");
        return 1;
      }
    }
  }

  const me = await whoIs(base);
  const cfg = { ...base, site: base.site ?? me.site };
  const target = `${me.name ?? cfg.site}${me.url ? ` (${me.url})` : ""}`;

  if (!flags.yes && !flags.json && stdin.isTTY && !(await confirm(`Publish to ${target}?`))) {
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

  return report(body, me);
}

/**
 * Say what actually happened, and only say "Live." when it is serving. An
 * upload can land in four states (blocked, waiting for the scan, not live
 * yet, live) and each gets its own line; possible-secret warnings print
 * whatever the state.
 */
export function report(body, me = {}) {
  console.log("");
  let code = 0;
  if (body.blocked) {
    console.log(bold("Uploaded, but this version is offline."));
    console.log(`  ${body.message ?? MESSAGES.blocked}`);
    console.log(dim("  Nothing was deleted. Check your email."));
    code = 1;
  } else if (body.waiting) {
    console.log(bold("Uploaded. Checking your files, live in a moment."));
    console.log(`  ${MESSAGES.scan_pending_publish}`);
    if (body.url) console.log(`  ${body.url}`);
  } else if (body.serving === false) {
    console.log(bold("Uploaded, but the site isn't live yet."));
    console.log(`  ${MESSAGES.not_live_yet}`);
    if (me.name) console.log(dim(`  ${me.name}`));
  } else {
    console.log(green(bold("Live.")));
    if (body.url) console.log(`  ${body.url}`);
  }
  console.log(dim(`  ${body.fileCount} file${body.fileCount === 1 ? "" : "s"} · ${body.deploymentId}`));
  if (Array.isArray(body.warnings) && body.warnings.length) {
    console.log("");
    console.log(bold("Heads up:"));
    for (const w of body.warnings) console.log(`  ${w}`);
  }
  return code;
}

/* ── status ──────────────────────────────────────────────────────────────── */

export async function status(_args, flags) {
  const base = requireAuth(flags);
  const me = await whoIs(base);
  const cfg = { ...base, site: base.site ?? me.site };
  const body = await call(cfg, `${cfg.origin}/api/deploy/${cfg.site}/deployments`);
  const rows = body.deployments ?? [];

  if (flags.json) {
    console.log(JSON.stringify({ ...body, site: { id: me.site, name: me.name, url: me.url, state: me.state ?? null } }, null, 2));
    return 0;
  }
  console.log(`${bold(me.name ?? cfg.site)}${me.url ? `  ${me.url}` : ""}`);
  if (me.state && me.state !== "live") {
    const words = { nothing_published: "Nothing is published yet.", held: "Offline while it is under review.", not_live_yet: "Not live yet - publish it from your dashboard." };
    console.log(dim(`  ${words[me.state] ?? me.state}`));
  }
  if (rows.length === 0) {
    console.log("No deploys yet.");
    return 0;
  }
  console.log("");
  for (const row of rows.slice(0, 10)) {
    // The person's own clock, not UTC (developers walkthrough, 26 Oct 2026).
    const when = row.createdAt
      ? new Date(row.createdAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "";
    const mark = row.status === "active" ? green("●") : row.status === "failed" ? red("✗") : dim("○");
    const files = typeof row.fileCount === "number" ? `${row.fileCount} file${row.fileCount === 1 ? "" : "s"}` : "";
    const live = row.status === "active" ? " (live)" : "";
    console.log(`${mark} ${when}  ${String(row.status).padEnd(10)} ${dim(`${row.id ?? ""} ${row.source ?? ""} ${files}${live}`.replace(/\s+/g, " ").trim())}`);
    // Why it failed, in the server's words (the catalog line when we have one).
    if (row.status === "failed" && (row.errorDetail || row.errorCode)) {
      console.log(`    ${red(explain(row.errorCode, row.errorDetail))}`);
    }
  }
  console.log(dim("\nGo back to an earlier version: npx lemonade-host rollback"));
  return 0;
}

/* ── rollback ────────────────────────────────────────────────────────────── */

/** The release to go back to: the one named, or the newest that was live before the current one. */
export function pickRollbackTarget(rows, wanted) {
  if (wanted) return rows.find((r) => r.id === wanted) ?? null;
  return rows.find((r) => r.status === "superseded") ?? null;
}

export async function rollback(args, flags) {
  const base = requireAuth(flags);
  const me = await whoIs(base);
  const cfg = { ...base, site: base.site ?? me.site };
  const list = await call(cfg, `${cfg.origin}/api/deploy/${cfg.site}/deployments`);
  const rows = list.deployments ?? [];
  const wanted = args[0] ?? null;
  const target = pickRollbackTarget(rows, wanted);
  if (!target) {
    throw new Refused(
      wanted
        ? `No release with the id ${wanted} on this site. Run: npx lemonade-host status  to see the ids.`
        : "There is no earlier version to go back to yet. Run: npx lemonade-host status  to see what this site has.",
      { code: wanted ? "no_such_release" : "no_earlier_version" },
    );
  }
  if (target.status === "active") throw new Refused(MESSAGES.already_live, { code: "already_live" });

  if (!flags.yes && !flags.json) {
    const when = target.createdAt ? new Date(target.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : target.id;
    if (!stdin.isTTY) throw new Refused("Rolling back needs a yes: pass --yes to go back without being asked.");
    if (!(await confirm(`Put ${me.name ?? "this site"} back to the version from ${when} (${target.id})?`))) {
      console.log("Nothing was changed.");
      return 1;
    }
  }
  const body = await call(cfg, `${cfg.origin}/api/deploy/${cfg.site}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deploymentId: target.id }),
  });
  if (flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return body.blocked ? 1 : 0;
  }
  console.log("");
  if (body.blocked) {
    console.log(bold("Restored, but that version is offline."));
    console.log(`  ${MESSAGES.blocked}`);
    return 1;
  }
  console.log(green(bold("Rolled back.")));
  console.log(`  ${body.url ?? me.url} is serving ${body.deploymentId ?? target.id} again.`);
  return 0;
}

/* ── whoami ──────────────────────────────────────────────────────────────── */

export async function whoami(_args, flags) {
  const cfg = requireAuth(flags);
  // Asking the SERVER rather than reading the config back: the question is
  // "does this token still work, and what does it reach", and neither half
  // can be answered locally.
  const me = await whoIs(cfg);
  if (flags.json) {
    console.log(JSON.stringify(me, null, 2));
    return 0;
  }
  console.log(`Token is valid and reaches ${bold(me.name)} (${me.site})`);
  console.log(`  ${me.url}`);
  if (me.access) console.log(dim(`  Scope: ${{ "read-only": "Read-only", publish: "Publish", manage: "Manage" }[me.access] ?? me.access}`));
  if (me.state === "nothing_published") console.log(dim("  Nothing is published yet."));
  else if (me.state === "held") console.log(dim("  Offline while it is under review."));
  else if (me.state === "not_live_yet" || me.serving === false) console.log(dim("  Not live yet - this site has not been published from the dashboard."));
  console.log(dim(`  ${cfg.origin} · token from ${cfg.from.token}`));
  return 0;
}

/* ── login ───────────────────────────────────────────────────────────────── */

export async function login(_args, flags) {
  // Browser approval by default. It needs a person, so with no terminal it
  // refuses at once (a pipe used to wait ten minutes for nobody) unless
  // --token is given, or the caller says it will relay the code (--wait,
  // or LEMONADE_CLIENT=mcp for an AI assistant).
  if (!flags.token) {
    const relayed = flags.wait || process.env.LEMONADE_CLIENT === "mcp";
    if (!stdin.isTTY && !stdout.isTTY && !relayed) {
      throw new Refused(
        "Logging in by browser needs a terminal, and this isn't one.\n" +
          "  Run it in a terminal, or pass a token:  npx lemonade-host login --token lm_...\n" +
          "  An assistant that will show you the code can pass --wait.",
      );
    }
    const origin = (flags.origin ?? process.env.LEMONADE_ORIGIN ?? "https://app.lemonadehost.com").replace(/\/+$/, "");
    await approveInBrowser(origin);
    console.log(dim("Now: npx lemonade-host deploy"));
    return 0;
  }
  console.log("Checking that token...");
  const token = String(flags.token).trim();
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
  const probe = { token, origin, from: { token: "--token", site: null } };
  const me = await whoIs(probe);

  const where = save({ token, site: me.site, origin });
  console.log(`\n${green("Saved.")} ${dim(where)} (readable only by you)`);
  console.log(`Publishing to ${bold(me.name)} — ${me.url}`);
  console.log(dim("Now: npx lemonade-host deploy"));
  return 0;
}

export const CONFIG_FILE = CONFIG_PATH;
export { waitWords };
