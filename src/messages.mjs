/**
 * The server's error codes, in words somebody can act on.
 *
 * WHY THIS FILE. The deploy API's gauntlet is precise and its codes are
 * short — `zip_slip`, `absolute_path`, `too_many_entries`. Printing those
 * verbatim to somebody publishing their first website tells them nothing
 * except that they have done something wrong. Every line here names the
 * cause and the fix, in that order, and never blames the customer for a
 * limit they were never shown.
 *
 * Anything unmapped falls through to the raw code, which is still better
 * than a spinner that stops. New codes on the server should appear here,
 * but a missing one degrades to legible rather than to silence.
 */

export const MESSAGES = {
  /* auth and scope */
  unauthorized:
    "That token was refused. Run: npx lemonade-host login  (you approve it in your browser), or make a new one in your dashboard under Developers > Tokens.",
  missing_permission:
    "This token isn't allowed to do that. Make a new one in your dashboard under Developers > Tokens, with a Publish or Manage scope.",
  not_found:
    "No site with that id, or this token was minted for a different one. A token reaches exactly one site — check the id with: npx lemonade-host whoami",

  /* traffic */
  deploy_in_progress:
    "A deploy for this site is already running. Wait for it to finish — it will not be long.",
  // {wait} is filled from the server's Retry-After and {limit} from its limit header, when it sends one (see explain).
  rate_limited: "Too many deploys in a row for this site. {limit} Try again in {wait}.",
  slow_down: "Too many requests. {limit} Try again in {wait}.",
  server_busy: "The publish queue is full right now. Nothing was published; try again in {wait}.",
  too_large:
    "That folder is over the 100 MB upload limit. Publish the built output rather than the whole project — dist/ or build/ — or drop the largest files.",
  empty_body: "There was nothing to upload.",
  upload_interrupted:
    "The upload stopped part-way. Nothing was published; run it again.",

  /* the gauntlet — a valid request with content we will not extract */
  zip_slip:
    "One of the paths in that folder points outside itself. Re-export it from your editor or build tool rather than zipping it by hand.",
  absolute_path:
    "One of the paths is absolute. Deploy from inside the folder you want published, not from its parent.",
  symlink:
    "That folder contains a symbolic link. Links are not published — replace it with the real file.",
  too_many_entries:
    "Over 20,000 files. Publish the built output rather than the whole project.",
  file_too_large:
    "One file is over 25 MB. A video or a raw photo usually — host it elsewhere and link to it.",
  quota_exceeded:
    "That release would take the site over its 1 GB of storage.",
  not_a_zip: "The upload did not arrive as a readable archive. Try again.",

  /* rolling back */
  no_such_release: "No release with that id on this site. Run: npx lemonade-host status  to see the ids.",
  already_live: "That version is already the one live.",
  release_expired: "That version is older than 7 days, so it can't be restored any more.",
  template_not_entitled: "That version used a design this site no longer has. Pick a newer version.",
  never_live: "That version never went live, so there is nothing to go back to. Pick one marked live before.",
  scan_pending: "That version is still being checked, so it can't be restored yet. Try again in a few minutes.",

  /* what a finished publish says (the catalog's lines, by state) */
  waiting: "Checking your files, live in a moment. Your previous version keeps serving until the check passes.",
  scan_pending_publish: "Uploaded. We're still checking the files; the site shows the previous version until that passes.",
  not_live_yet: "Uploaded, but the site isn't live yet. Publish it from your dashboard and this version goes live the moment you do.",
  blocked: "Uploaded, but this version is offline. Our safety check flagged it and it is under review. Nothing was deleted; check your email.",

  /* why a token was not accepted (from /api/deploy/whoami "reason") */
  revoked: "This token was revoked, so it isn't accepted any more. Make a new one in Developers > Tokens, or run: npx lemonade-host login",
  ended: "This token has ended, so it isn't accepted any more. Make a new one in Developers > Tokens, or run: npx lemonade-host login",
  site_in_trash: "The site this token belongs to is in the trash. Restore it from Trash in your dashboard, or log in for another site: npx lemonade-host login",
  not_accepted: "This token isn't accepted. Check that you copied all of it (it starts with lm_), or run: npx lemonade-host login",

  /* the box */
  site_not_found: "That site no longer exists.",
  failed:
    "The deploy failed on our side. Nothing changed — your previous version is still live. If it happens twice, email support@lemonadehost.com.",
};

/** "2732 seconds" is not a sentence: 45 minutes is. */
export function waitWords(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "a minute";
  if (n < 90) return `${Math.ceil(n)} seconds`;
  if (n < 5400) return `${Math.ceil(n / 60)} minutes`;
  const h = Math.ceil(n / 3600);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * The clock time (local, HH:MM) when it is fine to try again, with the date
 * when that is not today: "14:32", or "02:10 on Nov 25".
 */
export function retryClock(seconds, now = new Date()) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Rounded UP to the minute, so the clock never says a time that is still too early.
  const at = new Date(Math.ceil((now.getTime() + n * 1000) / 60000) * 60000);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  if (sameDay) return time;
  const month = at.toLocaleString("en-US", { month: "short" });
  return `${time} on ${month} ${at.getDate()}`;
}

/** "46 minutes, at 14:32": how long, and when. Without a Retry-After it only says "a minute". */
export function retryWords(seconds, now = new Date()) {
  const clock = retryClock(seconds, now);
  return clock ? `${waitWords(seconds)}, at ${clock}` : waitWords(seconds);
}

/** The server's limit as a sentence, or the plain version when it did not send one. */
export function limitWords(limit) {
  const n = Number(limit);
  return Number.isFinite(n) && n > 0
    ? `The limit is ${Math.floor(n)} requests of this kind.`
    : "You have reached the limit for this kind of request.";
}

/**
 * The sentence for a server error. `retryAfter` is the Retry-After header in
 * seconds (rate limits and a busy server send it); without one it says "a
 * minute". `limit` is RateLimit-Limit / X-RateLimit-Limit (or a JSON `limit`)
 * when the server sends it. The server's own `message` is used when we have no
 * line for the code. `now` is injectable for tests.
 */
export function explain(code, fallbackMessage, { retryAfter = null, limit = null, now = new Date() } = {}) {
  const line = code && MESSAGES[code] ? MESSAGES[code] : fallbackMessage ? fallbackMessage : code ? `The server refused it: ${code}` : "The server refused it.";
  return line.replace("{wait}", retryWords(retryAfter, now)).replace("{limit}", limitWords(limit));
}
