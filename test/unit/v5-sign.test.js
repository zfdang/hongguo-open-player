// SPDX-License-Identifier: GPL-3.0-only
// v04.10.03 signing vectors from N3urda/hongguoTV (GPL-3.0-only).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
    hashF13V5, AesV3V5, branchV5, signPlaybackV5, encodeValues,
} = require('../../src/server/native/v5-sign');

const hex = value => Buffer.from(value, 'hex');
const vectorsDir = path.join(__dirname, '..', 'fixtures', 'v5');

test('v5 AesV3 matches official carrier vectors byte-for-byte', () => {
    if (!fs.existsSync(path.join(vectorsDir, 'signing-v5-carrier.json'))) return;
    const rows = JSON.parse(fs.readFileSync(path.join(vectorsDir, 'signing-v5-carrier.json'), 'utf8'));
    assert.equal(rows.length, 4);
    for (const [i, row] of rows.entries()) {
        const actual = new AesV3V5(hex(row.key), row.ts).encrypt(hex(row.source), hex(row.iv)).toString('hex');
        assert.equal(actual, row.encrypted, `carrier variant ${i}`);
    }
});

test('v5 hashF13 matches independent SDK digest vectors across timestamp rotations', () => {
    if (!fs.existsSync(path.join(vectorsDir, 'signing-v5-f13.json'))) return;
    const rows = JSON.parse(fs.readFileSync(path.join(vectorsDir, 'signing-v5-f13.json'), 'utf8'));
    assert.equal(rows.length, 32);
    for (const [i, row] of rows.entries()) {
        const result = hashF13V5(hex(row.query), hex(row.body), row.ts);
        assert.equal(result.length, 20);
        assert.equal(result.subarray(0, 16).toString('hex'), row.digest, `timestamp class ${i}`);
        assert.equal(result[16] & 0x24, 0x24, 'checksum bit 5 is set for v5');
    }
});

test('v5 playback signing searches only _rticket and binds compressed body and identity', () => {
    const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04]);
    const values = {
        aid: '8662', app_name: 'novelread', version_code: '74332', version_name: '7.4.3.32',
        channel: 'vivo_8662_64', device_platform: 'android', device_type: 'PGT-AN10',
        os_version: '12', update_version_code: '74332',
        iid: '456', cdid: 'synthetic-cdid', device_id: '123',
    };
    const now = 1800000000000;
    const ts = Math.floor(now / 1000);
    const base = 'https://example.test/model';
    const signed = signPlaybackV5(base, values, body, now);
    const url = new URL(signed.url);
    assert.equal(url.searchParams.has('ts'), false);
    for (const [key, value] of Object.entries(values)) {
        if (key === '_rticket') continue;
        assert.equal(url.searchParams.get(key), value, `query preserves ${key}`);
    }
    assert.equal(branchV5(url.search.slice(1), body, ts), 0);
    assert.equal(signed.headers['x-khronos'], String(ts));
    assert.equal(signed.headers['x-ss-stub'], createHash('md5').update(body).digest('hex').toUpperCase());
    assert.deepEqual(Object.keys(signed.headers).sort(),
        ['Content-Type', 'x-helios', 'x-khronos', 'x-medusa', 'x-ss-stub']);
    assert.ok(signed.headers['x-medusa'].length > 100);
    assert.ok(signed.headers['x-helios'].length > 20);
});

test('v5 signing rejects invalid branch inputs deterministically', () => {
    const query = createHash('sha256').update('bad').digest().subarray(0, 32);
    const body = createHash('md5').update('body').digest();
    // A wrong ts almost never lands on branch 12; hashF13V5 must refuse it.
    assert.throws(() => hashF13V5(query, body, 1800000000), /v5 hash branch unsupported/);
    assert.equal(typeof encodeValues({ a: '7.4.3.32', b: '~x y' }), 'string');
});
