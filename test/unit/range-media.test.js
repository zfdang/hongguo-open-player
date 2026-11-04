const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { encryptedMp4 } = require('../helpers/mp4');
const { decryptMp4Buffer } = require('../../src/server/native/hongguo');
const { prepareRangeMedia } = require('../../src/server/services/rangeMedia');

for (const metadataLast of [false, true]) test(`streaming random byte ranges match whole-file decryption (tail moov/co64: ${metadataLast})`, async t => {
  const key = crypto.randomBytes(16);
  const encrypted = encryptedMp4(crypto.randomBytes(2 * 1024 * 1024 + 7), key, crypto.randomBytes(8), 0, { metadataLast, largeOffsets: metadataLast });
  const expected = decryptMp4Buffer(Buffer.from(encrypted), key);
  let transferred = 0, requests = 0;
  const server = http.createServer((req, res) => {
    const [, a, b] = req.headers.range.match(/bytes=(\d+)-(\d+)/);
    const from = Number(a), to = Math.min(Number(b), encrypted.length - 1);
    transferred += to - from + 1;
    requests++;
    res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${encrypted.length}` });
    res.end(encrypted.subarray(from, to + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const plan = await prepareRangeMedia({ url: `http://127.0.0.1:${server.address().port}`, contentKey: key }, () => ({}), new AbortController().signal);
  assert.ok(transferred <= 65536 + 4096, 'metadata preparation must stay within the bounded prefetch budget');
  assert.equal(requests, metadataLast ? 3 : 1);
  assert.equal(plan.size, expected.length);
  for (const [start, end] of [[0, 255], [1031, 2009], [expected.length - 100, expected.length - 1], [0, expected.length - 1]]) {
    const pieces = [];
    for await (const piece of plan.read(start, end, new AbortController().signal)) pieces.push(piece);
    assert.deepEqual(Buffer.concat(pieces), expected.subarray(start, end + 1));
  }
  const abort = new AbortController(); abort.abort(new Error('closed'));
  await assert.rejects(async () => { for await (const chunk of plan.read(200, 999, abort.signal)) void chunk; }, /closed/);
});

test('a CDN ignoring Range is detected before buffering its full response', async t => {
  const server = http.createServer((req, res) => res.end(Buffer.alloc(128)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(prepareRangeMedia({ url: `http://127.0.0.1:${server.address().port}` }, () => ({}), new AbortController().signal), { code: 'RANGE_UNSUPPORTED' });
});


test('prefetch handles short files and rejects malformed range responses', async t => {
  const key = crypto.randomBytes(16);
  const encrypted = encryptedMp4(crypto.randomBytes(128), key, crypto.randomBytes(8));
  let malformed = false;
  const server = http.createServer((req, res) => {
    const [, a, b] = req.headers.range.match(/bytes=(\d+)-(\d+)/);
    const from = Number(a), to = Math.min(Number(b), encrypted.length - 1);
    res.writeHead(206, { 'Content-Range': `bytes ${from}-${malformed ? to - 1 : to}/${encrypted.length}` });
    res.end(encrypted.subarray(from, to + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const variant = { url: `http://127.0.0.1:${server.address().port}`, contentKey: key };
  const plan = await prepareRangeMedia(variant, () => ({}), new AbortController().signal);
  assert.ok(plan.size > 0);
  malformed = true;
  await assert.rejects(prepareRangeMedia(variant, () => ({}), new AbortController().signal), /Invalid CDN size probe/);
});
