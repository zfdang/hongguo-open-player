// SPDX-License-Identifier: GPL-3.0-only
const axios = require('axios');
const crypto = require('node:crypto');
const { createMp4StreamingPlan } = require('../native/hongguo');
const logger = require('./logger');

async function prepareRangeMedia(variant, requestOptions, signal) {
  const headers = { 'Accept-Encoding': 'identity', ...(variant.userAgent ? { 'User-Agent': variant.userAgent } : {}) };
  const options = { ...requestOptions(variant.url), maxRedirects: 0, headers, signal,
    timeout: 15000, responseType: 'arraybuffer', maxContentLength: 4 * 1024 * 1024 };
  let total;
  let prefix;
  async function read(start, end) {
    signal?.throwIfAborted();
    if (prefix && end < prefix.length) return prefix.subarray(start, end + 1);
    const response = await axios.get(variant.url, { ...options, headers: { ...headers, Range: `bytes=${start}-${end}` } });
    if (response.status === 200) throw Object.assign(new Error('CDN does not support byte ranges'), { code: 'RANGE_UNSUPPORTED' });
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
    if (response.status !== 206 || !match || Number(match[1]) !== start || Number(match[2]) !== end ||
        (total && Number(match[3]) !== total) || response.data.length !== end - start + 1) throw new Error('Invalid CDN range response');
    total ||= Number(match[3]);
    if (!Number.isSafeInteger(total) || total < 8 || total > 1024 * 1024 * 1024) throw new Error('MP4 size exceeds supported range');
    return response.data;
  }
  // A bounded first window combines the size probe with common front-loaded metadata.
  const probe = await axios.get(variant.url, { ...options, responseType: 'stream', headers: { ...headers, Range: 'bytes=0-65535' } });
  probe.data.on('error', () => {});
  if (probe.status !== 206) {
    probe.data.destroy();
    throw Object.assign(new Error('CDN does not support byte ranges'), { code: 'RANGE_UNSUPPORTED' });
  }
  const probeRange = /^bytes 0-(\d+)\/(\d+)$/.exec(probe.headers['content-range'] || '');
  if (!probeRange) { probe.data.destroy(); throw new Error('Invalid CDN size probe'); }
  const probeEnd = Number(probeRange[1]);
  total = Number(probeRange[2]);
  if (!Number.isSafeInteger(total) || total < 8 || total > 1024 * 1024 * 1024 ||
      probeEnd !== Math.min(total - 1, 65535)) {
    probe.data.destroy();
    throw new Error('Invalid CDN size probe');
  }
  const chunks = [];
  let prefixSize = 0;
  for await (const chunk of probe.data) {
    signal?.throwIfAborted();
    prefixSize += chunk.length;
    if (prefixSize > probeEnd + 1) { probe.data.destroy(); throw new Error('Invalid CDN range response'); }
    chunks.push(chunk);
  }
  if (prefixSize !== probeEnd + 1) throw new Error('Invalid CDN range response');
  prefix = Buffer.concat(chunks, prefixSize);
  const boxes = [];
  let metadata;
  for (let offset = 0; offset < total;) {
    if (boxes.length >= 128) throw new Error('Too many MP4 boxes');
    const header = await read(offset, Math.min(offset + 15, total - 1));
    let size = header.readUInt32BE(0);
    const minimum = size === 1 ? 16 : 8;
    if (size === 1) {
      if (header.length < 16) throw new Error('Truncated extended MP4 header');
      size = Number(header.readBigUInt64BE(8));
    } else if (size === 0) size = total - offset;
    if (!Number.isSafeInteger(size) || size < minimum || offset + size > total) throw new Error('Invalid remote MP4 box');
    const typ = header.toString('latin1', 4, 8);
    boxes.push({ off: offset, size, typ });
    if (typ === 'moov') {
      if (metadata || size > 4 * 1024 * 1024) throw new Error('Unsupported MP4 metadata');
      metadata = await read(offset, offset + size - 1);
    }
    offset += size;
  }
  if (!metadata) throw new Error('MP4 metadata is missing');
  const plan = createMp4StreamingPlan(metadata, boxes, total);
  const key = Buffer.isBuffer(variant.contentKey) ? variant.contentKey : Buffer.from(variant.contentKey || '', 'hex');
  if (plan.samples.length && key.length !== 16) throw new Error('Invalid CENC key');
  logger.info('RangeMedia', `MP4 CENC元数据解析完成: 总大小=${total} 字节, Boxes=[${boxes.map(b => b.typ).join(',')}], moov大小=${metadata.length} 字节, CENC加密样本数=${plan.samples.length}`);
  // The metadata request signal belongs to a single acquisition. Each response
  // receives its own cancellation signal, so cached plans outlive closed requests.
  return { size: plan.size, bytes: prefix.length + metadata.length * 2 + plan.samples.length * 160 + plan.segments.length * 64, async *read(start, end, responseSignal) {
    for (const segment of plan.segments) {
      responseSignal?.throwIfAborted();
      const from = Math.max(start, segment.start), to = Math.min(end, segment.start + segment.size - 1);
      if (from > to) continue;
      if (segment.buffer) { yield segment.buffer.subarray(from - segment.start, to - segment.start + 1); continue; }
      for (let position = from; position <= to;) {
        responseSignal?.throwIfAborted();
        const length = Math.min(512 * 1024, to - position + 1);
        const remote = segment.remote + position - segment.start;
        const response = await axios.get(variant.url, { ...options, signal: responseSignal,
          headers: { ...headers, Range: `bytes=${remote}-${remote + length - 1}` } });
        if (response.status !== 206 || response.headers['content-range'] !== `bytes ${remote}-${remote + length - 1}/${total}` || response.data.length !== length) throw new Error('Invalid streaming media range');
        const data = response.data;
        let lo = 0, hi = plan.samples.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (plan.samples[mid].offset + plan.samples[mid].size <= remote) lo = mid + 1;
          else hi = mid;
        }
        for (let i = lo; i < plan.samples.length && plan.samples[i].offset < remote + length; i++) {
          const sample = plan.samples[i];
          const begin = Math.max(remote, sample.offset), finish = Math.min(remote + length, sample.offset + sample.size);
          if (begin >= finish) continue;
          const withinSample = begin - sample.offset;
          const iv = Buffer.alloc(16); sample.iv.copy(iv);
          iv.writeBigUInt64BE(BigInt(Math.floor(withinSample / 16)), 8);
          const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);
          // Discard the partial block's keystream before the requested ciphertext.
          if (withinSample % 16) decipher.update(Buffer.alloc(withinSample % 16));
          const plain = decipher.update(data.subarray(begin - remote, finish - remote));
          decipher.final();
          plain.copy(data, begin - remote);
        }
        yield data;
        position += length;
      }
    }
  } };
}
module.exports = { prepareRangeMedia };
