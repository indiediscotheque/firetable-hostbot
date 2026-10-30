// HTTP requests for the bot, on Node's built-in fetch (replaces the
// deprecated "request" package). Every request has a timeout.
"use strict";

var DEFAULT_TIMEOUT = 15000;

/**
 * @param {string|URL} url
 * @param {Object} [opts] - method, headers, body, timeout (ms), binary (read the
 *   body as a Buffer instead of text), maxBytes (refuse bigger bodies)
 * @returns {Promise<{status: number, headers: Headers, body: (string|Buffer), json: *}>}
 *   Resolves for any HTTP answer (check status); json is null when the body
 *   isn't JSON. Rejects only when there is no answer (network, timeout, size).
 */
function http(url, opts) {
  opts = opts || {};
  return fetch(url, {
    method: opts.method || "GET",
    headers: opts.headers,
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeout || DEFAULT_TIMEOUT)
  }).then(function(res) {
    var length = Number(res.headers.get("content-length"));
    if (opts.maxBytes && length > opts.maxBytes) throw new Error("answer too big (" + length + " bytes)");
    var read = opts.binary
      ? res.arrayBuffer().then(function(b) { return Buffer.from(b); })
      : res.text();
    return read.then(function(body) {
      if (opts.maxBytes && body.length > opts.maxBytes) throw new Error("answer too big (" + body.length + " bytes)");
      var json = null;
      if (!opts.binary) {
        try {
          json = JSON.parse(body);
        } catch (e) {
          json = null;
        }
      }
      return { status: res.status, headers: res.headers, body: body, json: json };
    });
  });
}

module.exports = { http: http };
