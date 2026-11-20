// SPDX-License-Identifier: GPL-3.0-only
// v04.10.03 mobile playback signing (mobileV5=true).
// Ported from N3urda/hongguoTV core Signer.kt / AesV3.kt / V5Constants.kt
// (which are themselves ports of drpys 22261ad, GPL-3.0-only).
// Crypto tables and SDK protocol constants below are not user credentials.
//
// Scope: ONLY the /novel/player/multi_video_model/player/v1 playback endpoint.
// Search/catalogue endpoints keep the legacy v3 signer in app-source.js.
const crypto = require('node:crypto');
const sm3 = require('./sm3');

// ---------- low-level helpers (mirror Signer.kt / Bytes.kt) ----------
function u32(value) { return Number(value) >>> 0; }
function rol32(value, count) { const n = count & 31; const x = u32(value); return u32((x << n) | (x >>> (32 - n))); }
function ror32(value, count) { const n = count & 31; const x = u32(value); return u32((x >>> n) | (x << (32 - n))); }
function le32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(u32(value)); return b; }
function be32(value) { const b = Buffer.alloc(4); b.writeUInt32BE(u32(value)); return b; }
function zigzag(value) { const n = BigInt(value); return n < 0n ? ((-n) * 2n - 1n) : n * 2n; }
function varint(value) { let n = BigInt(value); const out = []; while (n > 127n) { out.push(Number((n & 127n) | 128n)); n >>= 7n; } out.push(Number(n)); return Buffer.from(out); }
function protoField(tag, value, type = 'string') {
    if (value === undefined || value === null || value === '') return Buffer.alloc(0);
    if (type === 'bytes' || type === 'string' || type === 'message') {
        const body = type === 'bytes' ? Buffer.from(value) : type === 'message' ? value : Buffer.from(String(value));
        return Buffer.concat([varint((BigInt(tag) << 3n) | 2n), varint(body.length), body]);
    }
    if (type === 'float') { const body = Buffer.alloc(4); body.writeFloatLE(Number(value)); return Buffer.concat([varint((BigInt(tag) << 3n) | 5n), body]); }
    return Buffer.concat([varint(BigInt(tag) << 3n), varint(type === 'sint' ? zigzag(value) : value)]);
}
function proto(fields) { return Buffer.concat(fields.map(([tag, value, type]) => protoField(tag, value, type))); }
function getIv(iv, data) { let value = u32(iv); for (let i = 0; i < data.length; i += 1) { if ((i & 1) === 0) value = u32((value >>> 4) ^ value ^ (value << 6) ^ data[i]); else value = u32(~((value >>> 7) ^ value ^ (data[i] | (value << 12)))); } return value; }
function sumMd5(data) { let check = 0x20220420; for (let i = 0; i < 12; i += 1) { const temp = (i & 1) === 0 ? (check >>> 3) ^ check : (check >>> 5) ^ check; check = (i & 1) === 0 ? data[i] ^ (check << 7) : data[i] | (check << 11); if ((i & 1) !== 0) check = ~check; check = u32(check ^ temp); } return u32((check | 4) ^ 0x1000000); }
function xorBytes(a, b) { const out = Buffer.alloc(a.length); for (let i = 0; i < out.length; i += 1) out[i] = a[i] ^ b[i % b.length]; return out; }
function bxor(a, b) { const out = Buffer.alloc(Math.min(a.length, b.length)); for (let i = 0; i < out.length; i += 1) out[i] = a[i] ^ b[i]; return out; }
function md5(data) { return crypto.createHash('md5').update(data).digest(); }
function upperHex(data) { return data.toString('hex').toUpperCase(); }

// ---------- V5Constants.kt ----------
const V5_MAGIC = Buffer.from('2d4b4fca49750d433fb5ae2c226dcc56', 'hex');
const V5_LICENSE = '646637794';
const V5_SIGN_KEY = Buffer.from(
    'b23c2a470a20d105dc3f8c4438f8272ed46d6c89ffdcdedd5108698d26e9489d', 'hex');
