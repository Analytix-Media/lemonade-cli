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

Mint a deploy token in your dashboard — **Deploy tools → Deploy token** —
and save it:

```bash
npx lemonade-host login
```

It asks for the token — nothing else. A token is minted for one site, so it
already knows where to publish. The answer is written to `~/.lemonade` with
permissions only you can read. Or set `LEMONADE_TOKEN` in the environment
instead, which is what CI wants.

## Commands

| | |
|---|---|
| `lemonade deploy [dir]` | Zip a folder and publish it. Defaults to `.`, and prefers `dist/`, `build/`, `out/` or `public/` if one exists. `--dir` does the same thing |
| `lemonade status` | The last few deploys for this site |
| `lemonade login` | Save a token to `~/.lemonade` |
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

Revoke one any time from the same screen you minted it on.

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
