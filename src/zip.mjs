/**
 * A zip file, built with nothing installed.
 *
 * WHY NOT A LIBRARY. This package's whole promise is `npx lemonade deploy`
 * — one command, nothing to install, on a machine that may be a laptop or a
 * CI runner with a cold cache. Every dependency is a download before the
 * first byte of the customer's site moves, a version to keep patched, and
 * one more thing that can be yanked or compromised between them and their
 * website going live. The zip format's stored (uncompressed) mode is about
 * a hundred lines, so this package has ZERO dependencies and always will.
 *
 * STORED, NOT DEFLATED, and that is a deliberate trade. Deflate would need
 * zlib streaming plumbed through the central directory; Node has zlib, so
 * it is possible, but the win is bandwidth on an upload that is already
 * capped at 256 MB and usually a few hundred KB of HTML. Correctness that
 * anyone can read beats a smaller upload nobody can audit.
 *
 * THE ONE THING THAT MUST NOT BE WRONG: paths. The server's gauntlet
 * rejects `..`, absolute paths, backslashes, NUL bytes and every symlink —
 * so a bug here surfaces as a rejected deploy rather than a traversal. It
 * is still written to emit only forward-slashed relative paths, because
 * "the other side would catch it" is not a reason to send something wrong.
 */

import fs from "node:fs";
import path from "node:path";
import { crc32 } from "./crc32.mjs";

/** Directories nobody means to publish. Skipped unless --include-hidden. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".vercel",
  ".netlify",
  ".DS_Store",
  "__pycache__",
]);

/**
 * The one dot-directory that IS the website.
 *
 * `.well-known/` is where the web agrees to put proof-of-ownership files:
 * a domain verification for Google or Microsoft, `apple-app-site-association`,
 * `security.txt`, an ACME challenge. Skipping it as "hidden" means the
 * customer uploads the folder, sees no error, and then fails a verification
 * they cannot debug — the worst shape a bug can take.
 */
const KEEP_DOT_DIRS = new Set([".well-known"]);

/** Files that are somebody's secret, not their website. */
const SKIP_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".npmrc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  ".DS_Store",
  "Thumbs.db",
]);

/**
 * Every file under `root`, as { rel, abs, size }.
 *
 * Symlinks are SKIPPED, not followed. Following one would either escape the
 * folder (which the server refuses anyway) or silently duplicate a file;
 * skipping is the only behaviour that is the same on both machines.
 */
export function collect(root, { includeHidden = false } = {}) {
  const out = [];
  const skipped = { hidden: 0, symlink: 0, secret: 0 };

  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`cannot read ${dir}: ${err.message}`);
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const name = entry.name;
      const abs = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;

      if (entry.isSymbolicLink()) {
        skipped.symlink++;
        continue;
      }
      if (!includeHidden && SKIP_FILES.has(name)) {
        skipped.secret++;
        continue;
      }
      if (entry.isDirectory()) {
        // KEEP_DOT_DIRS is checked first: `.well-known` starts with a dot,
        // so the hidden rule below would swallow it. The file branch had
        // this carve-out already, where it could never fire — a directory
        // never reaches it.
        if (!includeHidden && !KEEP_DOT_DIRS.has(name) && (SKIP_DIRS.has(name) || name.startsWith("."))) {
          skipped.hidden++;
          continue;
        }
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      // No carve-out here: files INSIDE `.well-known/` are ordinary names
      // (`security.txt`, `apple-app-site-association`), so they never hit
      // this rule. A file literally called `.well-known` is not a website.
      if (!includeHidden && name.startsWith(".")) {
        skipped.hidden++;
        continue;
      }
      const stat = fs.statSync(abs);
      out.push({ rel, abs, size: stat.size });
    }
  };

  walk(root, "");
  return { files: out, skipped };
}

/* ── the zip itself ──────────────────────────────────────────────────────── */

/**
 * General-purpose bit 11: "the filename in this entry is UTF-8".
 *
 * Without it a reader is entitled to decode names as CP437, and Info-ZIP
 * does — `café.html` came out of the system unzip as `caf+?.html` and then
 * failed to create at all with "Illegal byte sequence". Every name here is
 * written as UTF-8, so every entry says so.
 *
 * Found by round-tripping through a real unzip rather than through this
 * file's own reader, which is the entire reason that test shells out.
 */
const UTF8_NAMES = 0x0800;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;

/** DOS date/time. Zip predates Unix timestamps and still wants 1980-based. */
function dosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build the archive in memory.
 *
 * In memory on purpose: the upload cap is 256 MB and the practical size of
 * a static site is orders of magnitude under it, so a temp file would buy
 * nothing and would leave a copy of the customer's site on disk if the
 * process died mid-upload.
 */
export function zipFiles(files, { now = new Date() } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.rel, "utf8");
    const data = fs.readFileSync(file.abs);
    const crc = crc32(data);
    const { time, date } = dosTime(now);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_NAMES, 6); // no encryption, no data descriptor, UTF-8 names
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // no extra field

    chunks.push(local, nameBuf, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(CENTRAL_SIG, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(UTF8_NAMES, 8);
    entry.writeUInt16LE(0, 10); // method 0 = stored
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk
    entry.writeUInt16LE(0, 36); // internal attrs
    // 0644 in the high 16 bits, the way every unix zip writer does it. The
    // server does not read this, but a customer who downloads their own
    // archive should not find every file marked executable.
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}
