// SPDX-License-Identifier: GPL-3.0-only
// 账号服务离线单测：全部使用假传输层，不访问网络。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const {
  createAccountService, CookieJar, parseApiJson, toMs, safeMessage, isWebHost, normalizeCover,
} = require('../../src/server/native/account');
const { signedAccountRequest } = require('../../src/server/native/app-source');

const IDENTITY = {
  device_id: '7398123456789012345',
  iid: '7398123456789012346',
  cdid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  cookie: 'store-region=cn; install_id=7398123456789012346',
};
const identityProvider = async () => IDENTITY;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hg-account-test-'));
const ok = data => ({ status: 200, headers: {}, data: typeof data === 'string' ? data : JSON.stringify(data) });
const md5Upper = value => crypto.createHash('md5').update(value).digest('hex').toUpperCase();

function webRouter(routes) {
  return async config => {
    const url = new URL(config.url);
    const handler = routes[url.pathname];
    if (!handler) throw new Error(`未预期的官网路径: ${url.pathname}`);
    return handler(url, config);
  };
}
function apiRouter(routes) {
  return async config => {
    const url = new URL(config.url);
    const handler = routes[url.pathname];
    if (!handler) throw new Error(`未预期的账号接口路径: ${url.pathname}`);
    return handler(url, config);
  };
}

const LOGIN_ROUTES = {
  '/passport/web/get_qrcode/': () => ok({ data: { token: 'tok-1', qrcode: 'aGVsbG8=', expire_time: 180 } }),
  '/passport/web/check_qrconnect/': () => ({
    status: 200,
    headers: {
      'set-cookie': [
        'sessionid=sess-abc; Path=/; Max-Age=3600',
        `sid_guard=${encodeURIComponent('sess-abc|1700000000|3600|x')}; Path=/`,
      ],
    },
    data: JSON.stringify({ data: { status: '3', redirect_url: 'https://hongguoduanju.com/passport/web/redirect/?token=x' } }),
  }),
  '/passport/web/redirect/': () => ok('ok'),
  '/passport/account/info/v2/': () => ok({ data: { user_id_str: '888777666', name: '测试果友' } }),
};

// ── 基础件 ──────────────────────────────────────────────────────────────────

test('CookieJar 吸收/过期/会话判定与 sid_guard 有效期', () => {
  let clock = 1_700_000_000_000;
  const jar = new CookieJar(() => clock);
  assert.equal(jar.hasSession(), false);
  jar.absorb(['sessionid=abc; Path=/; Max-Age=10', 'other=1; Path=/']);
  assert.equal(jar.hasSession(), true);
  assert.equal(jar.get('sessionid'), 'abc');
  clock += 11_000;
  assert.equal(jar.hasSession(), false); // Max-Age 到期即失效
  assert.equal(jar.get('other'), '1');
  jar.absorb(`sid_guard=${encodeURIComponent('abc|1700000000|3600|x')}; Path=/`);
  assert.equal(jar.sessionExpiresAt(), (1700000000 + 3600) * 1000);
  const snapshot = jar.snapshot();
  const restored = new CookieJar(() => clock);
  restored.restore(snapshot);
  // jar 保存原始值（可能 URL 编码），有效期解析时才解码
  assert.equal(restored.get('sid_guard'), encodeURIComponent('abc|1700000000|3600|x'));
  assert.equal(restored.sessionExpiresAt(), (1700000000 + 3600) * 1000);
  jar.absorb('sessionid=; Path=/; Max-Age=0');
  assert.equal(jar.get('sessionid'), '');
});

test('parseApiJson 保留 19 位大整数为字符串', () => {
  const raw = '{"code":0,"data":{"video_data":[{"series_id":7412345678901234567,"vid":7412345678901234568,"vid_index":3,"small":123}]}}';
  const parsed = parseApiJson(raw);
  const row = parsed.data.video_data[0];
  assert.equal(row.series_id, '7412345678901234567');
  assert.equal(row.vid, '7412345678901234568');
  assert.equal(row.vid_index, 3);
  assert.equal(row.small, 123);
});