const V5_SBOX = Buffer.from(
    '53290fe9e51f316f90f74a7e034d367784ab49237cd0135cdc632c322fd3be0e2624a417ecd9151a7ff64f60730a87f9445ec6ada2f865d22b696c4188f24c0d' +
    'f37b75510b939f6bc2fe6883e68bc8c722181ba0bdb08c9871b50c9a16b46eea8eed20ba4b8a14e0fcf1468dbbef05a93e5a9d7dcf06898635c1fd99f5de287a' +
    '80c594daaab19b6279fbd75070cb52eb2555c456e39e7839853874e2f0013ac0b64742d8ca10e4b79c955de8b843ce4ed464a6a72ed508091c92e7b3eedd1e1d' +
    'd12afac321618fa3d65f9167c982f43d66a53c6a1997585b346dbf9672ff37cdbc073b2dae11453304df00815476b2a13fccdb30b957a8acafe1274002485912' +
    '38922563e36406d37a24100b7902a028044e218453c2a399199c9d13dc40c55ba67e502273850ebdc1a2e2188b8f2d9e3cb909b8c46a2a9f4a6dd93007eafa65' +
    'b7b3a881aa908cc74f0ad76bbbb58617c37012ca05a469fd44e62eecf1e4272ce860c0ae5eadf99b20d8f0234174006f3f110d7657d01645d4eff8f71471cbfe' +
    '1cb2f52648727bf3c9de55153e031b4d61757db63dbf7782eeafe9018a8891362fb14759ac32bab03b349aeb5a377c5156be4c8dfbe13a684bda39cf836697c8' +
    '94545fe0f2491acea9fc6252f4ff1e0fe72bd2df6e67a7f635e5bcc6d1a5dd951d89960887a18eb40c785cdb1f80ed42299333ab98cdd67f316cd54346585dcc' +
    'd759fb722789b08807cc0fda293f7e5e1819bb0353517020b31d3d00374952bea2c421e862040a9ec892a05b266b7a0d0cc316f483b81af39715657ffe32ad8d' +
    'e0c13077646035236ee5363e5f900e9a7cf850a81cd9960b6df73317226f99eaa6fff15cec34acb98246639b918ab2851466a7cdfc4ad1b52c2ae95a58d3734e' +
    '47ddd5b7560193f644ef9c408b7dee39b4d6aabf4de761e3252d4c7ba3843187745d55e6a5db05d42b45caed43c0c5d0b64bfa9d94a4a9d8f2f0e1a108dcfd28' +
    '8fd2bc1fc7bd675412138169cb09249875ba3b68cfb11180afae104fc9789571c6dfce02413886796ae21e3c488cc21b9f423a066c2eabf98e2fdeeb5776e4f5' +
    'd09a515ba58cbbab3e37b09fd4f6d9244df80512e84cd7956be301cf64f1429d58577cc241f3a2c655144f81aaf95a4e108da894b38970561ae9002619fbbac9' +
    '1fa922ed202bfc62cb08e0de2a7f3631435f8b47c8a3c563b4db4071ce74c46da6fa696a9e282d1e825d663b93bfd56c48dce1884bb10fccea063929f746443f' +
    'd830a4232e53da21a1f2d1bdfebc3a02c10a1b8ad31d04fd616590d272ac737e98eb33af60528716bee78ec0ee8699031177277d9cff32542c67caf5f4459168' +
    '1335ae0e178f3409a7803db83892dde5b9b7f0c750e24aef077badd678a09b850b84ec1597e4963cb5e675df1c0d6fb618496ecd76c35c798325590c2fb27a5e', 'hex');

// VendorConstants.kt hashTable (shared by v3 and v5 hashF13).
const HASH_TABLE = [
    0xebb64faf,0x7aadcc2,0xcf3187bf,0xe01138ff,0x6d0bfcff,0x5a30a3be,0xb41ad638,0x34180eb8,
    0xf233eb6f,0xb1a584cc,0xccc30dc7,0x47d1db51,0xd55653de,0x70a84fa1,0x57473c12,0xf76f0288,
    0x2c077f0a,0xda0dcad0,0xfbb86f6c,0xfdc4cf00,0x688a020d,0xe676c6a6,0x8cd6338b,0x1a3c8d0e,
    0xcce8b06b,0x6ad0ed0b,0xa0522717,0xdc71ac83,0x2285db71,0xd5b4dda6,0x736f8650,0x6560306c,
    0x617ce2a6,0xe423417e,0xa40e143,0x544e4032,0x88dffb2a,0x716c1ae0,0x4c467a88,0x5b23bb3,
    0xe1d0b866,0xbaa3dcb8,0xae3374d3,0xc3381a50,0x1702f75b,0xfe6da368,0xf0b4cf48,0x4e0ffbb8,
    0x72aad10d,0x26c53a3d,0xf2bce0f6,0xb4557581,0x4a257fdd,0x8c3182a2,0xab0b3b86,0x3d5dfb14,
    0x4f103634,0xd37b52d7,0x444eff16,0xeb0a33d1,0x6ca86f6e,0x284ba7,0x8387cfa,0x5fb37586,
];

