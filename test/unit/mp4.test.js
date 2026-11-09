const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decryptMp4Buffer } = require('../../src/server/native/hongguo');
function box(type, payload = Buffer.alloc(0)) {
  const result = Buffer.alloc(8 + payload.length);
  result.writeUInt32BE(result.length);
  result.write(type, 4);
  payload.copy(result, 8);
  return result;
}
test('MP4 rejects nonadvancing, truncated and excessively nested boxes', () => {
  const extended = Buffer.alloc(16);
  extended.writeUInt32BE(1);
  extended.write('mdat', 4); // extended size zero would previously loop forever
  assert.throws(() => decryptMp4Buffer(Buffer.concat([box('moov'), extended])), /box size/);
  assert.throws(() => decryptMp4Buffer(Buffer.concat([box('moov'), Buffer.from([1])])), /Truncated/);
  const short = Buffer.from(extended.subarray(0, 8));
  assert.throws(() => decryptMp4Buffer(short), /header/);
  let nested = box('free');
  for (let i = 0; i < 35; i++) nested = box('moov', nested);
  assert.throws(() => decryptMp4Buffer(nested), /nesting/);
  const valid = Buffer.concat([box('ftyp'), box('moov'), box('mdat', Buffer.from('media'))]);
  assert.deepEqual(decryptMp4Buffer(Buffer.from(valid)), valid);
});

test('faststart places moov before media and relocates chunk offsets', () => {
  function moov(offset) {
    const table = Buffer.alloc(12);
    table.writeUInt32BE(1, 4);
    table.writeUInt32BE(offset, 8);
    return box('moov', box('trak', box('mdia', box('minf', box('stbl',
      box('stco', table))))));
  }
  for (const mediaFirst of [true, false]) {
    const media = box('mdat', Buffer.alloc(100));
    const originalMoov = moov(0);
    const offset = mediaFirst ? 8 : originalMoov.length + 8;
    const input = mediaFirst ? Buffer.concat([media, moov(offset)]) : Buffer.concat([moov(offset), media]);
    const output = decryptMp4Buffer(input);
    const tablePosition = output.indexOf(Buffer.from('stco')) - 4;
    assert.equal(output.readUInt32BE(tablePosition + 16), originalMoov.length + 8);
    assert.ok(output.indexOf(Buffer.from('moov')) < output.indexOf(Buffer.from('mdat')));
  }
});

test('native CTR decrypts complete and partial AES blocks including binary data', () => {
  const { encryptedMp4 } = require('../helpers/mp4');
  const crypto = require('node:crypto');
  const key = crypto.randomBytes(16), nonce = crypto.randomBytes(8);
  for (const length of [1, 15, 16, 17, 1024 * 1024 + 3]) {
    const plain = crypto.randomBytes(length);
    const output = decryptMp4Buffer(encryptedMp4(plain, key, nonce), key);
    assert.deepEqual(output.subarray(output.indexOf(Buffer.from('mdat')) + 4), plain);
  }
});

test('unsupported subsample and 16-byte IV CENC layouts fail explicitly', () => {
  const { encryptedMp4 } = require('../helpers/mp4');
  for (const [nonce, flags] of [[Buffer.alloc(8), 2], [Buffer.alloc(16), 0]]) {
    assert.throws(() => decryptMp4Buffer(encryptedMp4(Buffer.alloc(32), Buffer.alloc(16), nonce, flags), Buffer.alloc(16)), /Unsupported CENC/);
  }
});

test('whole-file decryption preserves the encrypted input buffer', () => {
  const { encryptedMp4 } = require('../helpers/mp4');
  const input = encryptedMp4(Buffer.alloc(31), Buffer.alloc(16), Buffer.alloc(8));
  const original = Buffer.from(input);
  decryptMp4Buffer(input, Buffer.alloc(16));
  assert.deepEqual(input, original);
});

test('missing keys reject encrypted MP4 while allowing clear MP4', () => {
  const { encryptedMp4 } = require('../helpers/mp4');
  const { assertUnencryptedMp4 } = require('../../src/server/native/hongguo');
  const key = Buffer.alloc(16);
  const encrypted = encryptedMp4(Buffer.alloc(32), key, Buffer.alloc(8));
  assert.throws(() => decryptMp4Buffer(encrypted), /Invalid CENC key/);
  assert.throws(() => assertUnencryptedMp4(encrypted), /Invalid CENC key/);
  const clear = decryptMp4Buffer(encrypted, key);
  assert.doesNotThrow(() => assertUnencryptedMp4(clear));
  assert.deepEqual(decryptMp4Buffer(clear), clear);
});
