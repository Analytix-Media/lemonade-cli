/**
 * Where the token comes from, and where it is allowed to be written.
 *
 * PRECEDENCE, highest first: a flag, then the environment, then `~/.lemonade`.
 * CI sets the environment and must beat a stale file left on a shared
 * runner; a human typing `--site` means this run and must beat both.
 *
 * THE FILE IS 0600 AND IS CHECKED. A deploy token in a world-readable file
 * in a home directory is the failure this whole shape exists to avoid, so
 * `load()` REFUSES a file anyone else can read rather than quietly using
 * it — the same posture the app takes with its own credentials file. It
 * says how to fix it in one line the reader can paste.
 *
 * AND IT IS NEVER PRINTED. Nothing in this package writes a raw token to
 * stdout, stderr or an error message. A token echoed once is a token in a
 * terminal's scrollback, a CI log and whatever screenshot follows.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_PATH = path.join(os.homedir(), ".lemonade");
export const DEFAULT_ORIGIN = "https://app.lemonadehost.com";

/** Everything the commands need, resolved. Never contains a printed token. */
export function resolve(flags = {}) {
  const file = load();
  const origin =
    flags.origin ?? process.env.LEMONADE_ORIGIN ?? file.origin ?? DEFAULT_ORIGIN;
  return {
    token: flags.token ?? process.env.LEMONADE_TOKEN ?? file.token ?? null,
    site: flags.site ?? process.env.LEMONADE_SITE ?? file.site ?? null,
    origin: origin.replace(/\/+$/, ""),
    // Where each one came from, for the error messages. Saying "no token"
    // to somebody who has one in ~/.lemonade and a typo in the env is not
    // an answer.
    from: {
      token: flags.token ? "--token" : process.env.LEMONADE_TOKEN ? "LEMONADE_TOKEN" : file.token ? CONFIG_PATH : null,
      site: flags.site ? "--site" : process.env.LEMONADE_SITE ? "LEMONADE_SITE" : file.site ? CONFIG_PATH : null,
    },
  };
}

export function load() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const stat = fs.statSync(CONFIG_PATH);
  // Group or other can read it. On Windows the mode bits are not meaningful,
  // so this only bites where it means something.
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(
      `${CONFIG_PATH} is readable by other users, and it holds a deploy token.\n` +
        `  Fix it with:  chmod 600 ${CONFIG_PATH}\n` +
        `  Or revoke the token in your dashboard and mint a new one.`,
    );
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error(`${CONFIG_PATH} is not valid JSON. Delete it and run: lemonade login`);
  }
}

export function save(next) {
  const body = JSON.stringify({ ...load(), ...next }, null, 2) + "\n";
  // Written 0600 from the first byte — creating it 0644 and chmod-ing after
  // leaves a window in which it is readable, and that window is exactly
  // when a backup or a file watcher would see it.
  fs.writeFileSync(CONFIG_PATH, body, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(CONFIG_PATH, 0o600);
  return CONFIG_PATH;
}

/** `lm_` + 40 base64url chars, as minted by the dashboard. */
export function looksLikeToken(raw) {
  return typeof raw === "string" && /^lm_[A-Za-z0-9_-]{20,120}$/.test(raw.trim());
}

/** `st_` + an opaque id. Accepts a pasted URL and pulls the id out of it. */
export function normalizeSite(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const fromUrl = trimmed.match(/\/sites\/(st_[A-Za-z0-9_-]+)/);
  const id = fromUrl ? fromUrl[1] : trimmed;
  return /^st_[A-Za-z0-9_-]+$/.test(id) ? id : null;
}
