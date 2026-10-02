/**
 * Vendors the JSMpeg player into public/vendor so the frontend never has to
 * load third-party code from a CDN at runtime (strict CSP, works offline,
 * no supply-chain surface beyond our own origin).
 *
 * The npm package "jsmpeg@1.0.0" is CommonJS-only and unusable in a browser,
 * so we fetch the official browser build straight from the project repository
 * and pin it by commit + SHA-256.
 *
 *   node scripts/vendor.mjs          # fetch if missing/stale
 *   node scripts/vendor.mjs --force  # always re-fetch
 *
 * The file is committed to the repository, so this script is a no-op for
 * everyone who just clones the project. It never fails the install.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'public', 'vendor');

const PIN = {
  name: 'jsmpeg.min.js',
  // Upstream: https://github.com/phoboslab/jsmpeg (MIT for the player, derived
  // from a GPL Java decoder - see public/vendor/jsmpeg.LICENSE).
  ref: '924acfbd96fdf15e6748d1368a36d79d8f4cecf6',
  sha256: 'c0286ac82193fc9c9d5490ade425db04c446d9115bfe6823bf9bc0b0703c7760',
  url: (ref) =>
    `https://cdn.jsdelivr.net/gh/phoboslab/jsmpeg@${ref}/jsmpeg.min.js`,
  licenseUrl: (ref) =>
    `https://cdn.jsdelivr.net/gh/phoboslab/jsmpeg@${ref}/LICENSE`,
  licenseName: 'jsmpeg.LICENSE',
};

const force = process.argv.includes('--force');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function main() {
  await mkdir(vendorDir, { recursive: true });
  const target = join(vendorDir, PIN.name);

  if (!force) {
    try {
      const current = await readFile(target);
      if (sha256(current) === PIN.sha256) {
        process.stdout.write(`vendor: ${PIN.name} ok (${current.length} bytes)\n`);
        return;
      }
    } catch {
      /* not vendored yet */
    }
  }

  process.stdout.write(`vendor: fetching jsmpeg @ ${PIN.ref.slice(0, 10)}\n`);
  const res = await fetch(PIN.url(PIN.ref), {
    headers: { 'user-agent': 'cyberstream-vendor' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const body = Buffer.from(await res.arrayBuffer());
  const digest = sha256(body);
  if (digest !== PIN.sha256) {
    throw new Error(
      `checksum mismatch for ${PIN.name}\n  expected ${PIN.sha256}\n  got      ${digest}`,
    );
  }
  await writeFile(target, body);
  await writeFile(
    join(vendorDir, 'jsmpeg.meta.json'),
    `${JSON.stringify({ file: PIN.name, ref: PIN.ref, sha256: PIN.sha256 }, null, 2)}\n`,
  );

  try {
    const lic = await fetch(PIN.licenseUrl(PIN.ref));
    if (lic.ok) {
      await writeFile(join(vendorDir, PIN.licenseName), Buffer.from(await lic.arrayBuffer()));
    }
  } catch {
    /* license file is informational */
  }

  process.stdout.write(`vendor: wrote ${target} (${body.length} bytes)\n`);
}

main().catch((err) => {
  // Never break `npm install`; the UI degrades with a clear message instead.
  process.stderr.write(`vendor: skipped (${err.message})\n`);
  process.exitCode = 0;
});

// Keep a stable linter/shell happy about the unused import when tree-shaken.
void stat;
