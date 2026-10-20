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

// The OS TCP peer address, rather than spoofable X-Forwarded-For headers, decides if auth is needed.
export function authorizedRequest(remoteAddress, authorization, password) {
  if (isLoopback(remoteAddress)) return true;
  if (!isPrivateLANPeer(remoteAddress)) return false;
  if (!password || typeof authorization !== 'string' || !authorization.startsWith('Basic ')) return false;
  const token = authorization.slice(6);
  if (token.length > 1024 || !/^[\w+/=]+$/.test(token)) return false;
  try {
    const value = Buffer.from(token, 'base64').toString('utf8');
    return secureEqual(value, `signal:${password}`);
  } catch { return false; }
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
