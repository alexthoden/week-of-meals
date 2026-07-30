'use strict';

const crypto = require('crypto');

/**
 * Cloudflare Access, verified at the origin.
 *
 * Access already authenticated the person before their request reached this
 * machine: they signed in with Google, Cloudflare checked them against your
 * policy, and everyone else was turned away at the edge. So why check again?
 *
 * Because "the edge checked it" is only true of traffic that came through the
 * edge. Anything reaching this port directly — another VM on the same network,
 * a future misconfiguration, an SSH tunnel someone forgot about — arrives with
 * no checks at all. Cloudflare's own guidance for self-hosted applications is
 * to validate the assertion at the origin, and it costs one signature check.
 *
 * It also means the `Cf-Access-Authenticated-User-Email` header is never
 * trusted on its own. That header is trivially forgeable by anything that can
 * reach this port. The signed JWT beside it is not.
 *
 * Every check below exists because skipping it is a known way past a JWT:
 *
 *   - The algorithm is pinned to RS256. A token claiming `"alg":"none"` or
 *     asking for HMAC is refused outright. Trusting the header's own choice of
 *     algorithm lets an attacker pick one they can forge.
 *   - The signature is verified BEFORE any claim is read.
 *   - `aud` must equal your Access application's AUD tag, so an assertion
 *     minted for a different application on the same account will not work.
 *   - `iss` must be your team domain, and `exp` must be in the future.
 */

/** Small clock tolerance: a VM's clock and Cloudflare's differ slightly. */
const SKEW_SECONDS = 60;

/* Overridable so tests can assert on it without writing to the real console. */
let log = (message) => console.warn(`  ${message}`);
function setLogger(fn) { log = fn; }

function b64url(part) {
  return Buffer.from(String(part).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function fail(message, code = 'AUTH', status = 401) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function teamDomain(team) {
  const name = String(team || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!name) return '';
  return name.includes('.') ? name : `${name}.cloudflareaccess.com`;
}

function certsUrl(team) {
  return `https://${teamDomain(team)}/cdn-cgi/access/certs`;
}

/**
 * Caches Cloudflare's signing keys. They rotate every few weeks and the cache
 * lives as long as the process, so this is a handful of fetches a month.
 */
function createKeyStore({ team, fetchImpl = fetch, ttlMs = 3600000 } = {}) {
  let keys = new Map();
  let expiresAt = 0;
  let inFlight = null;

  /**
   * One fetch at a time, however many requests are waiting on it.
   *
   * Photos are authenticated now, so opening a recipe grid fires twenty
   * requests at once — and on a cold or just-expired cache every one of them
   * used to start its own fetch to Cloudflare. Twenty simultaneous JWKS
   * requests is a good way to get rate limited or time out, and a timeout here
   * surfaces as a failed sign-in, which the browser reads as "session expired".
   *
   * Sharing the in-flight promise makes a burst cost exactly one fetch.
   */
  async function refresh() {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const res = await fetchImpl(certsUrl(team), { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw fail(`Could not reach Cloudflare to check the sign-in (${res.status}).`, 'JWKS', 503);
      const body = await res.json();
      keys = new Map((body.keys || []).map((k) => [k.kid, k]));
      expiresAt = Date.now() + ttlMs;
    })();

    try {
      return await inFlight;
    } finally {
      // Cleared either way: a failed refresh must not poison the next attempt.
      inFlight = null;
    }
  }

  return {
    async get(kid) {
      // An unknown kid may just mean the keys rotated, so refresh once first.
      if (!keys.has(kid) || Date.now() > expiresAt) await refresh();
      const jwk = keys.get(kid);
      if (!jwk) throw fail('That sign-in was not signed by Cloudflare Access.', 'BAD_KID');
      return jwk;
    },
    /** Test seam: supply keys directly instead of fetching. */
    _seed(jwkList, ms = ttlMs) {
      keys = new Map(jwkList.map((k) => [k.kid, k]));
      expiresAt = Date.now() + ms;
    },
  };
}

/**
 * Verify a Cloudflare Access assertion and return its claims.
 * Throws on anything suspicious; never returns a half-checked token.
 */
async function verifyAccessToken(token, { team, aud, keyStore, now = Date.now() }) {
  if (!team) throw fail('The server has no Access team configured.', 'NO_TEAM', 500);
  if (!aud) throw fail('The server has no Access application AUD configured.', 'NO_AUD', 500);
  if (typeof token !== 'string' || !token) throw fail('No Cloudflare Access assertion on this request.', 'NO_TOKEN');

  const parts = token.split('.');
  if (parts.length !== 3) throw fail('That Access assertion is malformed.', 'MALFORMED');

  let header;
  try {
    header = JSON.parse(b64url(parts[0]).toString('utf8'));
  } catch {
    throw fail('That Access assertion is malformed.', 'MALFORMED');
  }

  // Pin the algorithm. Never take the header's word for it.
  if (header.alg !== 'RS256') throw fail('Unsupported Access assertion algorithm.', 'BAD_ALG');
  if (!header.kid) throw fail('That Access assertion has no key id.', 'NO_KID');

  const jwk = await keyStore.get(header.kid);

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw fail('Could not read the Cloudflare signing key.', 'BAD_JWK', 503);
  }

  // Signature first. Nothing below this line runs on an unverified token.
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  if (!crypto.verify('RSA-SHA256', signed, publicKey, b64url(parts[2]))) {
    throw fail('That Access assertion failed verification.', 'BAD_SIGNATURE');
  }

  let claims;
  try {
    claims = JSON.parse(b64url(parts[1]).toString('utf8'));
  } catch {
    throw fail('That Access assertion is malformed.', 'MALFORMED');
  }

  if (claims.iss !== `https://${teamDomain(team)}`) {
    throw fail('That Access assertion came from another team.', 'BAD_ISS');
  }

  // Without this, an assertion for a different Access application would pass.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(aud)) {
    const err = fail('That Access assertion was issued for a different application.', 'BAD_AUD');
    /*
     * Both values, because "they do not match" without them is still a hunt
     * through a dashboard. An AUD tag identifies an Access application; it is
     * not a credential and cannot be used to authenticate, so putting it in the
     * server's own log is safe in a way the assertion beside it never is.
     *
     * Seeing them side by side also names the usual culprits immediately: a tag
     * copied from the wrong application, a value quoted in an EnvironmentFile
     * (systemd keeps the quotes), or a second Access application covering the
     * same hostname and minting the assertion instead.
     */
    err.detail = `configured ${aud}, assertion carries ${audiences.filter(Boolean).join(', ') || '(none)'}`;
    throw err;
  }

  const seconds = Math.floor(now / 1000);
  if (!claims.exp || claims.exp + SKEW_SECONDS < seconds) throw fail('That sign-in expired. Reload the page.', 'EXPIRED');
  if (claims.nbf && claims.nbf - SKEW_SECONDS > seconds) throw fail('That sign-in is not valid yet.', 'NOT_YET');
  if (!claims.email) throw fail('That Access assertion carries no email address.', 'NO_EMAIL');

  return claims;
}