// ---------- hashF13 v5 (Signer.kt hashF13, mobileV5 branch) ----------
// query: sm3(encoded query string), body: md5(gzip body), ts: khronos seconds.
function ivOf(query, body, ts) {
    return getIv(getIv(getIv(0x20230928, query), body), le32(ts));
}
function branchV5(queryString, body, ts) {
    const query = sm3(Buffer.from(queryString));
    const digest = body ? md5(body) : Buffer.alloc(16);
    const low = ivOf(query, digest, ts) & 15;
    return low === 12 ? 0 : 1;
}
function hashF13V5(query, body, ts) {
    const low = ivOf(query, body, ts) & 15;
    if (low !== 12) throw new Error(`v5 hash branch unsupported: ${low}`);
    const ivV1 = 0x9d4a97c2;
    const count = u32(ivV1 + ts);
    const tt = HASH_TABLE.map(value => ror32(value, count + 1));
    const shift = (count + 2) & 7;
    const pad = Buffer.from([0xfa, 0x45, 0x61, 0xd7].map(value => ((value | (value << 8)) >> shift) & 255));
    const data = Buffer.concat([query, body, le32(ts), pad, Buffer.from('00000000000001a0', 'hex')]);
    const di = [];
    for (let i = 0; i < data.length; i += 4) di.push(data.readUInt32BE(i));
    let di0 = di[0];
    for (let i = 0; i < 112; i += 1) {
        const x = di[i + 1];
        const y = di[i + 14];
        const r1 = rol32(x, 14) ^ rol32(x, 25) ^ (x >>> 3);
        const r2 = rol32(y, 13) ^ rol32(y, 15) ^ (y >>> 10);
        di.push(u32(di0 + di[i + 9] + r1 + r2));
        di0 = x;
    }
    const initial = [0x7aba4fc8,0x67166507,0x6403fa00,0x340f512f,984304912,3005047866,2874125293,2152413264]
        .map(value => ror32(value, count));
    const chosen = [96,1,3,4,0,6,5,2,0,7,7];
    const d = initial.slice();
    for (let i = 0; i < chosen[0]; i += 1) {
        const base = (ivV1 + i) >>> 0;
        const n1 = ((d[chosen[3]] ^ d[chosen[4]]) & d[chosen[1]]) ^ d[chosen[3]];
        const n2 = rol32(d[chosen[1]], 26) ^ rol32(d[chosen[1]], 21) ^ rol32(d[chosen[1]], 7);
        const n4 = u32(di[base & 127] + n1 + n2 + tt[base & 63] + d[chosen[5]]);
        const n5 = rol32(d[chosen[2]], 30) ^ rol32(d[chosen[2]], 19) ^ rol32(d[chosen[2]], 10);
        const n6 = (d[chosen[2]] & d[chosen[6]]) | ((d[chosen[2]] | d[chosen[6]]) & d[chosen[7]]);
        const old = d[chosen[9]];
        d.unshift(d.pop());
        d[chosen[10]] = u32(n5 + n6 + n4);
        d[chosen[8]] = u32(old + n4);
    }
    const ret = Buffer.alloc(32);
    for (let i = 0; i < 8; i += 1) ret.writeUInt32BE(u32(d[i] + initial[i]), i * 4);
    const folded = bxor(ret.subarray(0, 16), ret.subarray(16, 32));
    const check = sumMd5(folded) | 0x20;
    return Buffer.concat([folded, le32(check)]);
}

