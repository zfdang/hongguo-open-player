const { test } = require('node:test');
const assert = require('node:assert/strict');

// 用受控的 requestJson/signedMetadataRequest 替换 app-source，隔离网络与签名，
// 其余导出（parseSearchInteger 等）沿用真实实现。需在加载 recommend 及其依赖前注入缓存。
const appSourcePath = require.resolve('../../src/server/native/app-source');
const realAppSource = require(appSourcePath);
let mockHandler = async () => { throw new Error('未设置 mock'); };
const captured = [];
const stub = {
  ...realAppSource,
  signedMetadataRequest: (apiPath, values) => {
    captured.push({ path: apiPath, values });
    return { url: `https://stub.test${apiPath}`, headers: {} };
  },
  requestJson: async (url, options) => mockHandler(url, options)
};
require.cache[appSourcePath] = { id: appSourcePath, filename: appSourcePath, loaded: true, exports: stub };
for (const name of ['hongguo-recommend', 'hongguo-app-catalog', 'hongguo-app-search']) {
  delete require.cache[require.resolve(`../../src/server/native/${name}`)];
}
const recommend = require('../../src/server/native/hongguo-recommend');

const video = (id, title) => ({ series_id: id, series_title: title, cover: 'https://p3-novel.byteimg.com/x.jpg', episode_cnt: 10, series_intro: '简介' });
const tabPayload = (videos, extra = {}) => ({
  code: 0,
  data: { tab_item: [{ tab_type: 16, session_id: 'sess', cell_data: [{ cell_id_str: '747009', cell_data: [{ video_data: videos }] }], ...extra }] }
});
const cellPayload = videos => ({ code: 0, data: { session_id: 'sess2', cell_view: { cell_data: [{ video_data: videos }] } } });

test('推荐首屏走 tab/v1，队列内续发不再请求；开启单列无限流后改走 cell/change/v1 续刷', async () => {
  recommend.resetRecommend();
  captured.length = 0;
  let call = 0;
  mockHandler = async () => {
    call += 1;
    if (call === 1) return tabPayload([video('111', '剧一'), video('222', '剧二')],
      { bottom_unlimited: true, client_template: 7, bookstore_id: '123', version_tag: 'vt' });
    return cellPayload([video('333', '剧三')]);
  };
  const r1 = await recommend.nextRecommend();
  assert.equal(r1.success, true);
  assert.equal(r1.item.series_id, '111');
  assert.equal(captured[0].path, '/reading/bookapi/bookmall/tab/v1/');
  assert.equal(captured[0].values.tab_type, '16');
  assert.equal(captured[0].values.client_req_type, '1');
  // 第二部来自同一批队列，不产生新请求
  const r2 = await recommend.nextRecommend();
  assert.equal(r2.item.series_id, '222');
  assert.equal(captured.length, 1);
  // 队列耗尽后续刷，走 cell/change/v1 且携带 cellFlow 与 filter_ids
  const r3 = await recommend.nextRecommend();
  assert.equal(r3.item.series_id, '333');
  assert.equal(captured[1].path, '/reading/bookapi/bookmall/cell/change/v1/');
  assert.equal(captured[1].values.cell_id, '747009');
  assert.equal(captured[1].values.plan_id, '123');
  assert.equal(captured[1].values.version_tag, 'vt');
  assert.equal(captured[1].values.client_template, '7');
  assert.match(captured[1].values.filter_ids, /111,222/);
});

test('整批重复时重置会话重试，最终收敛为失败而不死循环', async () => {
  recommend.resetRecommend();
  captured.length = 0;
  mockHandler = async () => tabPayload([video('111', '剧一')]);
  const r1 = await recommend.nextRecommend();
  assert.equal(r1.item.series_id, '111');
  const before = captured.length;
  const r2 = await recommend.nextRecommend();
  assert.equal(r2.success, false);
  assert.ok(r2.error);
  // 有界重试：不会无限请求
  assert.ok(captured.length - before <= 9);
});

test('带会话时收到业务拒绝（如 110）会丢弃旧会话从头重拉一次', async () => {
  recommend.resetRecommend();
  captured.length = 0;
  let call = 0;
  mockHandler = async () => {
    call += 1;
    if (call === 1) return tabPayload([video('111', '剧一')]);
    if (call === 2) return { code: 110 };
    return tabPayload([video('222', '剧二')]);
  };
  const r1 = await recommend.nextRecommend();
  assert.equal(r1.item.series_id, '111');
  const r2 = await recommend.nextRecommend();
  assert.equal(r2.success, true);
  assert.equal(r2.item.series_id, '222');
  // 重拉时已丢弃旧 session_id
  assert.equal(captured[2].values.session_id, undefined);
});

test('parseFeed 归一化续刷 cell_view 并按 seen 去重', async () => {
  recommend.resetRecommend();
  const parsed = recommend.parseFeed(cellPayload([video('111', '剧一'), video('111', '剧一重复'), video('222', '剧二')]));
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.session, 'sess2');
  assert.equal(parsed.rawCount, 3);
});