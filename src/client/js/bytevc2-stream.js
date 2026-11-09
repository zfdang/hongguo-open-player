// SPDX-License-Identifier: GPL-3.0-only
// Feed fragmented MP4 into the browser while it is being transcoded.
(function (root) {
  const MIME = 'video/mp4; codecs="avc1.42c028, mp4a.40.2"';
  function supported() {
    return typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function' &&
      MediaSource.isTypeSupported(MIME) && typeof ReadableStream !== 'undefined';
  }
  function start(video, url, duration, onError) {
    const controller = new AbortController();
    const media = new MediaSource();
    const objectUrl = URL.createObjectURL(media);
    let stopped = false;
    let reader;
    function stop() {
      if (stopped) return;
      stopped = true;
      controller.abort();
      reader?.cancel().catch(() => {});
      URL.revokeObjectURL(objectUrl);
    }
    video.src = objectUrl;
    const ready = new Promise((resolve, reject) => {
      media.addEventListener('sourceopen', resolve, { once: true });
      controller.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    });
    (async () => {
      await ready;
      const source = media.addSourceBuffer(MIME);
      media.duration = duration;
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error('视频转换流不可用');
      reader = response.body.getReader();
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        await new Promise((resolve, reject) => {
          const cleanup = () => { source.removeEventListener('updateend', success); source.removeEventListener('error', failure); controller.signal.removeEventListener('abort', cancelled); };
          const success = () => { cleanup(); resolve(); };
          const failure = () => { cleanup(); reject(new Error('视频片段无法解码')); };
          const cancelled = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
          source.addEventListener('updateend', success, { once: true });
          source.addEventListener('error', failure, { once: true });
          controller.signal.addEventListener('abort', cancelled, { once: true });
          try { source.appendBuffer(value); } catch (error) { cleanup(); reject(error); }
        });
      }
      if (!stopped && media.readyState === 'open') media.endOfStream();
    })().catch(error => { if (!stopped) { stop(); onError(error); } });
    return { stop };
  }
  root.Bytevc2Stream = { supported, start };
})(typeof window !== 'undefined' ? window : globalThis);