// ---------- AesV3 v5 (AesV3.kt, v5=true) ----------
function matrix(bytes) { return Array.from({ length: 4 }, (_v, i) => Array.from(bytes.subarray(i * 4, i * 4 + 4))); }
function flat(rows) { return Buffer.from(rows.flat()); }
function aesMix(rows) {
    for (let i = 0; i < 4; i += 1) {
        const t = rows[0][i] ^ rows[1][i] ^ rows[2][i] ^ rows[3][i];
        const u = rows[0][i];
        const xt = x => ((x << 1) ^ ((x & 128) ? 0x1b : 0)) & 255;
        rows[0][i] = u32(rows[0][i] ^ t ^ xt(rows[0][i] ^ rows[1][i]));
        rows[1][i] = u32(rows[1][i] ^ t ^ xt(rows[1][i] ^ rows[2][i]));
        rows[2][i] = u32(rows[2][i] ^ t ^ xt(rows[2][i] ^ rows[3][i]));
        rows[3][i] = u32(rows[3][i] ^ t ^ xt(rows[3][i] ^ u));
    }
}
class AesV3V5 {
    constructor(key, khronos) {
        const word = khronos & 3;
        this.box = V5_SBOX.subarray(word * 256, (word + 1) * 256);
        this.con = [
            [2,0,3,1],[1,3,2,0],[3,2,1,0],[2,3,1,0],
        ][word];
        this.order = [
            [0,9,14,15,4,13,2,7,8,1,6,3,12,5,10,11],
            [0,9,14,11,4,13,2,3,8,1,6,15,12,5,10,7],
            [0,9,14,3,4,13,2,15,8,1,6,11,12,5,10,7],
            [0,9,14,15,4,13,2,3,8,1,6,11,12,5,10,7],
        ][word];
        const init = [0xbbb5de72,0xd4638d5b,0x92a5f73b,0x89f8a1c9][word];
        const initial = Buffer.alloc(16);
        for (let i = 0; i < 4; i += 1) initial.writeUInt32LE(init, i * 4);
        const expanded = Buffer.concat([xorBytes(initial, key), Buffer.alloc(32)]);
        let rounds = 8;
        for (let i = 4; i < 12; i += 1) {
            const at = 4 * (i - 1);
            let a = expanded[at], b = expanded[at + 1], c = expanded[at + 2], d = expanded[at + 3];
            if ((i & 3) === 0) {
                const t = (u32(init >> (rounds & 24)) ^ this.box[b]) & 255;
                b = this.box[c]; c = this.box[d]; d = this.box[a]; a = t;
            }
            rounds += 2;
            expanded[at + 4] = a ^ expanded[at - 12];
            expanded[at + 5] = b ^ expanded[at - 11];
            expanded[at + 6] = c ^ expanded[at - 10];
            expanded[at + 7] = d ^ expanded[at - 9];
        }
        this.keys = Array.from({ length: 12 }, (_v, i) => Array.from(expanded.subarray(i * 4, i * 4 + 4)));
    }
    addCon(rows, keys) { for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) rows[i][j] ^= keys[i][this.con[j]]; }
    sub(rows) {
        for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) rows[i][j] = this.box[rows[i][j]];
        const before = rows.map(row => row.slice());
        for (let i = 0; i < 4; i += 1) rows[i] = before[this.con[i]].slice();
    }
    shift(rows) { const b = flat(rows); for (let i = 0; i < 16; i += 1) rows[Math.floor(i / 4)][i % 4] = b[this.order[i]]; }
    shiftCon(rows) { const old = rows.map(row => row.slice()); for (let i = 0; i < 4; i += 1) rows[i] = this.con.map(j => old[i][j]); }
    block(value) {
        const rows = matrix(value);
        this.addCon(rows, this.keys.slice(0, 4));
        for (let round = 1; round < 3; round += 1) {
            this.sub(rows);
            this.shift(rows);
            if (round === 1) { this.shiftCon(rows); aesMix(rows); }
            this.addCon(rows, this.keys.slice(round * 4));
        }
        for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) rows[i][j] ^= this.keys[4 + i][j];
        return flat(rows);
    }
    encrypt(source, iv) {
        if (source.length < 248) throw new Error('v5 AesV3 source too short');
        const wire = [6,5,3,4,2,7,1,0];
        const compact = [1,7,3,6,2,0,4,5];
        const plaintext = Buffer.alloc(32);
        for (let i = 0; i < 31; i += 1) for (let j = 0; j < 8; j += 1) {
            plaintext[i] |= ((source[i * 8 + j] >>> wire[j]) & 1) << compact[j];
        }
        plaintext[31] = 1;
        const first = this.block(xorBytes(plaintext.subarray(0, 16), iv));
        const key = Buffer.concat([first, this.block(xorBytes(plaintext.subarray(16, 32), first))]);
        const out = Buffer.from(source);
        for (let i = 0; i < 31; i += 1) for (let j = 0; j < 8; j += 1) {
            const at = i * 8 + j;
            out[at] = (out[at] & ~(1 << wire[j]) | (((key[i] >>> compact[j]) & 1) << wire[j])) & 255;
        }
        return Buffer.concat([Buffer.from([key[key.length - 1]]), out]);
    }
}

