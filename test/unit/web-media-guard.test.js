const { test } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');
const {
  isPublicMediaUrl,
  isTrustedMediaDomain,
  isFakeIpAddress,
  isPermittedAddress,
  webMediaRequestOptions
} = require('../../src/server/native/web-media-guard');

test('isPublicMediaUrl validates valid public URLs and rejects invalid/private URLs', () => {
  assert.equal(isPublicMediaUrl('https://v9-reading-video.fqnovel.com/video/test.mp4'), true);
  assert.equal(isPublicMediaUrl('https://hongguoduanju.com/drama'), true);
  assert.equal(isPublicMediaUrl('https://douyinvod.com/stream.mp4'), true);

  assert.equal(isPublicMediaUrl('http://127.0.0.1/video.mp4'), false);
  assert.equal(isPublicMediaUrl('http://localhost:8899/video.mp4'), false);
  assert.equal(isPublicMediaUrl('http://192.168.1.1/video.mp4'), false);
  assert.equal(isPublicMediaUrl('http://10.0.0.1/video.mp4'), false);
  assert.equal(isPublicMediaUrl('ftp://v9-reading-video.fqnovel.com/video.mp4'), false);
});

test('isTrustedMediaDomain identifies official Hongguo and ByteDance CDN domains', () => {
  assert.equal(isTrustedMediaDomain('hongguoduanju.com'), true);
  assert.equal(isTrustedMediaDomain('web.hongguoduanju.com'), true);
  assert.equal(isTrustedMediaDomain('fqnovel.com'), true);
  assert.equal(isTrustedMediaDomain('v9-reading-video.fqnovel.com'), true);
  assert.equal(isTrustedMediaDomain('api5-normal-sinfonlineb.fqnovel.com'), true);
  assert.equal(isTrustedMediaDomain('douyinvod.com'), true);
  assert.equal(isTrustedMediaDomain('v3-dy-y.douyinvod.com'), true);
  assert.equal(isTrustedMediaDomain('qznovelvod.com'), true);
  assert.equal(isTrustedMediaDomain('fqnovelvod.com'), true);
  assert.equal(isTrustedMediaDomain('bytecdn.cn'), true);
  assert.equal(isTrustedMediaDomain('byteimg.com'), true);
  assert.equal(isTrustedMediaDomain('snssdk.com'), true);

  assert.equal(isTrustedMediaDomain('evil.com'), false);
  assert.equal(isTrustedMediaDomain('fakefqnovel.com'), false);
  assert.equal(isTrustedMediaDomain('fqnovel.com.attacker.com'), false);
  assert.equal(isTrustedMediaDomain('localhost'), false);
});

test('isFakeIpAddress detects RFC 2544 / standard Fake-IP (198.18.0.0/15) ranges', () => {
  assert.equal(isFakeIpAddress('198.18.0.1'), true);
  assert.equal(isFakeIpAddress('198.19.255.254'), true);
  assert.equal(isFakeIpAddress('198.18.123.45'), true);

  assert.equal(isFakeIpAddress('198.20.0.1'), false);
  assert.equal(isFakeIpAddress('192.168.1.1'), false);
  assert.equal(isFakeIpAddress('10.0.0.1'), false);
  assert.equal(isFakeIpAddress('127.0.0.1'), false);
});