test('toMs 秒/毫秒自适应与 safeMessage 脱敏', () => {
  assert.equal(toMs(1763000000), 1763000000000);
  assert.equal(toMs(1763000000000), 1763000000000);
  assert.equal(toMs('abc'), 0);
  assert.equal(toMs(-5), 0);
  const masked = safeMessage(new Error('请求 https://api5-normal.fqnovel.com/x?sessionid=SECRET&iid=1 失败 sid_tt=TOPSECRET'));
  assert.ok(!masked.includes('SECRET'));
  assert.ok(!masked.includes('TOPSECRET'));
  assert.ok(!masked.includes('fqnovel.com'));
  assert.equal(isWebHost('hongguoduanju.com'), true);
  assert.equal(isWebHost('passport.hongguoduanju.com'), true);
  assert.equal(isWebHost('evilhongguoduanju.com'), false);
  assert.equal(isWebHost('evil.com'), false);
});

// ── 账号签名 ────────────────────────────────────────────────────────────────

test('signedAccountRequest GET 用 72232 且无 body 头', () => {
  const signed = signedAccountRequest('/reading/user/info/v1/', { limit: '50' }, IDENTITY);
  assert.ok(signed.url.startsWith('https://api5-normal-sinfonlinea.fqnovel.com/reading/user/info/v1/?'));
  assert.ok(signed.url.includes('version_code=72232'));
  assert.ok(signed.url.includes('version_name=7.2.2.32'));
  assert.ok(signed.url.includes(`device_id=${IDENTITY.device_id}`));
  assert.equal(signed.body, null);
  for (const header of ['x-khronos', 'x-gorgon', 'x-ladon', 'x-argus', 'x-helios', 'x-medusa', 'x-ss-req-ticket']) {
    assert.ok(signed.headers[header], `缺少签名头 ${header}`);
  }
  assert.equal(signed.headers['x-ss-stub'], undefined);
});

test('signedAccountRequest 写请求用 73932 + gzip + x-ss-stub，原始 JSON 大整数不丢精度', () => {
  const raw = '{"item_id":7412345678901234567,"item_type":3,"op_type":1,"subscribe_source":0}';
  const signed = signedAccountRequest('/reading/bookapi/search/uncover_subscribe/v1/', {}, IDENTITY, { payload: raw, gzip: true });
  assert.ok(signed.url.includes('version_code=73932'));
  assert.ok(signed.url.includes('version_name=7.3.9.32'));
  assert.equal(signed.headers['Content-Encoding'], 'gzip');
  assert.equal(signed.headers['x-ss-stub'], md5Upper(signed.body));
  assert.equal(gunzipSync(signed.body).toString('utf8'), raw);
});

test('signedAccountRequest 拒绝白名单外路径与无效身份', () => {
  assert.throws(() => signedAccountRequest('/reading/evil/v1/', {}, IDENTITY));
  assert.throws(() => signedAccountRequest('/reading/user/info/v1/', {}, { device_id: '0', iid: '1', cdid: IDENTITY.cdid }));
  assert.throws(() => signedAccountRequest('/reading/user/info/v1/', {}, { ...IDENTITY, cdid: 'not-a-uuid' }));
});

// ── 扫码登录流程 ────────────────────────────────────────────────────────────

