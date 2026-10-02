import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isSameOrigin } from '../src/middleware/security.js';

/**
 * The allow-list defaults to `localhost:8080`, so serving the app from any other
 * host - Render, Fly, a custom domain, even a LAN IP - means every request from
 * the app's own page carries an Origin that is not on the list.
 *
 * The symptom is subtle and total: the page loads, and then every asset is
 * answered with 403 `origin_not_allowed`, so the dashboard is blank and the log
 * reads `blocked cross-origin request` for the app's *own* URL.
 */
describe('isSameOrigin', () => {
  /** A request as Express would present it behind Render's proxy. */
  const proxiedHttps = (host, extra = {}) => ({
    headers: { host, 'x-forwarded-proto': 'https', ...extra },
    socket: { encrypted: false },
  });

  const plainHttp = (host, extra = {}) => ({
    headers: { host, ...extra },
    socket: { encrypted: false },
  });

  test('allows the app served from its own https domain', () => {
    // The exact case from the deployment log.
    assert.equal(
      isSameOrigin(proxiedHttps('youtube2-6yds.onrender.com'), 'https://youtube2-6yds.onrender.com'),
      true,
    );
  });

  test('allows a custom domain and a bare LAN IP', () => {
    assert.equal(isSameOrigin(proxiedHttps('stream.example.com'), 'https://stream.example.com'), true);
    assert.equal(isSameOrigin(plainHttp('192.168.1.50:8080'), 'http://192.168.1.50:8080'), true);
  });

  test('allows a different port only when Host says so', () => {
    assert.equal(isSameOrigin(plainHttp('my-host:8080'), 'http://my-host:8080'), true);
    assert.equal(isSameOrigin(plainHttp('my-host:8080'), 'http://my-host:9999'), false);
  });

  test('still blocks a foreign origin - the CSRF case that matters', () => {
    assert.equal(
      isSameOrigin(proxiedHttps('youtube2-6yds.onrender.com'), 'https://evil.example.com'),
      false,
    );
    // And the subdomain trick.
    assert.equal(
      isSameOrigin(proxiedHttps('youtube2-6yds.onrender.com'), 'https://youtube2-6yds.onrender.com.evil.test'),
      false,
    );
    assert.equal(
      isSameOrigin(proxiedHttps('youtube2-6yds.onrender.com'), 'https://evilyoutube2-6yds.onrender.com'),
      false,
    );
  });

  test('refuses a scheme downgrade on an https deployment', () => {
    // Host matches, but the origin is http while the deployment is https. An
    // attacker on the network path could serve their own page from
    // http://our-host, and the browser would let it talk to this server.
    assert.equal(
      isSameOrigin(proxiedHttps('my-host'), 'http://my-host'),
      false,
    );
  });

  test('honours the first entry of a chained x-forwarded-proto', () => {
    assert.equal(
      isSameOrigin(proxiedHttps('my-host', { 'x-forwarded-proto': 'https, http' }), 'https://my-host'),
      true,
    );
  });

  test('falls back to the socket when there is no proxy header', () => {
    assert.equal(
      isSameOrigin({ headers: { host: 'my-host' }, socket: { encrypted: true } }, 'https://my-host'),
      true,
    );
    assert.equal(
      isSameOrigin({ headers: { host: 'my-host' }, socket: { encrypted: false } }, 'https://my-host'),
      false,
    );
  });

  test('rejects a malformed or missing origin rather than throwing', () => {
    const req = proxiedHttps('my-host');
    assert.equal(isSameOrigin(req, 'not a url'), false);
    assert.equal(isSameOrigin(req, ''), false);
    assert.equal(isSameOrigin(req, undefined), false);
    assert.equal(isSameOrigin(req, null), false);
  });

  test('rejects when there is no Host to compare against', () => {
    // HTTP/1.0 clients may omit Host. Failing closed is the safe direction:
    // there is no way to establish same-origin, so it is not same-origin.
    assert.equal(isSameOrigin({ headers: {}, socket: {} }, 'https://my-host'), false);
  });
});