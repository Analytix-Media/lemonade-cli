# lemonade-host

Publish a folder to [Lemonade Host](https://lemonadehost.com) from your terminal.

> The package is **`lemonade-host`**. The plain `lemonade` name on npm
> belongs to somebody else, so `npx lemonade …` would download and run their
> package, not this one. Installed globally the command is still `lemonade`.

```bash
npx lemonade-host deploy
```

That's the whole thing. It zips the current folder, uploads it, and prints
the live URL.

## Setup, once

```bash
npx lemonade-host login
```

It shows a short code and a page to open. Sign in there, check the code
matches, pick your site and press Approve (we email you a 6-digit code to
confirm it is you). The terminal picks it up by itself: no token to copy.
The first `lemonade deploy` does the same if you have not logged in yet, so
an AI assistant running it for you only needs you to approve once.

What it saves can publish to that one site and read what is live. It is
written to `~/.lemonade` with permissions only you can read, and it stops
working after 90 days unused. In CI, set `LEMONADE_TOKEN` instead (make a
token in your dashboard under Developers > Tokens); CI never waits for a
browser.

## Commands

| | |
|---|---|
| `lemonade deploy [dir]` | Zip a folder and publish it. Defaults to `.`, and prefers `dist/`, `build/`, `out/` or `public/` if one exists. `--dir` does the same thing |
| `lemonade status` | The last few deploys for this site |
| `lemonade login` | Approve this computer in your browser (or `--token` to paste one) |
| `lemonade whoami` | Which site the current token points at |

Useful flags: `--dir`, `--token`, `--origin` (for staging), `--yes` (skip
the confirmation), `--json` (machine-readable output).

## A token reaches exactly one site

A `lm_` token is minted for a single site. Every token can read that site
and publish a release to it. Two more permissions are off unless you tick
them when you make the token: rolling back to an earlier version, and moving
the site to the trash (which takes it offline). A token cannot spend money,
change an address, or see another site, and without the trash permission it
cannot take the site offline - so leaving a default token in a CI secret is a
bounded risk rather than an open door.

A request the token was not given is refused with a message naming the
permission it needs. `lemonade whoami --json` shows the token's permissions.
Tokens made before permissions existed can read, publish and roll back.

Revoke one any time in your dashboard under Developers > Tokens.

## In CI

```yaml
- run: npx lemonade-host deploy ./dist --yes
  env:
    LEMONADE_TOKEN: ${{ secrets.LEMONADE_TOKEN }}
```

Exit code is 0 on a successful publish and non-zero on anything else, so a
failed deploy fails the job.

## Limits

256 MB per upload, 25 MB per file, 20,000 files, 1 GB extracted. Dotfiles,
`node_modules`, `.git` and friends are skipped unless you pass
`--include-hidden`.

Static files only — Lemonade Host serves what you give it and never runs a
build. Build locally or in CI, then point this at the output folder.
