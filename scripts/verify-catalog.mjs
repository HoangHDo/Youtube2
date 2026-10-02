/**
 * Sanity-checks the curated catalog: every entry must resolve to a real,
 * streamable video. Run it after editing src/lib/catalog.js.
 *
 *   node --env-file-if-exists=.env scripts/verify-catalog.mjs
 */
import { catalog } from '../src/lib/catalog.js';
import { resolveSource } from '../src/lib/resolver.js';
import { config } from '../src/config/index.js';

let failures = 0;
for (const item of catalog) {
  const url = `https://www.youtube.com/watch?v=${item.id}`;
  process.stdout.write(`\n${item.id}  ${item.title}\n`);
  try {
    const source = await resolveSource(url);
    process.stdout.write(
      `  ok  ${source.formatIds?.join('+') ?? '?'}  ` +
        `${source.duration ?? 'live'}s  host=${source.host ?? '?'}  ` +
        `split=${source.splitSource}\n`,    );
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL ${err.message}\n`);
  }
  // A missing thumbnail is a broken card in the feed, so check it too.
  try {
    const res = await fetch(`https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`, {
      method: 'HEAD',
    });
    if (!res.ok) {
      failures += 1;
      process.stdout.write(`  FAIL thumbnail HTTP ${res.status}\n`);
    }
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL thumbnail ${err.message}\n`);
  }
}

process.stdout.write(
  `\n${catalog.length - failures} checks passed ` +
    `(yt-dlp=${config.youtube.ytDlpPath})\n`,
);
process.exitCode = failures ? 1 : 0;