/** Optional second allowlist, on top of the Access policy. */
function parseAllowList(env = process.env) {
  const emails = new Set(
    String(env.ALLOWED_EMAILS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  const domains = new Set(
    String(env.ALLOWED_DOMAINS || '')
      .split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
  );
  return { emails, domains };
}

function isAllowed(email, { emails, domains }) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) return false;
  if (emails.has(address)) return true;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return domains.has(domain);
}

/** Cloudflare sends the assertion in a header, and also in a cookie. */
function tokenFrom(req) {
  const header = req.get('cf-access-jwt-assertion');
  if (header) return String(header).trim();
  const cookie = String(req.get('cookie') || '');
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * Express middleware.
 *
 * With no CF_ACCESS_TEAM set it does nothing, which is how the app runs on a
 * laptop. Set the team and AUD and every /api request must carry a valid
 * assertion.
 */
function middleware(options = {}) {
  const env = options.env || process.env;
  const team = options.team || env.CF_ACCESS_TEAM || '';
  const aud = options.aud || env.CF_ACCESS_AUD || '';
  const allow = options.allow || parseAllowList(env);
  // Mounted middleware sees a path relative to its mount point, so both forms
  // are matched. Getting this wrong locks the browser out of its own bootstrap.
  const publicPaths = options.publicPaths
    || [/^\/whoami$/, /^\/api\/whoami$/, /^\/healthz$/, /^\/api\/healthz$/];

  if (!team || !aud) {
    return (req, res, next) => { req.user = { email: 'local', local: true }; next(); };
  }

  const keyStore = options.keyStore || createKeyStore({ team, fetchImpl: options.fetchImpl });

  return async (req, res, next) => {
    const bare = req.originalUrl.split('?')[0];
    const isPublic = publicPaths.some((re) => re.test(req.path) || re.test(bare));

    /*
     * Public paths are still identified when they can be, they just are not
     * required to be.
     *
     * They used to return before any verification ran, which meant req.user was
     * never set on them — so /api/whoami, whose entire job is to say who you
     * are, could never say. It reported nobody signed in no matter who asked.
     * Verifying first and only forgiving the failure restores that without
     * making the endpoint unanswerable when Cloudflare is unreachable, which is
     * what made it public in the first place.
     */
    try {
      const claims = await verifyAccessToken(tokenFrom(req), { team, aud, keyStore });

      // Belt and braces. Access already applied your policy; this only matters
      // if the two ever drift apart.
      if ((allow.emails.size || allow.domains.size) && !isAllowed(claims.email, allow)) {
        if (isPublic) return next();
        return res.status(403).json({
          error: `${claims.email} is not on the household list.`,
          code: 'NOT_ALLOWED',
        });
      }

      req.user = { email: String(claims.email).toLowerCase(), sub: claims.sub };
      return next();
    } catch (err) {
      if (isPublic) return next();

      /*
       * Say so in the log, once per rejection.
       *
       * A refused sign-in is invisible from the server otherwise: the browser
       * shows a message, the operator sees a working service, and the two
       * never meet. This is the line that turns "it keeps saying my login
       * expired" into a code you can act on. It carries the code and the path
       * and nothing else — never the assertion, which is a live credential.
       */
      log(`sign-in refused: ${err.code || 'AUTH'} on ${req.method} ${bare}`
        + (err.detail ? `\n    ${err.detail}` : ''));
      return res.status(err.status || 401).json({ error: err.message, code: err.code || 'AUTH' });
    }
  };
}

module.exports = {
  middleware, verifyAccessToken, createKeyStore, parseAllowList, isAllowed,
  teamDomain, certsUrl, tokenFrom, setLogger, SKEW_SECONDS,
};
