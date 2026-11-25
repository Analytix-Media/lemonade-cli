# Changelog

## 0.2.1

- `deploy --yes` (and `--json`) in a project root with no build folder no longer publishes the whole project. It refuses with exit code 2, names the build folders it looked for, and says how to publish one (`npx lemonade-host deploy dist`). The new `--allow-project-root` flag is the explicit opt-in. A folder you name yourself is unchanged.
- Rate limit messages now say the clock time to try again (local time, with the date if it is not today), for example "Try again in 46 minutes, at 14:32." They also say the limit when the server sends it (RateLimit-Limit, X-RateLimit-Limit or a `limit` field in the error). The server does not send one today, so for now the message says "You have reached the limit for this kind of request." with no number; the number appears on its own once the server adds the header.
- The "folder too large" message said 256 MB; the upload limit is 100 MB.

## 0.2.0

**Login by browser, rollback, honest deploys.**

- `login` approves this computer in your browser by default (a short code, nothing to copy). With no terminal it stops at once instead of waiting ten minutes; `--token lm_…` pastes a token, and `--wait` is for an assistant that will relay the code.
- New `rollback [id]`: puts the newest earlier version back live (or the one you name), asks first unless `--yes`, and explains a token that lacks permission.
- `status` shows the site's address, each deploy's id and source, the live one marked, and why a failed deploy failed.
- `deploy` only says "Live." when the site is serving. It also says when a version is still being checked, is waiting for you to publish the site, or is offline, and it prints possible-secret warnings.
- `deploy` with no folder named and no `dist`, `build`, `out`, `public` or `_site` asks before publishing the current folder (default No), and the question names your site, not its id.
- Rate limits say how long to wait, from the server's Retry-After ("46 minutes", not "a minute").
- `--json` failures are JSON on stdout with an `error` code and exit code 1.
- Expected errors never print a stack trace (set `LEMONADE_DEBUG=1` to see one).
- A token from `--token` or `LEMONADE_TOKEN` no longer borrows the site saved by an earlier `login`.
- Messages say `npx lemonade-host`, the name that works without installing anything.
- Secret files (`.env`, `.env.*`, `*.pem`, `*.key`, `credentials.json`, SSH keys) are never published, even with `--include-hidden`.
- `help <command>` and `<command> --help` give per-command help.
- Upload limit text matches the server: 100 MB per upload, 25 MB per file.

Needs the 0.2.0 server changes (whoami returns the live state and token reasons; the device endpoint accepts `device_name`).

## 0.1.2

Browser sign-in (`login`) and the first approved-in-the-browser deploy. Unreleased 0.1.x work lived on the `device-login` branch.