// ---------- medusa v5 (Signer.kt medusaV5) ----------
function rand() { return Math.floor(Math.random() * 0x100000000); }
function xmxor(data, key) {
    const encoded = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += 1) {
        const at = (i * 4) & 28;
        const d0 = key[at], d1 = key[at + 1];
        let d2 = ((((data[i] << 4) | (data[i] >>> 4)) & 255) + d0);
        d2 = (~d2) ^ d1;
        d2 = (((d2 & 255) << 3) | ((d2 & 255) >>> 5)) & 255;
        d2 = (d2 + d1) & 255;
        d2 = (d2 ^ d0) & 255;
        encoded[data.length - i - 1] = (~d2) & 255;
    }
    let last = encoded[encoded.length - 1] ^ encoded[encoded.length - 2];
    const first = encoded[0];
    encoded[0] = ((~last) + first) & 255;
    encoded[1] = ((encoded[0] ^ encoded[encoded.length - 1] ^ 254) + encoded[1]) & 255;
    encoded[2] = (encoded[2] + ((last - first) ^ (((encoded[1] << 3) | (encoded[1] >>> 5)) & 255) ^ 2)) & 255;
    for (let i = 0; i < encoded.length - 4; i += 1) {
        const temp = (((encoded[i + 2] << 3) | (encoded[i + 2] >>> 5)) & 255) ^ encoded[i + 1] ^ (i + 3);
        encoded[i + 3] = ((~temp) + encoded[i + 3]) & 255;
    }
    encoded[encoded.length - 1] ^= encoded[encoded.length - 2];
    let sum = 0;
    for (let i = 0; i < encoded.length - 1; i += 1) sum += encoded[i + 1];
    encoded[0] = ((encoded[0] ^ encoded[1]) + sum) & 255;
    return encoded;
}
function keyHash(signKey, random) {
    const hash = sm3(Buffer.concat([signKey, le32(random), signKey]));
    const d1 = (random >> 16) & 255;
    let d2 = (((d1 << 11) | (random >>> 24)) ^ (d1 >>> 5) ^ d1);
    d2 = (~d2) >>> 0;
    return [hash, le32(d2)];
}

const PROCESS_NONCE = crypto.randomBytes(18).toString('base64url');
const PROCESS_STARTED = Date.now();

function medusaV5(queryString, body, ts, values) {
    const query = sm3(Buffer.from(queryString, 'utf8'));
    const f13 = hashF13V5(query, body ? md5(body) : Buffer.alloc(16), ts);
    const flags = Buffer.alloc(8);
    const version = values.version_name;
    const deviceInfo = proto([
        [1,1,'sint'],[2,2,'sint'],[3,'8662'],[4,values.device_id],[5,PROCESS_NONCE],
        [6,'!noperm!'],[12,'Asia/Shanghai,8'],[13,'zh_CN'],
        [22,values.os_version],[25,PROCESS_STARTED,'sint'],
        [30,values.device_type],[31,'HONOR'],[32,values.device_type],[34,'HONOR'],
    ]);
    const env = proto([
        [6,'v04.10.03.04-bugfix'],[8,values.channel],[12,deviceInfo,'message'],[14,version],
    ]);
    const message = proto([
        [1,V5_MAGIC,'bytes'],[2,5,'sint'],[3,u32(rand()),'sint'],[4,'8662'],
        [5,values.device_id],[6,V5_LICENSE],[7,version],[8,'v04.10.03-ml-android'],
        [9,0x040a0300,'sint'],[10,flags,'bytes'],[12,ts,'sint'],[13,f13,'bytes'],
        [14,query.subarray(0,6),'bytes'],
        [15,proto([[1,1,'sint'],[2,1,'sint'],[3,1,'sint'],[5,1,'sint']]),'message'],
        [17,ts,'sint'],[20,'none'],[21,377,'sint'],[23,env,'message'],
        [24,'{"cmr":16777216,"cmr2":16777216,"un_h":11,"vpn":0,"kd":0,"dyn":"","do":1,"tk":true}'],
    ]);
    const nonce = rand();
    const [hash, seed] = keyHash(V5_SIGN_KEY, nonce);
    let transformed = Buffer.concat([flags, xmxor(message, hash)]).reverse();
    for (let i = 0; i < transformed.length; i += 1) transformed[i] ^= seed[(~i) & 3];
    const check = u32(0x18000001 | ((query[0] & 63) << 14) | ((f13[0] & 63) << 8));
    const packed = Buffer.concat([
        Buffer.from([0xca]), le32(rand()), le32(check), transformed,
        Buffer.from([(nonce >>> 16) & 255, (nonce >>> 24) & 255]),
    ]);
    const encrypted = new AesV3V5(md5(V5_SIGN_KEY.subarray(0, 16)), ts)
        .encrypt(packed, md5(V5_SIGN_KEY.subarray(16, 32)));
    const prefix = Buffer.concat([le32(5), V5_MAGIC]);
    const tsBytes = le32(ts);
    for (let i = 0; i < prefix.length; i += 1) prefix[i] ^= tsBytes[i & 3];
    return Buffer.concat([
        prefix,
        Buffer.from([nonce & 255, (nonce >>> 8) & 255, 0, 1]),
        encrypted,
    ]).toString('base64');
}

