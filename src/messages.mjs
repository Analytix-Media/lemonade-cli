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
    "That token was refused. Run: lemonade login  (you approve it in your browser), or make a new one in your dashboard under Developers.",
  not_found:
    "No site with that id, or this token was minted for a different one. A token reaches exactly one site — check the id with: lemonade whoami",

  /* traffic */
  deploy_in_progress:
    "A deploy for this site is already running. Wait for it to finish — it will not be long.",
  rate_limited:
    "Too many deploys in a row for this site. Wait a minute and try again.",
  too_large:
    "That folder is over the 256 MB upload limit. Publish the built output rather than the whole project — dist/ or build/ — or drop the largest files.",
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

  /* the box */
  site_not_found: "That site no longer exists.",
  failed:
    "The deploy failed on our side. Nothing changed — your previous version is still live. If it happens twice, email support@lemonadehost.com.",
};

export function explain(code, fallbackMessage) {
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (fallbackMessage) return fallbackMessage;
  if (code) return `The server refused it: ${code}`;
  return "The server refused it.";
}
