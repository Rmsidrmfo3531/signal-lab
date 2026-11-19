import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';

export function isLoopback(address = '') {
  const text = String(address).toLowerCase();
  return text === '::1' || text === '127.0.0.1' || text.startsWith('127.') || text === '::ffff:127.0.0.1' || text.startsWith('::ffff:127.');
}


export function isPrivateLANPeer(address = '') {
  if (isLoopback(address)) return true;
  const raw = String(address).replace(/^::ffff:/i, '');
  const values = raw.split('.').map(Number);
  if (values.length !== 4 || values.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  return values[0] === 10 || (values[0] === 172 && values[1] >= 16 && values[1] <= 31) || (values[0] === 192 && values[1] === 168);
}

function secureEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyBasicAuth(authorization, password) {
  if (!password || typeof authorization !== 'string' || !authorization.startsWith('Basic ')) return false;
  const token = authorization.slice(6);
  if (token.length > 1024 || !/^[\w+/=]+$/.test(token)) return false;
  try {
    const value = Buffer.from(token, 'base64').toString('utf8');
    return secureEqual(value, `signal:${password}`);
  } catch { return false; }
}

export function isProxiedRequest(headers = {}) {
  if (!headers || typeof headers !== 'object') return false;
  return Boolean(headers['tailscale-user-login'] || headers['x-forwarded-for'] || headers['x-forwarded-proto'] || headers['forwarded']);
}

export function createAuthRateLimiter({ maxFailures = 10, windowMs = 5 * 60000, lockMs = 15 * 60000, maxKeys = 500, now = () => Date.now() } = {}) {
  const entries = new Map();
  const prune = (ts) => {
    for (const [k, v] of entries) {
      if (v.lockedUntil <= ts && ts - v.firstAt > windowMs) entries.delete(k);
    }
    while (entries.size > maxKeys) entries.delete(entries.keys().next().value);
  };
  return {
    isBlocked(key, ts = now()) {
      const item = entries.get(key);
      if (!item) return { blocked: false, retryAfterSec: 0, retryAfterMs: 0 };
      if (item.lockedUntil > ts) {
        const retryAfterMs = item.lockedUntil - ts;
        return { blocked: true, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)), retryAfterMs };
      }
      return { blocked: false, retryAfterSec: 0, retryAfterMs: 0 };
    },
    recordFailure(key, ts = now()) {
      prune(ts);
      const item = entries.get(key);
      if (!item || ts - item.firstAt > windowMs) {
        entries.set(key, { count: 1, firstAt: ts, lockedUntil: 0 });
        return { blocked: false, retryAfterSec: 0, retryAfterMs: 0 };
      }
      item.count++;
      if (item.count >= maxFailures) {
        item.lockedUntil = ts + lockMs;
        return { blocked: true, retryAfterSec: Math.max(1, Math.ceil(lockMs / 1000)), retryAfterMs: lockMs };
      }
      return { blocked: false, retryAfterSec: 0, retryAfterMs: 0 };
    },
    recordSuccess(key) { entries.delete(key); }
  };
}

// The OS TCP peer address, rather than spoofable X-Forwarded-For headers, decides if auth is needed.
// Reverse-proxied loopback requests (e.g. Tailscale Serve) can additionally enforce ALLOWED_TAILSCALE_USERS
// or MOBILE_ACCESS_PASSWORD when configured.
export function authorizedRequest(remoteAddress, authorization, password, { headers, allowedTailscaleUsers, requireProxyAuth = false } = {}) {
  if (isLoopback(remoteAddress)) {
    if (isProxiedRequest(headers)) {
      const hasAllowlist = Boolean(allowedTailscaleUsers && allowedTailscaleUsers.size > 0);
      if (hasAllowlist) {
        const login = String(headers?.['tailscale-user-login'] || '').trim().toLowerCase();
        if (!login || !allowedTailscaleUsers.has(login)) return false;
        if (!password) return true;
      }
      if (requireProxyAuth) return verifyBasicAuth(authorization, password);
    }
    return true;
  }
  if (!isPrivateLANPeer(remoteAddress)) return false;
  return verifyBasicAuth(authorization, password);
}

export function localIPv4Addresses(interfaces = os.networkInterfaces()) {
  const out = new Set();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ip = entry.address;
      const octets = ip.split('.').map(Number);
      if (octets.length !== 4 || octets.some(x => !Number.isInteger(x) || x < 0 || x > 255)) continue;
      const privateIP = octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
      if (privateIP) out.add(ip);
    }
  }
  return [...out];
}
