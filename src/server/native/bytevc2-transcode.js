// SPDX-License-Identifier: GPL-3.0-only
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { assertUnencryptedMp4 } = require('./hongguo');
const logger = require('../services/logger');

let cachedHevcDecoderBinary;
let cachedHevcDecoderSupport = false;

function supportsHevcDecoder() {
  const bin = binaryPath();
  if (cachedHevcDecoderBinary === bin) return cachedHevcDecoderSupport;
  cachedHevcDecoderBinary = bin;
  try {
    const res = spawnSync(bin, ['-hide_banner', '-decoders'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    cachedHevcDecoderSupport = res.status === 0 && /\bhevc\b/.test(res.stdout || '');
  } catch (_) {
    cachedHevcDecoderSupport = false;
  }
  return cachedHevcDecoderSupport;
}

function binaryPath() {
  if (process.env.HONGGUO_BVC2_FFMPEG) return process.env.HONGGUO_BVC2_FFMPEG;
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return process.resourcesPath
    ? path.join(process.resourcesPath, 'bytevc2', executable)
    : path.resolve(__dirname, '../../../build/bytevc2', process.arch, executable);
}

// 转码输出上限随片源时长缩放（crf25 ultrafast 实测约 0.7MB/s，留 3 倍余量），
// 最低 128MB、封顶 1GB，既容纳长集正常输出，也防异常片源失控转码撑爆磁盘
function transcodeLimitBytes(durationSec) {
  const base = 128 * 1024 * 1024;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return base;
  return Math.min(1024 * 1024 * 1024, Math.max(base, Math.ceil(durationSec * 2.2 * 1024 * 1024)));
}

async function transcodeBytevc2(buffer, key, signal, durationSec) {
  signal?.throwIfAborted();
  if (!Buffer.isBuffer(key) || ![0, 16].includes(key.length)) throw new Error('ByteVC2 片源密钥无效');
  if (!key.length) assertUnencryptedMp4(buffer);
  const limit = transcodeLimitBytes(durationSec);
  logger.info('ByteVC2', `开始完整转码: 输入=${buffer.length}字节, 时长=${Number.isFinite(durationSec) ? durationSec : '?'}s, 密钥=${key.length ? '有' : '无'}, 输出上限=${Math.round(limit / 1024 / 1024)}MB, ffmpeg=${binaryPath()}`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hongguo-bvc2-'));
  const input = path.join(dir, 'input.mp4');
  const output = path.join(dir, 'output.mp4');
  try {
    await fs.writeFile(input, buffer, { mode: 0o600, signal });
    await new Promise((resolve, reject) => {
      let settled = false;
      let errors = '';
      let stoppedReason;
      const done = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(sizeCheck);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const child = spawn(binaryPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin',
        ...(key.length ? ['-decryption_key', key.toString('hex')] : []),
        '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', output],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      const abort = () => child.kill();
      const timer = setTimeout(() => { stoppedReason = 'ByteVC2 视频转换超时'; child.kill(); }, 5 * 60 * 1000);
      timer.unref?.();
      const sizeCheck = setInterval(() => {
        fs.stat(output).then(stat => {
          if (stat.size >= limit && !settled) {
            stoppedReason = 'ByteVC2 视频转换结果过大';
            child.kill();
          }
        }).catch(() => {});
      }, 500);
      sizeCheck.unref?.();
      child.stderr.on('data', data => { if (errors.length < 4096) errors += data.toString().slice(0, 4096 - errors.length); });
      child.on('error', error => {
        logger.error('ByteVC2', `转码器不可用（无法启动 ffmpeg）: ${binaryPath()}`, { code: 'BYTEVC2_TRANSCODER_UNAVAILABLE', error: error.message });
        done(Object.assign(new Error('ByteVC2 转码器不可用，请重新安装播放器'), { code: 'BYTEVC2_TRANSCODER_UNAVAILABLE', cause: error }));
      });
      child.on('close', code => {
        if (signal?.aborted) return done(signal.reason || new Error('播放已取消'));
        if (stoppedReason) {
          logger.error('ByteVC2', `完整转码中止: ${stoppedReason}`, { code: 'BYTEVC2_TRANSCODE_FAILED' });
          return done(Object.assign(new Error(stoppedReason), { code: 'BYTEVC2_TRANSCODE_FAILED' }));
        }
        if (code !== 0) {
          logger.error('ByteVC2', `完整转码失败: ffmpeg 退出码=${code}`, { code: 'BYTEVC2_TRANSCODE_FAILED', ffmpeg_stderr: errors.slice(0, 2000) });
          return done(Object.assign(new Error('ByteVC2 视频转换失败'), { code: 'BYTEVC2_TRANSCODE_FAILED', detail: errors }));
        }
        done();
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    const stat = await fs.stat(output);
    if (!stat.size || stat.size >= limit) throw new Error('ByteVC2 视频转换结果过大或为空');
    return await fs.readFile(output, { signal });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function* streamBytevc2(buffer, key, signal, durationSec) {
  signal?.throwIfAborted();
  if (!Buffer.isBuffer(key) || ![0, 16].includes(key.length)) throw new Error('ByteVC2 片源密钥无效');
  if (!key.length) assertUnencryptedMp4(buffer);
  const limit = transcodeLimitBytes(durationSec);
  logger.info('ByteVC2', `开始渐进转码(MSE): 输入=${buffer.length}字节, 时长=${Number.isFinite(durationSec) ? durationSec : '?'}s, 密钥=${key.length ? '有' : '无'}, ffmpeg=${binaryPath()}`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hongguo-bvc2-stream-'));
  let child;
  let completion;
  let timer;
  let abort;
  try {
    const input = path.join(dir, 'input.mp4');
    await fs.writeFile(input, buffer, { mode: 0o600, signal });
    child = spawn(binaryPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin',
      ...(key.length ? ['-decryption_key', key.toString('hex')] : []),
      '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25',
      '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', data => { if (errors.length < 4096) errors += data.toString().slice(0, 4096 - errors.length); });
    completion = new Promise(resolve => {
      child.once('error', error => resolve({ error }));
      child.once('close', code => resolve({ code }));
    });
    abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(abort, 5 * 60 * 1000);
    timer.unref?.();
    let size = 0;
    for await (const chunk of child.stdout) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > limit) throw new Error('ByteVC2 视频转换结果过大');
      yield chunk;
    }
    const result = await completion;
    signal?.throwIfAborted();
    if (result.error || result.code !== 0 || !size) {
      logger.error('ByteVC2', `渐进转码失败: 退出码=${result.code ?? '?'}, 输出=${size}字节, 启动错误=${result.error?.message || '无'}`, { code: 'BYTEVC2_TRANSCODE_FAILED', ffmpeg_stderr: errors.slice(0, 2000) });
      throw Object.assign(new Error('ByteVC2 视频转换失败'), { code: 'BYTEVC2_TRANSCODE_FAILED', detail: errors });
    }
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    if (child) { child.kill(); await completion; }
    await fs.rm(dir, { recursive: true, force: true });
  }
}
module.exports = { binaryPath, supportsHevcDecoder, transcodeBytevc2, streamBytevc2 };
