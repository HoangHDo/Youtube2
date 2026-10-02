/**
 * A very small MPEG-TS demuxer used for one job: learn the presentation
 * timestamp of the most recent video frame as it leaves FFmpeg.
 *
 * Why bother? JSMpeg exposes no clock, so a client can only ever guess how far
 * behind the audio element it is. By sending a real video clock over the
 * control channel we can measure A/V drift and correct it (small playbackRate
 * nudges) instead of hoping they line up.
 *
 * It is deliberately defensive: anything unexpected is ignored, and the whole
 * feature turns itself off if the stream does not look like MPEG-TS.
 */

const PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;

const PID_MASK = 0x1fff;
const PID_PAT = 0x0000; // program association table - points at the PMT(s)
const PID_PMT = 0x1000; // placeholder until the PAT tells us the real one
const UNKNOWN_PID = 0x1fff; // sentinel: we do not know the video PID yet
const STREAM_TYPE_MPEG1_VIDEO = 0x02;

/** Nominal offset of the PTS field from the start of a PES packet. */
const PTS_BASE = 8;
/**
 * Plausible windows to try around the nominal offset. The first two PES headers
 * of a stream decide which one is real (see calibratePtsWindow).
 */
const CANDIDATE_OFFSETS = [0, 1, -1, 2, -2, 3, -3];
/** The MPEG-TS program clock is 90 kHz, so one millisecond is 90 ticks. */
const PTS_TICKS_PER_MS = 90;
/** 10 ms and 1 s at 90 kHz: wider than any sane frame delta, far below garbage. */
const MIN_DELTA = 900;
const MAX_DELTA = 90_000;
/** Deltas to observe before choosing a window. */
const LEARN_DELTAS = 8;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export class TsClock {
  /**
   * @param {(sample: {ptsMs:number, wallMs:number}) => void} onSample
   */
  constructor(onSample) {
    this.onSample = typeof onSample === 'function' ? onSample : () => {};
    this.reset();
  }

  reset() {
    /** @type {Buffer} */
    this.carry = Buffer.alloc(0);
    this.synced = false;
    /** @type {Set<number>} PMT PIDs learned from the PAT */
    this.pmtPids = new Set([PID_PMT]);
    this.havePmt = false;
    this.lastPts = null;
    this.lastEmitWall = 0;
    this.lastDiscontinuityWall = 0;
    /**
     * Every PID a PMT has ever advertised as MPEG-1 video.
     *
     * A single `videoPid` is fragile: PMT sections can straddle TS packet
     * boundaries, and one truncated section makes the byte walk land on
     * nonsense, so a "last write wins" field can end up holding a PID that has
     * no packets at all. Accepting the whole set of advertised video PIDs makes
     * discovery self-correcting.
     */
    this.videoPids = new Set();
    /** Calibrated PTS field window; null until enough frames have been seen. */
    this.ptsWindow = null;
    /** Learned frame duration in 90 kHz ticks. */
    this.frameDuration = null;
    /** window -> { deltas: number[], last: number|null, canonical: boolean } */
    this.observations = new Map();
    this.stats = {
      bytes: 0,
      packets: 0,
      ptsSamples: 0,
      resyncs: 0,
      pmtParsed: 0,
      windows: 0,
      frameDuration: 0,
      videoPids: 0,
    };
  }

  /** Feed raw MPEG-TS bytes. Never throws. */
  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    try {
      this.pushUnsafe(chunk);
    } catch {
      /* a corrupt stream must not take the session down */
    }
  }

  pushUnsafe(chunk) {
    this.stats.bytes += chunk.length;
    let buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;

    if (!this.synced) {
      const offset = findSyncOffset(buf);
      if (offset < 0) {
        // Keep the tail: a header may straddle the chunk boundary.
        this.carry = buf.subarray(Math.max(0, buf.length - (PACKET_SIZE * 3)));
        return;
      }
      buf = buf.subarray(offset);
      this.synced = true;
      this.stats.resyncs += 1;
    }

    let pos = 0;
    while (pos + PACKET_SIZE <= buf.length) {
      if (buf[pos] !== SYNC_BYTE) {
        // Lost alignment: hunt for the next plausible header.
        const offset = findSyncOffset(buf, pos + 1);
        if (offset < 0) {
          pos = Math.max(0, buf.length - (PACKET_SIZE * 3));
          break;
        }
        this.synced = true;
        pos = offset;
        continue;
      }
      this.handlePacket(buf, pos);
      pos += PACKET_SIZE;
    }

    this.carry = pos > 0 ? Buffer.from(buf.subarray(pos)) : buf;
    // Hard bound on retained bytes (three max-size packets).
    if (this.carry.length > PACKET_SIZE * 4) {
      this.carry = this.carry.subarray(this.carry.length - PACKET_SIZE * 2);
    }
  }

  handlePacket(buf, pos) {
    this.stats.packets += 1;
    const b1 = buf[pos + 1];
    const payloadUnitStart = (b1 & 0x40) !== 0;
    const pid = ((b1 & 0x1f) << 8) | buf[pos + 2];
    const adaptationControl = (buf[pos + 3] & 0x30) >> 4;
    const isPsi = adaptationControl === 1 || adaptationControl === 3;

    if (adaptationControl === 0) return; // reserved: no payload

    let offset = pos + 4;
    if (adaptationControl === 2) return; // adaptation only
    if (adaptationControl === 3) {
      const afLen = buf[offset];
      if (afLen > 0 && (buf[offset + 1] & 0x80) !== 0) {
        // discontinuity_indicator: drop the next PTS, it will jump.
        this.lastDiscontinuityWall = Date.now();
      }
      offset += 1 + afLen;
    }
    if (offset >= pos + PACKET_SIZE) return;

    if (pid === PID_PAT) {
      // The PAT carries the pointer_field before the section; it tells us which
      // PID holds the PMT, and the PMT is what names the video elementary PID.
      if (payloadUnitStart) this.parsePat(buf, offset);
      return;
    }
    if (this.pmtPids.has(pid)) {
      if (payloadUnitStart && isPsi) this.parsePmt(buf, offset);
      return;
    }

    if (!this.videoPids.has(pid)) return;
    if (!payloadUnitStart) return;

    const pts = this.parsePesPts(buf, offset);
    if (pts === null) return;
    if (Date.now() - this.lastDiscontinuityWall < 250) return;

    // Reject a backwards step (wrap-around, or a mis-read). The threshold is one
    // frame, expressed in 90 kHz ticks.
    const backLimit = this.frameDuration ?? MIN_DELTA;
    if (this.lastPts !== null && pts < this.lastPts - backLimit) return;
    this.lastPts = pts;
    this.stats.ptsSamples += 1;
    this.stats.windows = this.ptsWindow;
    // Convert out of the 90 kHz MPEG-TS timebase. Everything downstream names
    // this value `ptsMs` and treats it as milliseconds, so emitting raw ticks
    // here makes every consumer wrong by a factor of 90.
    this.onSample({ ptsMs: pts / PTS_TICKS_PER_MS, wallMs: Date.now() });
    this.lastEmitWall = Date.now();
  }

  /**
   * Program Association Table -> the PID(s) carrying a PMT.
   * Layout after the section header: program_number(2) then, per program,
   * reserved(3)+program_map_PID(13).
   */
  parsePat(buf, offset) {
    let p = offset + 1;
    if (p + 8 > buf.length) return;
    if (buf[p] !== 0x00) return; // table_id 0x00 == PAT
    const sectionLength = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
    p += 3; // table_id + section_length
    p += 5; // transport_stream_id(2) version(1) section_number(1) last(1)
    const end = Math.min(p + sectionLength - 5, buf.length);
    while (p + 4 <= end) {
      const programNumber = (buf[p] << 8) | buf[p + 1];
      const pmtPid = (((buf[p + 2] & 0x1f) << 8) | buf[p + 3]) & PID_MASK;
      if (programNumber !== 0) this.pmtPids.add(pmtPid);
      p += 4;
    }
  }

  /** Program Map Table -> which elementary stream is the MPEG-1 video. */
  parsePmt(buf, offset) {
    let p = offset + 1;
    if (p + 12 > buf.length) return;
    if (buf[p] !== 0x02) return; // table_id 0x02 == PMT
    const sectionLength = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
    p += 3; // table_id + section_length
    p += 5; // program_number(2) version(1) section_number(1) last(1)
    p += 2; // reserved(3) + PCR_PID(13)
    if (p + 2 > buf.length) return;
    const programInfoLength = ((buf[p] & 0x0f) << 8) | buf[p + 1];
    p += 2 + programInfoLength;

    // sectionLength counts the bytes after the section_length field itself.
    const end = Math.min(p + sectionLength - 5, buf.length);
    let added = 0;
    while (p + 5 <= end) {
      const streamType = buf[p];
      const elementaryPid = (((buf[p + 1] & 0x1f) << 8) | buf[p + 2]) & PID_MASK;
      const esInfoLength = ((buf[p + 3] & 0x0f) << 8) | buf[p + 4];
      if (streamType === STREAM_TYPE_MPEG1_VIDEO && elementaryPid !== 0) {
        // Collect rather than overwrite: a truncated PMT can yield a bogus PID,
        // and the real one usually shows up in a later, well-formed section.
        if (!this.videoPids.has(elementaryPid)) added += 1;
        this.videoPids.add(elementaryPid);
        this.havePmt = true;
        this.stats.videoPids = this.videoPids.size;
      }
      p += 5 + esInfoLength;
    }
    if (added > 0) this.stats.pmtParsed += 1;
  }

  /**
   * Reads a 33-bit PTS from a 5-byte field.
   *
   * Note the operators: JavaScript bitwise ops are 32-bit, so the top PTS bit
   * (bit 32) cannot survive a `<<` - hence the explicit BigInt-free
   * decomposition below, which keeps the value below 2^32 and is correct for
   * every PTS the MPEG-TS muxer emits in practice.
   */
  static readPts(buf, at) {
    if (at < 0 || at + 5 > buf.length) return null;
    const b0 = buf[at];
    const b1 = buf[at + 1];
    const b2 = buf[at + 2];
    const b3 = buf[at + 3];
    const b4 = buf[at + 4];
    // A canonical PTS field has '0010' in the top nibble of byte 0 and bit 7 set
    // in bytes 2 and 4. Some muxers (FFmpeg's included) do not set them, so this
    // is only used as a preference, never as a hard requirement.
    const canonical = (b0 & 0xf0) === 0x20 && (b2 & 0x80) !== 0 && (b4 & 0x80) !== 0;
    const value = (((b0 & 0x0e) * 0x20000000) >>> 0) +
      b1 * 0x400000 +
      (b2 & 0xfe) * 0x4000 +
      b3 * 0x80 +
      ((b4 & 0xfe) >> 1);
    return { value, canonical };
  }

  /**
   * Extracts the PTS from a PES header that starts at `offset`.
   *
   * The nominal position of the field is `offset + 8`, but that is not
   * guaranteed: muxers differ, and FFmpeg's MPEG-TS muxer has been observed
   * emitting an extra header byte, which shifts the field by one and makes every
   * decode read five bytes of the wrong window (a plausible-looking value that
   * is off by a constant factor, so monotonicity checks do not catch it).
   *
   * So the offset is *calibrated* instead of assumed: the first two PES headers
   * decide which candidate window yields a sane frame delta, and that choice is
   * then reused (and re-validated) for the rest of the stream.
   */
  /**
   * Extracts the PTS for a PES header at `offset`.
   *
   * The nominal field position is `offset + 8`, but that is not dependable:
   * muxers differ, and FFmpeg's MPEG-TS muxer has been observed emitting an
   * extra header byte, which shifts the field by one. A wrong window does not
   * produce nonsense - it produces a *plausible* number (observed: 5.7e9 ticks
   * of garbage whose deltas still look frame-like), so neither monotonicity nor
   * a fixed sanity band can detect it.
   *
   * What does detect it is self-consistency: the correct window yields a frame
   * delta that barely varies, while a wrong one scatters. So the first frames
   * are used to *learn* which window that is, and from then on every sample is
   * checked against the learned frame duration.
   */
  parsePesPts(buf, offset) {
    if (offset + 14 > buf.length) return null;
    if (buf[offset] !== 0x00 || buf[offset + 1] !== 0x00 || buf[offset + 2] !== 0x01) {
      return null;
    }
    const streamId = buf[offset + 3];
    if ((streamId & 0xf0) !== 0xe0) return null; // not a video PES
    if (((buf[offset + 7] >> 6) & 0x03) < 2) return null; // no PTS in the header

    if (this.ptsWindow === null) return this.learnWindow(buf, offset);

    // Locked on: trust the learned window, but verify, and fall back if the
    // layout changes mid-stream.
    const primary = TsClock.readPts(buf, offset + PTS_BASE + this.ptsWindow);
    if (primary && this.plausible(primary.value)) return primary.value;
    for (const d of CANDIDATE_OFFSETS) {
      if (d === this.ptsWindow) continue;
      const read = TsClock.readPts(buf, offset + PTS_BASE + d);
      if (read && this.plausible(read.value)) {
        this.log?.warn?.({ window: d }, 'pts window changed mid-stream');
        this.ptsWindow = d;
        this.stats.windows = d;
        return read.value;
      }
    }
    return null;
  }

  /** Learning phase: score each candidate window by how steady its deltas are. */
  learnWindow(buf, offset) {
    for (const d of CANDIDATE_OFFSETS) {
      const read = TsClock.readPts(buf, offset + PTS_BASE + d);
      if (!read) continue;
      const obs = this.observations.get(d) ?? { deltas: [], last: null, canonical: read.canonical };
      obs.canonical ||= read.canonical;
      if (obs.last !== null) {
        const delta = read.value - obs.last;
        if (delta > 0 && delta <= MAX_DELTA) obs.deltas.push(delta);
      }
      obs.last = read.value;
      this.observations.set(d, obs);
    }

    let best = null;
    let bestScore = -1;
    for (const [d, obs] of this.observations) {
      if (obs.deltas.length < LEARN_DELTAS) continue;
      const med = median(obs.deltas);
      if (med < MIN_DELTA) continue;
      // Fraction of deltas that sit at (or just above) the median: the real
      // stream is ~100% consistent, a wrong window is a scatter.
      const consistent = obs.deltas.filter((x) => x >= med * 0.5 && x <= med * 4).length;
      const score = consistent / obs.deltas.length + (obs.canonical ? 0.05 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { window: d, median: med };
      }
    }
    if (!best) return null;

    this.ptsWindow = best.window;
    this.frameDuration = best.median;
    this.stats.windows = best.window;
    this.stats.frameDuration = Math.round(best.median);
    this.observations.clear();
    return null; // the first samples were only used to learn
  }

  /** A PTS is believable if it steps forward by a plausible frame duration. */
  plausible(pts) {
    if (this.lastPts === null || this.frameDuration === null) return true;
    const delta = pts - this.lastPts;
    return delta >= this.frameDuration * 0.5 && delta <= this.frameDuration * 4;
  }

  /** @returns {{ptsMs:number|null, ageMs:number, stats:object}} */
  sample() {
    return {
      // lastPts is kept in 90 kHz ticks for delta arithmetic; the public value
      // is milliseconds so it can be compared against a wall clock.
      ptsMs: this.lastPts === null ? null : this.lastPts / PTS_TICKS_PER_MS,
      ageMs: this.lastPts === null ? Infinity : Date.now() - this.lastEmitWall,
      stats: { ...this.stats },
    };
  }

  /** The PIDs currently accepted as MPEG-1 video. */
  get videoPid() {
    const [first] = this.videoPids;
    return first ?? UNKNOWN_PID;
  }
}

/**
 * Returns the index of a byte that starts a 188-byte aligned TS packet, or -1.
 *
 * A single 0x47 proves nothing - that value occurs constantly inside picture
 * data - so a second header at exactly +188 is required to confirm. When the
 * buffer does not reach that far we report "not yet" and the caller keeps its
 * carry, which is why this never stalls on small live chunks.
 */
function findSyncOffset(buf, from = 0) {
  for (let i = Math.max(0, from); i < buf.length; i += 1) {
    if (buf[i] !== SYNC_BYTE) continue;
    if (i + PACKET_SIZE >= buf.length) return -1; // unconfirmed: wait for more data
    if (buf[i + PACKET_SIZE] === SYNC_BYTE) return i;
  }
  return -1;
}
