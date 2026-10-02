/**
 * Packet-alignment logic for the WebSocket relay.
 *
 * The relay sheds chunks when a viewer falls behind. If the shed count were not
 * a whole number of 188-byte packets, every subsequent packet in that viewer's
 * stream would be misaligned and the decoder would be broken for the rest of
 * the session - so this is the invariant that protects every viewer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alignChunk } from '../src/realtime/video.socket.js';

const PACKET = 188;
const packet = (n = 1) => {
  const buf = Buffer.alloc(PACKET * n, 0x00);
  for (let i = 0; i < n; i += 1) buf[i * PACKET] = 0x47;
  return buf;
};
const newState = () => ({ carry: Buffer.alloc(0) });

describe('alignChunk', () => {
  it('passes whole packets through untouched', () => {
    const state = newState();
    const out = alignChunk(state, packet(3), false);
    assert.equal(out.length, PACKET * 3);
    assert.equal(state.carry.length, 0);
  });

  it('withholds a partial packet until it is complete', () => {
    const state = newState();
    const first = Buffer.alloc(100, 0x11);
    const second = packet(2);
    const stream = Buffer.concat([first, second]);

    assert.equal(alignChunk(state, first, false), null, 'nothing is sent yet');
    assert.equal(state.carry.length, 100, 'the partial packet is remembered');

    const out = alignChunk(state, second, false);
    assert.ok(out);
    assert.equal(out.length % PACKET, 0, 'emitted bytes are whole packets');
    assert.ok(state.carry.length < PACKET, 'carry is always under one packet');
    // The emitted bytes are a prefix of the real stream, so every 188-byte block
    // the client sees is exactly one real packet.
    assert.deepEqual(out, stream.subarray(0, out.length));
    assert.equal(state.carry.length, stream.length - out.length);
  });

  it('emits nothing but a completed packet when shedding mid-packet', () => {
    const state = newState();
    alignChunk(state, Buffer.alloc(100), false);
    const out = alignChunk(state, packet(2), true);
    assert.equal(out, null, 'the completed packet is shed too');
    assert.equal(state.carry.length, 0);
  });

  it('drops a whole number of packets when shedding', () => {
    const state = newState();
    const out = alignChunk(state, packet(5), true);
    assert.equal(out, null, 'everything whole was shed');
    assert.equal(state.carry.length, 0);
  });

  it('never leaves a partial packet behind after a shed', () => {
    const state = newState();
    const chunk = Buffer.concat([packet(2), Buffer.alloc(37, 0x22)]);
    const out = alignChunk(state, chunk, true);
    assert.equal(out, null, 'the two whole packets were shed');
    assert.equal(state.carry.length, 37, 'only the partial tail is retained');
  });

  it('holds a shed partial tail for the next chunk', () => {
    const state = newState();
    alignChunk(state, Buffer.concat([packet(1), Buffer.alloc(50)]), true);
    assert.equal(state.carry.length, 50);
    const out = alignChunk(state, packet(1), false);
    assert.equal(out.length, PACKET, 'partial tail + next packet = one packet');
  });

  it('never emits a non-multiple of 188, under any chunking or shedding', () => {
    // Deterministic pseudo-random sizes and shed decisions.
    let seed = 12345;
    const rand = (n) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };

    for (const shedEvery of [1, 2, 3, 5, 17, 0]) {
      const state = newState();
      let totalSent = 0;
      for (let i = 0; i < 800; i += 1) {
        const size = 1 + rand(3000);
        const chunk = Buffer.alloc(size, 0x33);
        const shed = shedEvery > 0 && i % shedEvery === 0;
        const out = alignChunk(state, chunk, shed);
        if (out) {
          assert.equal(
            out.length % PACKET,
            0,
            `shedEvery=${shedEvery} iteration=${i} emitted ${out.length} bytes`,
          );
          totalSent += out.length;
        }
        assert.ok(state.carry.length < PACKET, 'carry stays under one packet');
      }
      if (shedEvery === 0) assert.ok(totalSent > 0);
    }
  });

  it('preserves the stream when nothing is ever shed', () => {
    const state = newState();
    const chunks = [Buffer.alloc(7), packet(2), Buffer.alloc(300), Buffer.alloc(1), packet(1)];
    const sent = [];
    for (const c of chunks) {
      const out = alignChunk(state, c, false);
      if (out) sent.push(out);
    }
    // Flush the carry at end of stream: everything but <188 bytes must be out.
    const total = sent.reduce((n, b) => n + b.length, 0);
    const expected = chunks.reduce((n, b) => n + b.length, 0);
    assert.equal(total % PACKET, 0);
    assert.ok(total <= expected);
    assert.ok(expected - total < PACKET, 'less than one packet is still buffered');
  });
});
