/**
 * Scrubbing of URLs and credentials out of text that is about to be logged or
 * sent to a browser.
 *
 * Both FFmpeg and yt-dlp echo the URL they were given when an input fails. For
 * a resolved YouTube stream that URL is not an ordinary link: it is signed, and
 * it carries the fetching machine's IP address, an expiry timestamp and a
 * signature. Quoting that text verbatim - in an error message rendered into the
 * page, or in a log file - republishes a working credential for whoever can
 * read it.
 *
 * The host is deliberately kept. It is the part that diagnoses the problem: a
 * 403 from `rr3---sn-…googlevideo.com` means the media link was rejected, which
 * is a completely different fault from a 403 on `www.youtube.com`.
 */

/**
 * Replaces URLs with `https://<host>/<redacted>` and blanks out credential-like
 * query parameters that can appear outside a URL.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactUrls(text) {
  return String(text ?? '')
    .replace(/\bhttps?:\/\/[^\s'"<>]+/gi, (raw) => {
      let host = 'unparseable-host';
      try {
        host = new URL(raw).host;
      } catch {
        /* keep the placeholder rather than echoing the original */
      }
      return `https://${host}/<redacted>`;
    })
    // Signed media URLs are the usual leak, but the same tokens turn up outside
    // a URL too (a Cookie or Referer header echoed back by a server).
    .replace(
      /\b(sig|lsig|lsparams|pot|ip|ipbits|expire|expireei|ei|spc|cpn|signature)=[^\s&;"']+/gi,
      '$1=<redacted>',
    );
}

export default redactUrls;