// ---------- helios v5 (Signer.kt helios, mobileV5 license) ----------
function ror64(value, count) { const n = BigInt(count) & 63n; const x = BigInt.asUintN(64, BigInt(value)); return BigInt.asUintN(64, (x >> n) | (x << (64n - n))); }
function heliosV5(ts) {
    const random = rand();
    const digestText = md5(Buffer.concat([le32(random), Buffer.from('8662')])).toString('hex');
    const ascii = Buffer.from(digestText, 'ascii');
    const words = [];
    for (let i = 0; i < 4; i += 1) words.push(ascii.readBigUInt64LE(i * 8));
    const table = [words[0]];
    let b0 = words[0], b8 = words[1];
    words.splice(0, 2);
    for (let i = 0; i < 34; i += 1) {
        let x8 = BigInt.asUintN(64, ror64(b8, 8) + b0);
        x8 = BigInt.asUintN(64, x8 ^ BigInt(i));
        words.push(x8);
        x8 = BigInt.asUintN(64, x8 ^ ror64(b0, 61));
        table.push(x8);
        b0 = x8;
        b8 = words.shift();
    }
    const text = Buffer.from(`${ts}-${V5_LICENSE}-8662`);
    const pad = Buffer.alloc(Math.ceil((text.length + 1) / 16) * 16, 16 - (text.length % 16));
    text.copy(pad);
    const output = [];
    for (let at = 0; at < pad.length; at += 16) {
        let a = pad.readBigUInt64LE(at), b = pad.readBigUInt64LE(at + 8);
        for (let i = 0; i < 34; i += 1) {
            b = BigInt.asUintN(64, table[i] ^ BigInt.asUintN(64, a + ror64(b, 8)));
            a = BigInt.asUintN(64, b ^ ror64(a, 61));
        }
        const block = Buffer.alloc(16);
        block.writeBigUInt64LE(a); block.writeBigUInt64LE(b, 8);
        output.push(block);
    }
    return Buffer.concat([le32(random), ...output]).toString('base64');
}

// ---------- query encoding (Signer.kt encode): Java URLEncoder semantics ----------
function encodeValue(value) {
    return encodeURIComponent(String(value == null ? '' : value))
        .replace(/[!'()]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
        .replace(/%7E/g, '~');
}
function encodeValues(values) {
    return Object.entries(values).map(([k, v]) => `${encodeValue(k)}=${encodeValue(v)}`).join('&');
}

// ---------- public: sign a v5 playback request ----------
// base: endpoint without query. values: fixed v5 query params incl. _rticket base.
// body: gzip buffer. now: clock ms (default Date.now()).
// returns { url, headers } where headers only contain v5 signing + body headers.
function signPlaybackV5(base, values, body, now = Date.now()) {
    const ts = Math.floor(now / 1000);
    for (let offset = 0; offset < 1024; offset += 1) {
        const ticket = now + offset;
        const next = { ...values, _rticket: String(ticket) };
        const query = encodeValues(next);
        if (branchV5(query, body, ts) !== 0) continue;
        const url = `${base}?${query}`;
        const headers = {
            'x-khronos': String(ts),
            'x-helios': heliosV5(ts),
            'x-medusa': medusaV5(url.substring(base.length + 1), body, ts, next),
        };
        if (body) {
            headers['Content-Type'] = 'application/json; charset=utf-8';
            headers['x-ss-stub'] = upperHex(md5(body));
        }
        return { url, headers };
    }
    throw new Error('无法生成 v5 播放签名');
}

module.exports = {
    hashF13V5, branchV5, AesV3V5, medusaV5, heliosV5, signPlaybackV5, encodeValues,
    V5_MAGIC, V5_LICENSE, V5_SIGN_KEY, V5_SBOX, HASH_TABLE,
};
