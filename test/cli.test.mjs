/**
 * The CLI against a fake server, run as a real subprocess (no terminal,
 * like CI or an assistant). Covers what 0.2.0 fixed: honest deploy
 * messages, Retry-After, JSON errors, no stack traces, an env token not
 * borrowing the saved site, rollback, status detail, the secret guard.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { collect } from "../src/zip.mjs";

const BIN = path.join(import.meta.dirname, "..", "bin", "lemonade.mjs");
const SCRATCH = path.join(import.meta.dirname, ".tmp-cli");
const TOKEN = "lm_" + "a".repeat(40);

let server;
let origin;
let seen;
/** What the next requests should answer, by "METHOD path". */
let routes;

before(async () => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  server = http.createServer((req, res) => {
    let body = [];
    req.on("data", (c) => body.push(c));
    req.on("end", () => {
      const key = `${req.method} ${req.url}`;
      seen.push({ key, auth: req.headers.authorization, body: Buffer.concat(body).toString("latin1") });
      const r = routes[key];
      if (!r) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "not_found" }));
      }
      res.writeHead(r.status ?? 200, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

function reset() {
  seen = [];
  routes = {
    "GET /api/deploy/whoami": { body: { ok: true, site: "st_new", name: "Lakeview Pottery", url: "https://lakeview.example", serving: true, state: "live", access: "publish" } },
  };
}

function site(files = { "index.html": "<h1>hi</h1>" }) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "site-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

function run(args, { env = {}, home } = {}) {
  const h = home ?? fs.mkdtempSync(path.join(SCRATCH, "home-"));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, HOME: h, USERPROFILE: h, LEMONADE_ORIGIN: origin, LEMONADE_TOKEN: TOKEN, CI: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

test("deploy says Live only when serving; otherwise the honest line, and prints warnings", async () => {
  reset();
  const dir = site();
  routes["POST /api/deploy/st_new"] = { body: { ok: true, deploymentId: "dp_1", fileCount: 1, url: "https://lakeview.example", serving: true } };
  let r = await run(["deploy", dir, "--yes"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Live\./);

  routes["POST /api/deploy/st_new"] = { body: { ok: true, deploymentId: "dp_2", fileCount: 1, url: "https://lakeview.example", serving: false } };
  r = await run(["deploy", dir, "--yes"]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /Live\./);
  assert.match(r.out, /isn't live yet/);

  routes["POST /api/deploy/st_new"] = { body: { ok: true, deploymentId: "dp_3", fileCount: 1, serving: false, waiting: true, message: "Checking your files, live in a moment.", warnings: ["Possible secret in app.js (AKIA****)"] } };
  r = await run(["deploy", dir, "--yes"]);
  assert.doesNotMatch(r.out, /Live\./);
  assert.match(r.out, /Checking your files/);
  assert.match(r.out, /Possible secret in app\.js/);

  routes["POST /api/deploy/st_new"] = { body: { ok: true, deploymentId: "dp_4", fileCount: 1, blocked: true, message: "Held for review." } };
  r = await run(["deploy", dir, "--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /offline/);
});

test("Retry-After becomes words, and --json errors are JSON with no stack trace", async () => {
  reset();
  const dir = site();
  routes["POST /api/deploy/st_new"] = { status: 429, headers: { "retry-after": "2732" }, body: { ok: false, error: "rate_limited" } };
  let r = await run(["deploy", dir, "--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /46 minutes/);
  assert.doesNotMatch(r.err, /Wait a minute/);
  assert.doesNotMatch(r.err, /at .*\.mjs:\d+/);

  r = await run(["deploy", dir, "--yes", "--json"]);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, false);
  assert.equal(j.error, "rate_limited");
  assert.equal(j.retryAfter, 2732);
  assert.equal(r.err, "");
});

test("an ended token says why, from the server's reason", async () => {
  reset();
  routes["GET /api/deploy/whoami"] = { status: 401, body: { ok: false, error: "unauthorized", reason: "ended", message: "This token isn't accepted any more. It ended on Oct 30, 2026. Make a new one in the portal under Developers > Tokens." } };
  const r = await run(["whoami"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /ended on Oct 30, 2026/);
});

test("a token from the environment ignores the site saved by login", async () => {
  reset();
  const home = fs.mkdtempSync(path.join(SCRATCH, "home-"));
  fs.writeFileSync(path.join(home, ".lemonade"), JSON.stringify({ token: "lm_" + "b".repeat(40), site: "st_old", origin }), { mode: 0o600 });
  routes["POST /api/deploy/st_new"] = { body: { ok: true, deploymentId: "dp_1", fileCount: 1, serving: true, url: "u" } };
  const r = await run(["deploy", site(), "--yes"], { home });
  assert.equal(r.code, 0);
  assert.ok(seen.some((s) => s.key === "POST /api/deploy/st_new"));
  assert.ok(!seen.some((s) => s.key.includes("st_old")));
  assert.ok(seen.every((s) => s.auth === `Bearer ${TOKEN}`));
});

test("a broken config prints a sentence, not a stack trace", async () => {
  reset();
  const home = fs.mkdtempSync(path.join(SCRATCH, "home-"));
  fs.writeFileSync(path.join(home, ".lemonade"), "{not json", { mode: 0o600 });
  const r = await run(["whoami"], { home, env: { LEMONADE_TOKEN: "" } });
  assert.equal(r.code, 1);
  assert.match(r.err, /not valid JSON/);
  assert.doesNotMatch(r.err, /at .*\.mjs:\d+/);
});

test("login without a terminal stops at once unless --token is given", async () => {
  reset();
  const r = await run(["login"], { env: { LEMONADE_TOKEN: "" } });
  assert.equal(r.code, 1);
  assert.match(r.err, /needs a terminal/);
  assert.equal(seen.length, 0);
  const ok = await run(["login", "--token", TOKEN], { env: { LEMONADE_TOKEN: "" } });
  assert.equal(ok.code, 0);
  assert.match(ok.out, /Saved\./);
});

test("rollback goes to the newest version that was live before, and explains a missing permission", async () => {
  reset();
  routes["GET /api/deploy/st_new/deployments"] = {
    body: {
      ok: true,
      deployments: [
        { id: "dp_3", status: "active", source: "cli", fileCount: 3, createdAt: "2026-11-22T10:00:00Z" },
        { id: "dp_2b", status: "failed", source: "cli", errorDetail: "Too many files", createdAt: "2026-11-22T09:00:00Z" },
        { id: "dp_2", status: "superseded", source: "cli", fileCount: 2, createdAt: "2026-11-21T10:00:00Z" },
      ],
    },
  };
  routes["POST /api/deploy/st_new/restore"] = { body: { ok: true, deploymentId: "dp_2", url: "https://lakeview.example", blocked: false } };
  let r = await run(["rollback", "--yes"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Rolled back/);
  assert.equal(JSON.parse(seen.find((s) => s.key === "POST /api/deploy/st_new/restore").body).deploymentId, "dp_2");

  // No terminal and no --yes: it will not go back without being told.
  r = await run(["rollback"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--yes/);

  routes["POST /api/deploy/st_new/restore"] = { status: 403, body: { ok: false, error: "missing_permission", needs: "rollback", message: "x" } };
  r = await run(["rollback", "--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /isn't allowed/);
});

test("status shows deploy ids and why a deploy failed, and the live address", async () => {
  reset();
  routes["GET /api/deploy/st_new/deployments"] = {
    body: { ok: true, deployments: [{ id: "dp_9", status: "failed", source: "cli", errorCode: "file_too_large", createdAt: "2026-11-22T10:00:00Z" }, { id: "dp_8", status: "active", source: "mcp", fileCount: 2, createdAt: "2026-11-21T10:00:00Z" }] },
  };
  const r = await run(["status"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /dp_9/);
  assert.match(r.out, /One file is over 25 MB/);
  assert.match(r.out, /https:\/\/lakeview\.example/);
  assert.match(r.out, /dp_8.*\(live\)/);
});

test("the secret guard stays on with --include-hidden", () => {
  const dir = site({ "index.html": "x", ".env": "A=1", ".env.production": "B=2", "server.pem": "k", "deploy.key": "k", "credentials.json": "{}", ".hidden.txt": "ok" });
  const plain = collect(dir).files.map((f) => f.rel);
  assert.deepEqual(plain, ["index.html"]);
  const all = collect(dir, { includeHidden: true });
  assert.deepEqual(all.files.map((f) => f.rel).sort(), [".hidden.txt", "index.html"]);
  assert.equal(all.skipped.secret, 5);
});

test("per-command help and no command", async () => {
  reset();
  let r = await run(["rollback", "--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /npx lemonade-host rollback \[id\]/);
  r = await run(["help", "deploy"]);
  assert.match(r.out, /Zip a folder/);
  r = await run(["frobnicate", "--json"]);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).error, "unknown_command");
});

/* ── 0.2.1 ─────────────────────────────────────────────────────────────── */

import { explain, MESSAGES, retryClock } from "../src/messages.mjs";

test("rate limit message gives the clock time, the date when not today, and the limit when sent", () => {
  const now = new Date(2026, 10, 24, 13, 0, 0); // local 24 Nov 2026 13:00
  assert.equal(retryClock(2732, now), "13:46");
  assert.equal(retryClock(3 * 3600, now), "16:00");
  assert.equal(retryClock(12 * 3600, now), "01:00 on Nov 25");
  assert.equal(retryClock(null, now), null);

  assert.equal(
    explain("rate_limited", null, { retryAfter: 2732, now }),
    "Too many deploys in a row for this site or account. You have reached the limit for this kind of request. Try again in 46 minutes, at 13:46.",
  );
  assert.equal(
    explain("rate_limited", null, { retryAfter: 2732, limit: 20, now }),
    "Too many deploys in a row for this site or account. The limit is 20 requests of this kind. Try again in 46 minutes, at 13:46.",
  );
  assert.equal(explain("rate_limited", null, { now }), "Too many deploys in a row for this site or account. You have reached the limit for this kind of request. Try again in a minute.");
  for (const code of ["rate_limited", "slow_down"]) assert.doesNotMatch(explain(code, null, { retryAfter: 90, now }), /[-\u2013\u2014]/);
});

test("a 429 over HTTP shows the time, and the limit from RateLimit-Limit", async () => {
  reset();
  const dir = site();
  routes["POST /api/deploy/st_new"] = { status: 429, headers: { "retry-after": "2732", "ratelimit-limit": "20" }, body: { ok: false, error: "rate_limited" } };
  let r = await run(["deploy", dir, "--yes"]);
  assert.match(r.err, /The limit is 20 requests of this kind\. Try again in 46 minutes, at \d\d:\d\d/);
  routes["POST /api/deploy/st_new"] = { status: 429, headers: { "retry-after": "2732" }, body: { ok: false, error: "rate_limited" } };
  r = await run(["deploy", dir, "--yes"]);
  assert.match(r.err, /You have reached the limit for this kind of request\. Try again in 46 minutes, at \d\d:\d\d/);
});

test("the too_large message says 100 MB, and no source says 256 MB", () => {
  assert.match(MESSAGES.too_large, /100 MB/);
  assert.doesNotMatch(MESSAGES.too_large, /256/);
  for (const f of ["../README.md", "../bin/lemonade.mjs"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(import.meta.dirname, f), "utf8"), /256 MB/);
  }
});

test("deploy --yes refuses a project root (exit 2); --allow-project-root opts in; a named folder is unchanged", async () => {
  reset();
  routes["POST /api/deploy/st_new"] = { body: { ok: true, deploymentId: "dp_1", fileCount: 3, url: "u", serving: true } };
  const root = site({ "package.json": "{}", "src/app.js": "x", "README.md": "r" });
  const cwdRun = (args) => new Promise((resolve) => {
    const h = fs.mkdtempSync(path.join(SCRATCH, "home-"));
    const p = spawn(process.execPath, [BIN, ...args], { cwd: root, env: { ...process.env, HOME: h, USERPROFILE: h, LEMONADE_ORIGIN: origin, LEMONADE_TOKEN: TOKEN, CI: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code, out, err }));
  });

  let r = await cwdRun(["deploy", "--yes"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /dist, build, out, public, _site/);
  assert.match(r.err, /npx lemonade-host deploy dist/);
  assert.match(r.err, /--allow-project-root/);
  assert.ok(!seen.some((s) => s.key.startsWith("POST")));

  r = await cwdRun(["deploy", "--yes", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).error, "project_root");

  r = await cwdRun(["deploy", "--yes", "--allow-project-root"]);
  assert.equal(r.code, 0);
  assert.ok(seen.some((s) => s.key === "POST /api/deploy/st_new"));

  seen.length = 0;
  r = await cwdRun(["deploy", ".", "--yes"]);
  assert.equal(r.code, 0);

  // a plain static site (index.html, no project markers) still deploys with --yes
  seen.length = 0;
  const plain = site({ "index.html": "<h1>x</h1>" });
  r = await run(["deploy", "--yes", "--dir", plain]);
  assert.equal(r.code, 0);

  r = await run(["help", "deploy"]);
  assert.match(r.out, /--allow-project-root/);
});

/* ── 0.2.3 ─────────────────────────────────────────────────────────────── */

import { spawnSync } from "node:child_process";

const COMMANDS_WITH_HELP = ["deploy", "status", "rollback", "login", "whoami"];

test("per-command help: <cmd> --help, <cmd> -h and help <cmd> print that command's help, exit 0, no network", async () => {
  reset();
  const helps = {};
  for (const cmd of COMMANDS_WITH_HELP) {
    for (const args of [[cmd, "--help"], [cmd, "-h"], ["help", cmd], [`${cmd} --help`]]) {
      // No token, an origin nothing listens on: a network call (or a token check) would fail it.
      const r = await run(args, { env: { LEMONADE_ORIGIN: "http://127.0.0.1:9", LEMONADE_TOKEN: "" } });
      assert.equal(r.code, 0, `${args.join(" ")} exits 0`);
      assert.match(r.out, new RegExp(`^npx lemonade-host ${cmd}\\b`), `${args.join(" ")} prints the ${cmd} help`);
      assert.equal(r.err, "");
      helps[cmd] ??= r.out;
      assert.equal(r.out, helps[cmd], "the three spellings print the same text");
    }
  }
  assert.equal(new Set(Object.values(helps)).size, COMMANDS_WITH_HELP.length, "five different texts");
  assert.equal(seen.length, 0, "the fake server was never called");
  // the list of commands in the general help is the list that has help
  const general = await run(["--help"]);
  for (const cmd of COMMANDS_WITH_HELP) assert.match(general.out, new RegExp(`npx lemonade-host ${cmd}\\b`));
  const bad = await run(["help", "frobnicate"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Unknown command: frobnicate/);
});

test("rate limit wording names who is limited: site, account, and neither known", () => {
  const now = new Date(2026, 10, 24, 13, 0, 0);
  const at = { retryAfter: 2732, now };
  assert.equal(explain("rate_limited", null, { ...at, scope: "site" }), "Too many deploys in a row for this site. You have reached the limit for this kind of request. Try again in 46 minutes, at 13:46.");
  assert.equal(explain("rate_limited", null, { ...at, scope: "account" }), "Too many deploys in a row for this account. You have reached the limit for this kind of request. Try again in 46 minutes, at 13:46.");
  assert.equal(explain("rate_limited", null, { ...at, scope: "account_day" }), "Too many deploys in a row for this account today. You have reached the limit for this kind of request. Try again in 46 minutes, at 13:46.");
  assert.equal(explain("rate_limited", null, { ...at, scope: "unpaid_drafts" }), "Too many deploys in a row for unpaid drafts on this account. You have reached the limit for this kind of request. Try again in 46 minutes, at 13:46.");
  assert.match(explain("rate_limited", null, at), /for this site or account\./);
});

test("a 429 over HTTP says site or account from X-RateLimit-Scope or the JSON scope, with the clock time either way", async () => {
  reset();
  const dir = site();
  const say = async (headers, body) => {
    routes["POST /api/deploy/st_new"] = { status: 429, headers: { "retry-after": "1929", ...headers }, body: { ok: false, error: "rate_limited", ...body } };
    return run(["deploy", dir, "--yes"]);
  };
  let r = await say({ "x-ratelimit-scope": "site" });
  assert.match(r.err, /Too many deploys in a row for this site\. .*Try again in 33 minutes, at \d\d:\d\d\./);
  r = await say({ "x-ratelimit-scope": "account" });
  assert.match(r.err, /Too many deploys in a row for this account\. .*Try again in 33 minutes, at \d\d:\d\d\./);
  assert.doesNotMatch(r.err, /this site/);
  r = await say({}, { scope: "account" });
  assert.match(r.err, /for this account\./);
  r = await say({});
  assert.match(r.err, /for this site or account\. .*at \d\d:\d\d\./);
});

/* Ctrl+D / closed stdin at a prompt. */

test("confirm(): a closed stdin or EOF cancels with exit 130, no trace, no hang", () => {
  const script = `import { confirm } from ${JSON.stringify(new URL("../src/commands.mjs", import.meta.url).href)};
import { Refused } from ${JSON.stringify(new URL("../src/errors.mjs", import.meta.url).href)};
try { await confirm("Publish?"); console.log("ANSWERED"); }
catch (e) { console.log(e instanceof Refused ? "CANCELED " + e.message + " " + e.exitCode + " " + e.code : "OTHER " + e.message); }
process.exit(0);`;
  for (const input of ["", "\u0004"]) {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { input, encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, `stdin ${JSON.stringify(input)} finished (not killed by the timeout)`);
    assert.match(r.stdout, /CANCELED Canceled\. 130 canceled/);
  }
  // a real answer still works on a pipe
  const yes = spawnSync(process.execPath, ["--input-type=module", "-e", script.replace('console.log("ANSWERED")', 'console.log("ANSWERED")')], { input: "y\n", encoding: "utf8", timeout: 10000 });
  assert.match(yes.stdout, /ANSWERED/);
});

const HAVE_PTY = spawnSync("python3", ["-c", "import pty"]).status === 0;

test("Ctrl+D at the publish prompt, in a real terminal: Canceled., exit 130, nothing published", { skip: !HAVE_PTY && "no python3 pty" }, async () => {
  reset();
  const dir = site();
  routes["POST /api/deploy/st_new"] = { body: { ok: true, deploymentId: "dp_1", fileCount: 1, serving: true } };
  const driver = `
import os, pty, sys, time, select
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
out = b""
sent = False
deadline = time.time() + 20
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            d = os.read(fd, 4096)
        except OSError:
            break
        if not d:
            break
        out += d
        if not sent and b"[Y/n]" in out:
            os.write(fd, b"\\x04")
            sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf8", "replace"))
sys.stdout.write("\\nEXIT %d" % os.waitstatus_to_exitcode(status))
`;
  const home = fs.mkdtempSync(path.join(SCRATCH, "home-"));
  // Async, not spawnSync: the fake server lives in this process and must keep answering.
  const r = await new Promise((resolve) => {
    const p = spawn("python3", ["-I", "-c", driver, process.execPath, BIN, "deploy", dir], {
      env: { ...process.env, HOME: home, USERPROFILE: home, LEMONADE_ORIGIN: origin, LEMONADE_TOKEN: TOKEN, CI: "" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", () => resolve({ stdout }));
  });
  assert.match(r.stdout, /Publish to .*\[Y\/n\]/);
  assert.match(r.stdout, /Canceled\./);
  assert.match(r.stdout, /EXIT 130/);
  assert.doesNotMatch(r.stdout, /unexpected|Aborted|support@|\.mjs:\d+/);
  assert.ok(!seen.some((s) => s.key === "POST /api/deploy/st_new"), "nothing was uploaded");
});
