/**
 * The zip writer, checked against something that is not itself.
 *
 * A hand-rolled archive format is exactly the kind of code that passes its
 * own tests and fails everywhere else, so the central assertion here is
 * that the SYSTEM unzip — the same family of code the server's parser comes
 * from — reads what we wrote and gets the bytes back unchanged.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { collect, zipFiles } from "../src/zip.mjs";
import { crc32 } from "../src/crc32.mjs";

/**
 * Scratch space under the package rather than $TMPDIR.
 *
 * The round-trip test shells out to the system `unzip`, and a sandboxed
 * child process is not always allowed to create files in the temp root even
 * when this process can. Keeping the scratch inside the package makes the
 * test run the same on a laptop, in CI and in a sandbox. `test/.tmp` is
 * gitignored and removed at the end of the run.
 */
const SCRATCH = path.join(import.meta.dirname, ".tmp");

function tmpdir() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH, "case-"));
}

after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

test("crc32 matches the published vector", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("A REAL EXTRACTOR READS IT, AND THE BYTES COME BACK IDENTICAL", () => {
  const root = tmpdir();
  write(root, "index.html", "<h1>hello</h1>");
  write(root, "css/site.css", "body{color:red}");
  // Not ASCII, and not small: the two things a hand-rolled writer gets wrong.
  write(root, "about/café.html", "→ ünïcode ←");
  write(root, "big.bin", Buffer.alloc(200_000, 7));

  const { files } = collect(root);
  const zip = zipFiles(files);
  // Its own directory, not $TMPDIR itself — the sandbox this runs in
  // refuses a write straight into the temp root.
  const zipPath = path.join(tmpdir(), "site.zip");
  fs.writeFileSync(zipPath, zip);

  const out = tmpdir();
  // bsdtar (libarchive), NOT `unzip`. macOS still bundles Info-ZIP 6.00 from
  // 2009, which ignores general-purpose bit 11 and decodes every filename as
  // CP437 — it turned `café.html` into `caf+?.html` and then refused to
  // create it. That is a limitation of that binary, not of the archive:
  // libarchive, Node's yauzl (which the server uses), and every modern
  // reader honour the flag. bsdtar ships on macOS, Linux and Windows 10+.
  execFileSync("tar", ["-xf", zipPath, "-C", out]);

  for (const f of files) {
    const got = fs.readFileSync(path.join(out, f.rel));
    const want = fs.readFileSync(f.abs);
    assert.deepEqual(got, want, `${f.rel} did not survive the round trip`);
  }
  assert.equal(fs.readFileSync(path.join(out, "about/café.html"), "utf8"), "→ ünïcode ←");
});

test("an empty folder produces an archive that is still structurally valid", () => {
  // unzip EXITS 1 on an empty archive — that is its "zipfile is empty"
  // warning, not a corruption report — so the exit code is not the signal
  // here. What matters is the end-of-central-directory record: right magic,
  // zero entries. An archive with a broken EOCD is what a parser rejects.
  const zip = zipFiles([]);
  assert.equal(zip.length, 22, "an empty archive is exactly its EOCD record");
  assert.equal(zip.readUInt32LE(0), 0x06054b50, "wrong end-of-central-directory signature");
  assert.equal(zip.readUInt16LE(8), 0, "claims entries it does not have");
  assert.equal(zip.readUInt16LE(10), 0);
});

test("SYMLINKS ARE SKIPPED, NOT FOLLOWED", () => {
  // Following one either escapes the folder (which the server refuses) or
  // silently duplicates a file. Skipping is the only behaviour that is the
  // same on both machines.
  const root = tmpdir();
  write(root, "index.html", "hi");
  // The target sits OUTSIDE the folder being published — the case a link
  // would leak if it were followed.
  const outside = path.join(tmpdir(), "outside.txt");
  fs.writeFileSync(outside, "a secret from somewhere else");
  fs.symlinkSync(outside, path.join(root, "escape.txt"));

  const { files, skipped } = collect(root);
  assert.equal(skipped.symlink, 1);
  assert.deepEqual(files.map((f) => f.rel), ["index.html"]);
});

test("secrets and build junk are left behind by default", () => {
  const root = tmpdir();
  write(root, "index.html", "hi");
  write(root, ".env", "STRIPE_SECRET_KEY=sk_live_dontshipthis");
  write(root, "node_modules/left-pad/index.js", "module.exports = 1");
  write(root, ".git/config", "[core]");

  const { files, skipped } = collect(root);
  const rels = files.map((f) => f.rel);
  assert.deepEqual(rels, ["index.html"]);
  assert.ok(skipped.secret >= 1, ".env was not counted as a secret");
  assert.ok(!rels.some((r) => r.includes("node_modules")));

  // And --include-hidden really does include them, or the escape hatch is
  // a lie.
  const all = collect(root, { includeHidden: true }).files.map((f) => f.rel);
  assert.ok(all.includes("node_modules/left-pad/index.js"));
});

test("paths are forward-slashed and relative, whatever the platform", () => {
  const root = tmpdir();
  write(root, "a/b/c/deep.html", "x");
  const { files } = collect(root);
  assert.deepEqual(files.map((f) => f.rel), ["a/b/c/deep.html"]);
  for (const f of files) {
    assert.ok(!f.rel.startsWith("/"), "an absolute path would be refused by the server");
    assert.ok(!f.rel.includes("\\"), "a backslash would be refused by the server");
    assert.ok(!f.rel.includes(".."), "a traversal would be refused by the server");
  }
});

test("the order is stable, so the same folder makes the same archive", () => {
  const root = tmpdir();
  write(root, "b.html", "b");
  write(root, "a.html", "a");
  write(root, "c/d.html", "d");
  const once = collect(root).files.map((f) => f.rel);
  const twice = collect(root).files.map((f) => f.rel);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, ["a.html", "b.html", "c/d.html"]);
});
