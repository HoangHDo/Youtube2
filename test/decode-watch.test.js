import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The decode watchdog decides whether a stream that is *arriving* fine is
 * nonetheless being dropped by the client's decoder, and steps the quality down
 * when it is.
 *
 * It cannot be exercised through a headless browser - JSMpeg decodes one frame
 * per requestAnimationFrame, and a headless page fires rAF zero times per
 * second, so the picture never advances no matter what the resolution is. So the
 * decision is extracted here and tested directly against the cases that
 * actually occur in the field.
 */

/** Mirrors the window bookkeeping in player.js. */
class DecodeWatch {
  constructor({ minRatio = 0.95 } = {}) {
    this.minRatio = minRatio;
    this.window = { wall: 0, media: 0, serverAdvancing: false };
    this.warned = false;
    this.events = [];
  }

  /** @param {number} dWall ms of wall clock @param {number} dMedia ms of decoded media */
  sample({ dWall, dMedia, serverAdvancing, active = true, windowMs = 8000 }) {
    // Only an explicit `false` means inactive, so a caller that omits the flag
    // is treated as "playing" rather than silently resetting every window.
    if (active === false) {
      // A hidden or unfocused tab decodes nothing. Not a decode failure.
      this.window = { wall: 0, media: 0, serverAdvancing: false };
      return;
    }
    this.window.wall += dWall;
    this.window.media += dMedia;
    if (serverAdvancing) this.window.serverAdvancing = true;
    if (this.window.wall < windowMs) return;

    const ratio = this.window.media / this.window.wall;
    const behind = this.window.serverAdvancing && ratio < this.minRatio;
    this.window = { wall: 0, media: 0, serverAdvancing: false };

    if (behind && !this.warned) {
      this.warned = true;
      this.events.push({ type: 'decodebound', ratio });
    } else if (!behind && this.warned) {
      // Re-arm on "not behind" alone. A separate `ratio > min + epsilon` test is
      // unusable: min + epsilon sits above real time, so it can never be met and
      // the watchdog would never re-arm after a quality step-down.
      this.warned = false;
      this.events.push({ type: 'recovered', ratio });
    }
  }
}

const run = (opts, ticks) => {
  const w = new DecodeWatch(opts);
  for (const t of ticks) w.sample(t);
  return w;
};

/** N ticks of 1000ms each, decoding `ratio` seconds of media per second. */
const steady = (ratio, extra = {}) =>
  Array.from({ length: 8 }, () => ({ dWall: 1000, dMedia: 1000 * ratio, serverAdvancing: true, ...extra }));

describe('decode watchdog', () => {
  test('stays quiet when the decoder keeps up', () => {
    const w = run({}, steady(1.0));
    assert.deepEqual(w.events, [], 'a healthy decoder must not be warned about');
  });

  test('warns when a fed decoder falls behind real time', () => {
    // The real failure: data arrives (server clock advancing) but the client
    // only manages a fraction of real time.
    const w = run({}, steady(0.35));
    assert.equal(w.events.length, 1);
    assert.equal(w.events[0].type, 'decodebound');
    assert.ok(w.events[0].ratio < 1, 'reported ratio should be below real time');
  });

  test('does not warn when the stream itself is not arriving', () => {
    // A dead producer looks identical from the browser. Claiming "your device
    // cannot decode this" would send the user to the wrong control entirely.
    const w = run({}, steady(0.2, { serverAdvancing: false }));
    assert.deepEqual(w.events, [], 'a producer problem is not a decode problem');
  });

  test('does not warn for a hidden or unfocused tab', () => {
    // rAF does not fire, so nothing decodes. That is not a decode failure.
    const w = run({}, steady(0, { active: false }));
    assert.deepEqual(w.events, []);
  });

  test('tolerates ordinary jitter just under real time', () => {
    const w = run({}, steady(0.97));
    assert.deepEqual(w.events, [], 'a few percent of jitter is not a stall');
  });

  test('warns only once, so the user is not nagged', () => {
    const w = new DecodeWatch();
    // 24 seconds of a fed-but-starving decoder: three full windows.
    for (let i = 0; i < 24; i += 1) w.sample({ dWall: 1000, dMedia: 350, serverAdvancing: true });
    assert.equal(w.events.filter((e) => e.type === 'decodebound').length, 1);
  });

  test('re-arms after the picture recovers', () => {
    const w = new DecodeWatch();
    for (let i = 0; i < 8; i += 1) w.sample({ dWall: 1000, dMedia: 350, serverAdvancing: true });
    assert.equal(w.events.length, 1);
    // Now healthy again, e.g. after the quality was stepped down.
    for (let i = 0; i < 8; i += 1) w.sample({ dWall: 1000, dMedia: 1000, serverAdvancing: true });
    assert.equal(w.events.at(-1).type, 'recovered');
    // And a later regression is reported again.
    for (let i = 0; i < 8; i += 1) w.sample({ dWall: 1000, dMedia: 350, serverAdvancing: true });
    assert.equal(w.events.filter((e) => e.type === 'decodebound').length, 2);
  });

  test('needs a full window before judging, so a slow start cannot trip it', () => {
    const w = new DecodeWatch();
    // Only three seconds of evidence: not enough to conclude anything.
    for (let i = 0; i < 3; i += 1) w.sample({ dWall: 1000, dMedia: 100, serverAdvancing: true });
    assert.deepEqual(w.events, [], 'must not judge on a partial window');
  });
});

describe('quality step-down', () => {
  const step = (current) => {
    const order = ['high', 'standard', 'low'];
    const i = order.indexOf(current);
    return i < 0 ? 'low' : order[Math.min(i + 1, order.length - 1)];
  };

  test('only ever steps downward', () => {
    assert.equal(step('high'), 'standard');
    assert.equal(step('standard'), 'low');
  });

  test('stops at the cheapest preset instead of looping', () => {
    assert.equal(step('low'), 'low');
  });

  test('falls back to the cheapest for an unknown or unset value', () => {
    assert.equal(step(''), 'low');
    assert.equal(step('medium'), 'low', 'a stale pre-rename value must not stick');
  });
});