test('扫码登录：二维码 → 轮询确认 → 凭据落盘 → 状态与退出', async () => {
  const dir = tmpDir();
  let clock = 1_700_000_000_000;
  // 有状态的扫码确认：未扫 → 已扫 → 已确认（官网真实返回文字状态）
  let qrStatus = 'new';
  const routes = {
    ...LOGIN_ROUTES,
    '/passport/web/check_qrconnect/': () => ({
      status: 200,
      headers: qrStatus === 'confirmed' ? {
        'set-cookie': [
          'sessionid=sess-abc; Path=/; Max-Age=3600',
          `sid_guard=${encodeURIComponent('sess-abc|1700000000|3600|x')}; Path=/`,
        ],
      } : {},
      data: JSON.stringify({
        data: qrStatus === 'confirmed'
          ? { status: 'confirmed', redirect_url: 'https://hongguoduanju.com/passport/web/redirect/?token=x' }
          : { status: qrStatus },
      }),
    }),
  };
  const service = createAccountService({
    dataDir: dir, now: () => clock, identityProvider,
    webTransport: webRouter(routes),
    apiTransport: apiRouter({}),
  });
  assert.equal(service.status().logged_in, false);

  const qr = await service.startLogin();
  assert.equal(qr.success, true);
  assert.equal(qr.token, 'tok-1');
  assert.ok(qr.qrcode.startsWith('data:image/png;base64,'));
  assert.equal(qr.expire_at, clock + 180_000);

  const pending = await service.pollLogin('tok-1');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.scanned, false);

  qrStatus = 'scanned';
  const scanned = await service.pollLogin('tok-1');
  assert.equal(scanned.status, 'pending');
  assert.equal(scanned.scanned, true);

  // 模拟手机确认：check_qrconnect 返回 status=confirmed
  qrStatus = 'confirmed';
  const confirmed = await service.pollLogin('tok-1');
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.user.name, '测试果友');
  assert.equal(confirmed.user.user_id, '888777666');

  const status = service.status();
  assert.equal(status.logged_in, true);
  assert.equal(status.expires_at, (1700000000 + 3600) * 1000);
  const file = path.join(dir, 'account_session.json');
  assert.ok(fs.existsSync(file));
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(envelope.version, 1);
  assert.ok(envelope.data.includes('sess-abc'));

  // 新实例从磁盘恢复登录态
  const restored = createAccountService({ dataDir: dir, now: () => clock, identityProvider, webTransport: webRouter(LOGIN_ROUTES), apiTransport: apiRouter({}) });
  assert.equal(restored.status().logged_in, true);
  assert.equal(restored.status().user.name, '测试果友');

  const logout = restored.logout();
  assert.equal(logout.success, true);
  assert.equal(restored.status().logged_in, false);
  assert.ok(!fs.existsSync(file));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('扫码登录：二维码过期与错误 token', async () => {
  const dir = tmpDir();
  let clock = 1_700_000_000_000;
  const service = createAccountService({ dataDir: dir, now: () => clock, identityProvider, webTransport: webRouter(LOGIN_ROUTES), apiTransport: apiRouter({}) });
  await service.startLogin();
  const wrong = await service.pollLogin('bad-token');
  assert.equal(wrong.success, false);
  clock += 200_000;
  const expired = await service.pollLogin('tok-1');
  assert.equal(expired.status, 'expired');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('扫码登录：兼容数字状态与文字状态，canceled 视为过期', async () => {
  const dir = tmpDir();
  let qrStatus = '2'; // 数字"已扫码"
  const routes = {
    ...LOGIN_ROUTES,
    '/passport/web/check_qrconnect/': () => ok({ data: { status: qrStatus } }),
  };
  const service = createAccountService({ dataDir: dir, identityProvider, webTransport: webRouter(routes), apiTransport: apiRouter({}) });
  await service.startLogin();
  const scannedNumeric = await service.pollLogin('tok-1');
  assert.equal(scannedNumeric.status, 'pending');
  assert.equal(scannedNumeric.scanned, true); // 数字 2 也识别为已扫码
  qrStatus = 'canceled';
  const canceled = await service.pollLogin('tok-1');
  assert.equal(canceled.status, 'expired');
  assert.ok(canceled.notice.includes('取消'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('扫码登录：重定向到非白名单站点被拒绝且不污染登录态', async () => {
  const dir = tmpDir();
  const routes = {
    ...LOGIN_ROUTES,
    '/passport/web/check_qrconnect/': () => ({
      status: 200,
      headers: { 'set-cookie': ['sessionid=evil-sess; Path=/'] },
      data: JSON.stringify({ data: { status: '3', redirect_url: 'https://evil.com/steal' } }),
    }),
  };
  const service = createAccountService({ dataDir: dir, identityProvider, webTransport: webRouter(routes), apiTransport: apiRouter({}) });
  await service.startLogin();
  const result = await service.pollLogin('tok-1');
  assert.equal(result.success, false);
  assert.equal(service.status().logged_in, false);
  assert.ok(!fs.existsSync(path.join(dir, 'account_session.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 云端记录 ────────────────────────────────────────────────────────────────

function loggedInService(dir, apiRoutes, extra = {}) {
  const service = createAccountService({
    dataDir: dir, identityProvider,
    webTransport: webRouter(LOGIN_ROUTES),
    apiTransport: apiRouter(apiRoutes),
    ...extra,
  });
  service._jar.restore({ sessionid: 'sess-abc', sid_guard: 'sess-abc|1700000000|3600|x' });
  return service;
}

test('未登录时记录接口返回 need_login', async () => {
  const dir = tmpDir();
  const service = createAccountService({ dataDir: dir, identityProvider, webTransport: webRouter(LOGIN_ROUTES), apiTransport: apiRouter({}) });
  for (const method of ['history', 'likes', 'favorites', 'reserves']) {
    const result = await service[method]();
    assert.equal(result.success, false);
    assert.equal(result.need_login, true);
  }
  const reserve = await service.reserve('7412345678901234567');
  assert.equal(reserve.need_login, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('播放记录：read_progress 主路径 + 大整数 + 秒转毫秒', async () => {
  const dir = tmpDir();
  const raw = '{"code":0,"data":{"video_data":[{"series_id":7412345678901234567,"vid":7412345678901234568,"vid_index":3,"episode_count":80,"current_play_time":65000,"current_total_time":120000,"last_watch_time":1763000000,"series_title":"测试短剧","series_cover_url":"https://img.example/cover.jpg"}]}}';
  const service = loggedInService(dir, { '/reading/bookapi/read_progress/list/v1/': () => ok(raw) });
  const result = await service.history();
  assert.equal(result.success, true);
  assert.equal(result.source, 'read_progress');
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.series_id, '7412345678901234567');
  assert.equal(item.vid, '7412345678901234568');
  assert.equal(item.episode_index, 3);
  assert.equal(item.position_ms, 65000);
  assert.equal(item.duration_ms, 120000);
  assert.equal(item.watched_at, 1763000000000);
  assert.equal(item.title, '测试短剧');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('播放记录：read_progress 为空时回退 read_history，缺标题用 multi-detail 补', async () => {
  const dir = tmpDir();
  const calls = [];
  const service = loggedInService(dir, {
    '/reading/bookapi/read_progress/list/v1/': () => ok({ code: 0, data: { video_data: [] } }),
    '/reading/bookapi/read_history/list/v1/': () => ok({
      code: 0,
      data: {
        data_list: [
          { book_id_str: '7412345678901234567', vid: '7412345678901234568', vid_index: 2, current_play_position: 30000, duration: 90000, read_timestamp_ms: 1763000000000, episode_cnt: 60 },
          { book_id_str: '111', is_delete: true },
        ],
      },
    }),
    '/reading/bookapi/multi-detail/v1/': (url) => {
      calls.push(url.searchParams.get('book_id'));
      return ok({ code: 0, data: { 7412345678901234567: { book_id: '7412345678901234567', book_name: '补齐剧名', thumb_url: 'https://img.example/t.jpg', episode_cnt: 60 } } });
    },
  });
  const result = await service.history();
  assert.equal(result.success, true);
  assert.equal(result.source, 'read_history');
  assert.equal(result.items.length, 1); // is_delete 被跳过
  assert.equal(result.items[0].title, '补齐剧名');
  assert.equal(result.items[0].cover, 'https://img.example/t.jpg');
  assert.deepEqual(calls, ['7412345678901234567']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('点赞记录：mixed_data_list 解析与时间排序', async () => {
  const dir = tmpDir();
  const service = loggedInService(dir, {
    '/reading/ugc/action/mget/v1/': (url) => {
      assert.equal(url.searchParams.get('action_type'), '3');
      assert.equal(url.searchParams.get('object_type_list'), '6,15,10');
      return ok({
        code: 0,
        data: {
          mixed_data_list: [
            { video_data: { series_id: '111222333', series_title: '早点赞', episode_cnt: 10, user_digg_timestamp_ms: 1763000000000 } },
            { book_data: { series_id: '444555666', series_title: '晚点赞', episode_cnt: 20 }, create_time: 1763100000 },
          ],
        },
      });
    },
  });
  const result = await service.likes();
  assert.equal(result.success, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].title, '晚点赞'); // 降序
  assert.equal(result.items[1].liked_at, 1763000000000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizeCover：HEIC/fqnovelpic 签名封面重建为可显示的 byteimg JPEG', () => {
  const heic = 'https://p3-reading-sign.fqnovelpic.com/novel-pic/2689f91a350b00baa5a821d92678b01e~tplv-shrink:640:0.heic?lk3s=1&x-expires=1&x-signature=abc';
  assert.equal(normalizeCover(heic), 'https://p3-novel.byteimg.com/novel-pic/2689f91a350b00baa5a821d92678b01e~tplv-shrink:640:0.image');
  // 已是 byteimg 公共封面：原样保留
  const byteimg = 'https://p3-novel.byteimg.com/novel-pic/7a3fb6b42560aafa788138d8c1c04abb~tplv-shrink:640:0.image';
  assert.equal(normalizeCover(byteimg), byteimg);
  // 非 novel-pic 普通图片：原样保留
  assert.equal(normalizeCover('https://img.example/cover.jpg'), 'https://img.example/cover.jpg');
  assert.equal(normalizeCover(''), '');
  assert.equal(normalizeCover(null), '');
});

test('收藏记录：视频书架 bookshelf/video/info（App 真实收藏），剧集级去重、按收藏时间降序', async () => {
  const dir = tmpDir();
  const service = loggedInService(dir, {
    '/reading/bookapi/bookshelf/video/info/v1/': () => ok({
      code: 0,
      data: {
        video_shelf_info: [
          { series_id: '111222333', series_title: '早收藏剧', episode_cnt: 10, collect_time: 1763000000, video_data: { title: '分集宣传文案' } },
          { book_id: '444555666', book_name: '晚收藏剧', collect_time: 1763100000, video_data: { series_id: '444555666', episode_cnt: 20 } },
          { series_id: '111222333', series_title: '早收藏剧', collect_time: 1762900000 },
        ],
      },
    }),
  });
  const result = await service.favorites();
  assert.equal(result.success, true);
  assert.equal(result.items.length, 2); // 同 series_id 去重
  assert.equal(result.items[0].title, '晚收藏剧'); // 降序 + 取剧集级剧名而非分集文案
  assert.equal(result.items[0].favorited_at, 1763100000000);
  assert.equal(result.items[0].episode_count, 20);
  assert.equal(result.items[1].title, '早收藏剧');
  assert.equal(result.items[1].position_ms, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('互动写入：点赞走 ugc set/v1/，收藏走 bookshelf/video/update/v1/（剧集级 book_id + 回读确认）', async () => {
  const dir = tmpDir();
  const captured = [];
  let shelfHas = false;
  const service = loggedInService(dir, {
    '/reading/ugc/action/set/v1/': (url, config) => {
      captured.push({ path: '/reading/ugc/action/set/v1/', method: config.method, body: config.data });
      return ok({ code: 0, message: 'SUCCESS', data: { refresh: false } });
    },
    '/reading/bookapi/bookshelf/video/update/v1/': (url, config) => {
      captured.push({ path: '/reading/bookapi/bookshelf/video/update/v1/', method: config.method, body: config.data });
      shelfHas = JSON.parse(config.data).update_bookshelf_video_list[0].video_shelf_operate_type === 0;
      return ok({ code: 0 });
    },
    '/reading/bookapi/bookshelf/video/info/v1/': () => ok({
      code: 0,
      data: { video_shelf_info: shelfHas ? [{ series_id: '7705722548046023742', series_title: '收藏剧', collect_time: 1763000000 }] : [] },
    }),
  });
  const like = await service.setSocialAction({ vid: '7706514645208534041', actionType: 3 });
  assert.equal(like.success, true);
  const collect = await service.setSocialAction({ seriesId: '7705722548046023742', actionType: 1 });
  assert.equal(collect.success, true);
  assert.equal(collect.confirmed, true);
  assert.equal(captured.length, 2);
  assert.equal(captured[0].method, 'POST');
  assert.deepEqual(JSON.parse(captured[0].body), { action_type: 3, object_type: 6, object_id: '7706514645208534041' });
  assert.equal(captured[1].path, '/reading/bookapi/bookshelf/video/update/v1/');
  const addBody = JSON.parse(captured[1].body);
  assert.equal(addBody.is_cancelled, false);
  assert.equal(addBody.update_bookshelf_video_list[0].book_id, '7705722548046023742');
  assert.equal(addBody.update_bookshelf_video_list[0].book_type, 2);
  assert.equal(addBody.update_bookshelf_video_list[0].video_shelf_operate_type, 0);
  assert.ok(addBody.update_bookshelf_video_list[0].modify_time > 0);
  assert.ok(addBody.shark_extra);
  assert.ok(!('group_name' in addBody.update_bookshelf_video_list[0]));
  const uncollect = await service.setSocialAction({ seriesId: '7705722548046023742', actionType: 2 });
  assert.equal(uncollect.success, true);
  assert.equal(uncollect.confirmed, true);
  const rmBody = JSON.parse(captured[2].body);
  assert.equal(rmBody.update_bookshelf_video_list[0].video_shelf_operate_type, 1);
  assert.equal(rmBody.update_bookshelf_video_list[0].group_name, '');
  assert.ok(!rmBody.shark_extra);
  const noSeries = await service.setSocialAction({ vid: '7706514645208534041', actionType: 1 });
  assert.equal(noSeries.success, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('互动写入：重复添加 101045 视为已生效；非法 vid/动作拒绝', async () => {
  const dir = tmpDir();
  const service = loggedInService(dir, {
    '/reading/ugc/action/set/v1/': () => ok({ code: 101045, message: 'DIGG_DUPLICATE_ADD_ERROR' }),
  });
  const dup = await service.setSocialAction({ vid: '7706514645208534041', actionType: 3 });
  assert.equal(dup.success, true);
  const badVid = await service.setSocialAction({ vid: '0', actionType: 3 });
  assert.equal(badVid.success, false);
  const badType = await service.setSocialAction({ vid: '7706514645208534041', actionType: 9 });
  assert.equal(badType.success, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('播放上报：upload/v1/ 毫秒单位、字符串 book_id/item_id、write_mode=1', async () => {
  const dir = tmpDir();
  let captured = null;
  const service = loggedInService(dir, {
    '/reading/bookapi/read_progress/upload/v1/': (url, config) => {
      captured = { method: config.method, body: JSON.parse(config.data) };
      return ok({ code: 0, message: 'SUCCESS', data: { upload_timestamp: 1794906186 } });
    },
  });
  const res = await service.reportProgress({ seriesId: '7705722548046023742', vid: '7705722862400719897', episodeIndex: 1, positionSec: 5, durationSec: 138.369, episodeCount: 379 });
  assert.equal(res.success, true);
  assert.equal(captured.method, 'POST');
  assert.equal(captured.body.write_mode, 1);
  const b = captured.body.books[0];
  assert.equal(b.book_id, '7705722548046023742');
  assert.equal(b.item_id, '7705722862400719897');
  assert.equal(b.vid_index, 1);
  assert.equal(b.current_play_time, 5000);
  assert.equal(b.current_total_time, 138369);
  assert.equal(b.episode_count, 379);
  assert.equal(b.book_type, 2);
  assert.equal(typeof b.progress_rate, 'string');
  assert.equal(b.player_cumulative_total_duration, 5000);
  assert.ok(Number.isInteger(b.read_timestamp_ms));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('播放上报：非法 book_id/vid_index 拒绝', async () => {
  const dir = tmpDir();
  const service = loggedInService(dir, {});
  const bad = await service.reportProgress({ seriesId: '0', vid: '7705722862400719897', episodeIndex: 1, positionSec: 1, durationSec: 1 });
  assert.equal(bad.success, false);
  const badIdx = await service.reportProgress({ seriesId: '7705722548046023742', vid: '7705722862400719897', episodeIndex: 0, positionSec: 1, durationSec: 1 });
  assert.equal(badIdx.success, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('预约记录：已上线读 subscribe_data，未上线读 name/cover，HEIC 封面归一', async () => {
  const dir = tmpDir();
  const heic = 'https://p3-reading-sign.fqnovelpic.com/novel-pic/2689f91a350b00baa5a821d92678b01e~tplv-shrink:640:0.heic?x-signature=abc';
  const service = loggedInService(dir, {
    '/reading/user/subscribe/list/v0/': (url) => {
      if (url.searchParams.get('is_online') === 'true') {
        return ok({
          code: 0,
          data: {
            subscribe_items: [{
              subscribe_time: 1763000000,
              subscribe_data: { vid: '7412345678901234568', series_id: '111222333', cover: heic, episode_cnt: 30, content_type: 1004, video_detail: { series_title: '已上线真剧名' } },
            }],
          },
        });
      }
      return ok({
        code: 0,
        data: {
          subscribe_items: [{
            item_id: '7412345678901234567', item_type: 14, name: '未上线真剧名', cover: heic,
            item_desc: '剧情简介', expected_publish_time: 1764000000, subscribe_time: 1763000000,
          }],
        },
      });
    },
  });
  const result = await service.reserves();
  assert.equal(result.success, true);
  assert.equal(result.items.length, 2);
  const online = result.items.find(i => !i.upcoming);
  assert.equal(online.title, '已上线真剧名');
  assert.equal(online.series_id, '111222333');
  assert.equal(online.episode_count, 30);
  assert.equal(online.cover, 'https://p3-novel.byteimg.com/novel-pic/2689f91a350b00baa5a821d92678b01e~tplv-shrink:640:0.image');
  const upcoming = result.items.find(i => i.upcoming);
  assert.equal(upcoming.title, '未上线真剧名');
  assert.equal(upcoming.abstract, '剧情简介');
  assert.equal(upcoming.publish_at, 1764000000000);
  assert.equal(upcoming.reservation_id, 'reservation:7412345678901234567');
  assert.equal(upcoming.cover, 'https://p3-novel.byteimg.com/novel-pic/2689f91a350b00baa5a821d92678b01e~tplv-shrink:640:0.image');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('预约记录：双类别合并，null 视为空，扁平条目加 reservation 前缀', async () => {
  const dir = tmpDir();
  const service = loggedInService(dir, {
    '/reading/user/subscribe/list/v0/': (url) => {
      const isOnline = url.searchParams.get('is_online');
      assert.equal(url.searchParams.get('tab_type'), '13');
      if (isOnline === 'true') {
        return ok({ code: 0, data: { subscribe_items: [{ video_data: { series_id: '111222333', series_title: '已上线预约', episode_cnt: 30 }, subscribe_time: 1763000000 }] } });
      }
      return ok({
        code: 0,
        data: {
          subscribe_items: [
            { item_id: '7412345678901234567', title: '待上线新剧', schedule_publish_time: 1764000000 },
            null,
          ],
        },
      });
    },
  });
  const result = await service.reserves();
  assert.equal(result.success, true);
  assert.equal(result.items.length, 2);
  const upcoming = result.items.find(i => i.upcoming);
  assert.equal(upcoming.reservation_id, 'reservation:7412345678901234567');
  assert.equal(upcoming.publish_at, 1764000000000);
  assert.equal(result.items[0].upcoming, true); // 待上线排前
  fs.rmSync(dir, { recursive: true, force: true });
});

test('预约提交：gzip body 精确保留 item_id，回读列表确认', async () => {
  const dir = tmpDir();
  let captured = null;
  const service = loggedInService(dir, {
    '/reading/bookapi/search/uncover_subscribe/v1/': (url, config) => {
      captured = config;
      return ok({ code: 0, data: {} });
    },
    '/reading/user/subscribe/list/v0/': (url) => {
      if (url.searchParams.get('is_online') === 'false') {
        return ok({ code: 0, data: { subscribe_items: [{ video_data: { series_id: '7412345678901234567', series_title: '下一季' } }] } });
      }
      return ok({ code: 0, data: { subscribe_items: null } });
    },
  });
  const result = await service.reserve('7412345678901234567');
  assert.equal(result.success, true);
  assert.equal(result.confirmed, true);
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers['Content-Encoding'], 'gzip');
  assert.equal(captured.headers['x-ss-stub'], md5Upper(captured.data));
  assert.equal(gunzipSync(captured.data).toString('utf8'), '{"item_id":7412345678901234567,"item_type":3,"op_type":1,"subscribe_source":0}');
  assert.ok(captured.headers.Cookie.includes('sessionid=sess-abc'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('预约提交：回执 code=0 但回读未确认时如实提示', async () => {
  const dir = tmpDir();
  const service = loggedInService(dir, {
    '/reading/bookapi/search/uncover_subscribe/v1/': () => ok({ code: 0 }),
    '/reading/user/subscribe/list/v0/': () => ok({ code: 0, data: { subscribe_items: null } }),
  });
  const result = await service.reserve('7412345678901234567');
  assert.equal(result.success, true);
  assert.equal(result.confirmed, false);
  assert.ok(result.notice.includes('暂未确认'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('相关作品：show_type 547 cell 解析，1007 标记待上线，域名回退', async () => {
  const dir = tmpDir();
  let attempts = 0;
  const service = loggedInService(dir, {
    '/reading/bookapi/plan/v:version/': (url) => {
      attempts++;
      assert.equal(url.searchParams.get('scene'), '10');
      assert.equal(url.searchParams.get('from'), 'detail_page_more_related');
      if (url.hostname.includes('sinfonlinec')) return { status: 500, headers: {}, data: '' };
      return ok({
        code: 0,
        data: [
          { show_type: 123, video_data: [{ series_id: '999', title: '无关 cell' }] },
          {
            show_type: 547,
            video_data: [
              { series_id: '7412345678901234567', title: '测试短剧 第二季', content_type: 1007, tag_info: { text: '第2季' }, episode_cnt: 0 },
              { series_id: '111222333', title: '测试短剧 第一季', content_type: 1004, episode_cnt: 80 },
            ],
          },
        ],
      });
    },
  });
  const result = await service.related('555666777');
  assert.equal(result.success, true);
  assert.equal(attempts, 2); // 首域名失败后回退
  assert.equal(result.items.length, 2);
  const upcoming = result.items.find(i => i.upcoming);
  assert.equal(upcoming.series_id, '7412345678901234567');
  assert.equal(upcoming.season_label, '第2季');
  assert.equal(result.items.find(i => !i.upcoming).episode_count, 80);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('账号资料：biz_user_id 为空判定匿名降级', async () => {
  const dir = tmpDir();
  const service = loggedInService(dir, {
    '/reading/user/info/v1/': () => ok({ code: 0, data: { biz_user_id: '', user_name: '用户12345678', has_set_username: false } }),
  });
  const result = await service.profile();
  assert.equal(result.success, true);
  assert.equal(result.anonymous, true);
  assert.ok(result.notice.includes('官方红果 App'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('账号接口业务拒绝与空响应转为中文 notice', async () => {
  const dir = tmpDir();
  const service = loggedInService(dir, {
    '/reading/bookapi/read_progress/list/v1/': () => ok({ code: 8, message: 'need login' }),
  });
  const result = await service.history();
  assert.equal(result.success, false);
  assert.ok(result.notice.includes('失败'));
  const empty = loggedInService(dir, {
    '/reading/bookapi/read_progress/list/v1/': () => ({ status: 200, headers: {}, data: '' }),
  });
  const emptyResult = await empty.history();
  assert.equal(emptyResult.success, false);
  fs.rmSync(dir, { recursive: true, force: true });
});