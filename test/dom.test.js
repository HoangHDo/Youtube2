import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPasted, normaliseInput } from '../public/js/dom.js';

/**
 * The paste button hands whatever is on the clipboard to the URL field, so
 * these cases are the ones a user actually hits: a link copied from an address
 * bar, from a chat app, out of an email, or from a terminal.
 */
describe('cleanPasted', () => {
  test('returns an empty string for an empty or whitespace clipboard', () => {
    assert.equal(cleanPasted(''), '');
    assert.equal(cleanPasted('   \n\t  '), '');
    assert.equal(cleanPasted(null), '');
    assert.equal(cleanPasted(undefined), '');
  });

  test('passes a clean watch URL through untouched', () => {
    const url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
    assert.equal(cleanPasted(url), url);
  });

  test('drops a trailing newline from a terminal copy', () => {
    assert.equal(
      cleanPasted('https://www.youtube.com/watch?v=aqz-KE-bpKQ\n'),
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    );
  });

  test('removes angle brackets an email client wraps a link in', () => {
    assert.equal(
      cleanPasted('<https://www.youtube.com/watch?v=aqz-KE-bpKQ>'),
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    );
  });

  test('removes straight and curly quotes', () => {
    assert.equal(
      cleanPasted('"https://www.youtube.com/watch?v=aqz-KE-bpKQ"'),
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    );
    assert.equal(
      cleanPasted('\u201Chttps://www.youtube.com/watch?v=aqz-KE-bpKQ\u201D'),
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    );
  });

  test('strips zero-width characters left by chat apps', () => {
    assert.equal(
      cleanPasted('https://www.youtube.com/watch?v=aqz-KE-bpKQ\u200B\u200D\uFEFF'),
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    );
  });

  test('finds the link inside a line of prose', () => {
    assert.equal(
      cleanPasted('Check this out https://www.youtube.com/watch?v=aqz-KE-bpKQ nice video'),
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    );
  });

  test('drops sentence punctuation that is not part of the URL', () => {
    assert.equal(
      cleanPasted('Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ.'),
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    );
  });

  test('undoes HTML-escaped query separators', () => {
    assert.equal(
      cleanPasted('https://www.youtube.com/watch?v=aqz-KE-bpKQ&amp;t=30s'),
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=30s',
    );
  });

  test('rewrites short youtu.be links', () => {
    assert.equal(
      cleanPasted('https://youtu.be/aqz-KE-bpKQ'),
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    );
  });

  test('rewrites /embed/ and /shorts/ links', () => {
    assert.equal(
      cleanPasted('https://www.youtube.com/embed/aqz-KE-bpKQ'),
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    );
    assert.equal(
      cleanPasted('https://www.youtube.com/shorts/aqz-KE-bpKQ'),
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    );
  });

  test('expands a bare video id', () => {
    assert.equal(cleanPasted('aqz-KE-bpKQ'), 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  });

  test('keeps playlist and timestamp parameters', () => {
    const out = cleanPasted('https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=PL123&t=42');
    assert.equal(out, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=PL123&t=42');
  });

  test('leaves a non-YouTube URL alone for the server to reject', () => {
    // The paste button must not silently rewrite a host it does not know about.
    assert.equal(cleanPasted('https://example.com/video.mp4'), 'https://example.com/video.mp4');
  });

  test('every cleaned result is accepted by normaliseInput', () => {
    const cases = [
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ\n',
      '<https://youtu.be/aqz-KE-bpKQ>',
      '\u201Chttps://www.youtube.com/shorts/aqz-KE-bpKQ\u201D',
      'aqz-KE-bpKQ',
      'Look: https://www.youtube.com/watch?v=aqz-KE-bpKQ.',
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ&amp;t=1',
    ];
    for (const input of cases) {
      const cleaned = cleanPasted(input);
      assert.ok(cleaned.length > 0, `empty result for ${JSON.stringify(input)}`);
      assert.ok(
        normaliseInput(cleaned),
        `normaliseInput rejected ${JSON.stringify(cleaned)} from ${JSON.stringify(input)}`,
      );
    }
  });
});
