// SPDX-License-Identifier: GPL-3.0-only
const { CookieJar, Cookie } = require('tough-cookie');
const crypto = require('node:crypto');

const PLAYBACK_URL = 'https://api5-normal-sinfonlinea.fqnovel.com/novel/player/multi_video_model/player/v1';
const IDENTITY_COOKIES = new Set(['install_id', 'store-region', 'store-region-src']);

function createJar(device) {
    if (device.cookie_jar) {
        try { return CookieJar.deserializeSync(device.cookie_jar); } catch (_) { /* Migrate old/corrupt stores below. */ }
    }
    const jar = new CookieJar();
    // Legacy files have no scope information. Only the three protocol identity
    // cookies are shared with the two supported API families; never migrate tokens.
    for (const pair of String(device.cookie || '').split(';')) {
        const cookie = Cookie.parse(pair.trim());
        if (!cookie || !IDENTITY_COOKIES.has(cookie.key)) continue;
        for (const domain of ['fqnovel.com', 'snssdk.com']) {
            jar.setCookieSync(`${cookie.cookieString()}; Domain=${domain}; Path=/; Secure`, `https://${domain}/`, { ignoreError: true });
        }
    }
    return jar;
}

function applyCookies(jar, url, headers = {}) {
    const raw = headers['set-cookie'];
    const rows = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    let accepted = 0, rejected = 0;
    for (const row of rows) {
        const parsed = typeof row === 'string' && Cookie.parse(row);
        // ttreq is deliberately excluded: the existing protocol treats it as a
        // single-use request token, not a reusable session cookie.
        if (!parsed || parsed.key.toLowerCase() === 'ttreq') { rejected++; continue; }
        // Store Max-Age as an absolute deadline at receipt. This also prevents
        // subsequent reads/restarts from extending a relative lifetime.
        if (typeof parsed.maxAge === 'number') {
            parsed.expires = new Date(parsed.maxAge <= 0 ? 0 : Math.min(Date.now() + parsed.maxAge * 1000, 8640000000000000));
            parsed.maxAge = null;
        }
        try {
            const stored = jar.setCookieSync(parsed, url);
            if (stored) accepted++; else rejected++;
        } catch (_) { rejected++; }
    }
    return { received: rows.length, accepted, rejected };
}

function cookieState(jar) {
    return JSON.stringify(jar.serializeSync().cookies.map(({ lastAccessed, ...cookie }) => cookie));
}

function cookieInfo(jar, url, now = Date.now()) {
    const cookies = jar.getCookiesSync(url);
    const expiries = cookies.map(c => c.expiryTime()).filter(Number.isFinite);
    return {
        cookie_names: cookies.map(c => c.key).sort(),
        cookie_count: cookies.length,
        cookie_next_expiry_at: expiries.length ? Math.min(...expiries) : null,
        cookie_expiry_remaining_ms: expiries.length ? Math.max(0, Math.min(...expiries) - now) : null,
    };
}

function deviceKey(device) {
    return crypto.createHash('sha256').update(`${device.device_id}:${device.iid}:${device.cdid}`).digest('hex').slice(0, 12);
}

module.exports = { createJar, applyCookies, cookieInfo, cookieState, deviceKey, PLAYBACK_URL };