test('isPermittedAddress permits public IPs, standard Fake-IPs, and custom Fake-IPs for trusted media domains', () => {
  // Public IP
  assert.equal(isPermittedAddress({ address: '120.232.1.2', family: 4 }, 'v9-reading-video.fqnovel.com'), true);
  assert.equal(isPermittedAddress({ address: '120.232.1.2', family: 4 }, 'untrusted.com'), true);

  // Standard Fake-IP (198.18.0.0/15)
  assert.equal(isPermittedAddress({ address: '198.18.0.1', family: 4 }, 'v9-reading-video.fqnovel.com'), true);
  assert.equal(isPermittedAddress({ address: '198.18.0.1', family: 4 }, 'untrusted-cdn.com'), true);

  // Custom Fake-IP pool (e.g. 10.254.x.x) on trusted media CDN
  assert.equal(isPermittedAddress({ address: '10.254.0.1', family: 4 }, 'v9-reading-video.fqnovel.com'), true);
  assert.equal(isPermittedAddress({ address: '172.19.0.1', family: 4 }, 'v3-dy-y.douyinvod.com'), true);

  // Custom Fake-IP / Private IP on untrusted domains must be rejected
  assert.equal(isPermittedAddress({ address: '10.254.0.1', family: 4 }, 'attacker.com'), false);
  assert.equal(isPermittedAddress({ address: '192.168.1.1', family: 4 }, 'attacker.com'), false);

  // Loopback must be rejected even on trusted domain
  assert.equal(isPermittedAddress({ address: '127.0.0.1', family: 4 }, 'v9-reading-video.fqnovel.com'), false);
  assert.equal(isPermittedAddress({ address: '::1', family: 6 }, 'v9-reading-video.fqnovel.com'), false);
});

test('webMediaRequestOptions lookup allows Fake-IP for media domains and rejects loopback/private rebinding', async () => {
  const originalLookup = dns.lookup;

  // 1. Standard Fake-IP on CDN domain
  try {
    dns.lookup = (hostname, options, callback) => {
      callback(null, [{ address: '198.18.0.1', family: 4 }]);
    };
    const cdnOptions = webMediaRequestOptions('https://v9-reading-video.fqnovel.com/video/sample.mp4');
    await new Promise((resolve, reject) => {
      cdnOptions.lookup('v9-reading-video.fqnovel.com', {}, (err, addr, family) => {
        if (err) return reject(err);
        assert.equal(addr, '198.18.0.1');
        assert.equal(family, 4);
        resolve();
      });
    });
  } finally {
    dns.lookup = originalLookup;
  }

  // 2. Custom Fake-IP on trusted CDN domain
  try {
    dns.lookup = (hostname, options, callback) => {
      callback(null, [{ address: '10.254.0.5', family: 4 }]);
    };
    const cdnOptions = webMediaRequestOptions('https://v3-dy-y.douyinvod.com/stream/sample.mp4');
    await new Promise((resolve, reject) => {
      cdnOptions.lookup('v3-dy-y.douyinvod.com', {}, (err, addr, family) => {
        if (err) return reject(err);
        assert.equal(addr, '10.254.0.5');
        assert.equal(family, 4);
        resolve();
      });
    });
  } finally {
    dns.lookup = originalLookup;
  }

  // 3. Private IP on untrusted domain must fail
  try {
    dns.lookup = (hostname, options, callback) => {
      callback(null, [{ address: '192.168.1.1', family: 4 }]);
    };
    const untrustedOptions = webMediaRequestOptions('https://untrusted-host.example.com/video.mp4');
    await new Promise((resolve, reject) => {
      untrustedOptions.lookup('untrusted-host.example.com', {}, (err) => {
        if (err) {
          assert.equal(err.code, 'ERR_WEB_MEDIA_ADDRESS');
          return resolve();
        }
        reject(new Error('Should have rejected private IP for untrusted host'));
      });
    });
  } finally {
    dns.lookup = originalLookup;
  }

  // 4. Loopback on trusted domain must fail
  try {
    dns.lookup = (hostname, options, callback) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    };
    const cdnOptions = webMediaRequestOptions('https://v9-reading-video.fqnovel.com/video/sample.mp4');
    await new Promise((resolve, reject) => {
      cdnOptions.lookup('v9-reading-video.fqnovel.com', {}, (err) => {
        if (err) {
          assert.equal(err.code, 'ERR_WEB_MEDIA_ADDRESS');
          return resolve();
        }
        reject(new Error('Should have rejected loopback for trusted domain'));
      });
    });
  } finally {
    dns.lookup = originalLookup;
  }
});
