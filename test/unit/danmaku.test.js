const { test } = require('node:test');
const assert = require('node:assert/strict');
const danmaku = require('../../src/server/native/danmaku');

test('parsePage parses valid comments and extracts pagination cursor', () => {
  const payload = {
    code: 0,
    data: {
      data_list: [
        {
          comment: {
            common: { group_id: '1001', status: '1', content: { text: '弹幕测试一' } },
            expand: { offset_time: 1500 },
            stat: { digg_count: 5 }
          }
        },
        {
          comment: {
            common: { group_id: '1001', status: '2', content: { text: '待审核不可见' } },
            expand: { offset_time: 2000 }
          }
        },
        {
          comment: {
            common: { group_id: '9999', status: '1', content: { text: '其他视频弹幕' } },
            expand: { offset_time: 2500 }
          }
        }
      ],
      extra: { next_query_danmaku_list_time: 30000 },
      common_list_info: {
        has_more: true,
        cursor: '{"start_offset_time":0,"end_offset_time":30000,"session_id":"test-session"}'
      }
    }
  };

  const parsed = danmaku.parsePage(payload, '1001');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].text, '弹幕测试一');
  assert.equal(parsed.items[0].timeRaw, 1500);
  assert.equal(parsed.items[0].likes, 5);
  assert.equal(parsed.nextMs, 30000);
  assert.equal(parsed.hasMore, true);
  assert.equal(parsed.cursor, '{"start_offset_time":0,"end_offset_time":30000,"session_id":"test-session"}');
});

test('buildBody includes cursor and start offset correctly', () => {
  const body = danmaku.buildBody('1001', '2001', 30000, 3600000, '{"session":"abc"}');
  assert.equal(body.group_id, '1001');
  assert.equal(body.business_param.book_id, '2001');
  assert.equal(body.business_param.start_offset_time, 30000);
  assert.equal(body.cursor, '{"session":"abc"}');
});

test('resolveDeviceIdentity honors explicit override and falls back cleanly', async () => {
  danmaku.resetDanmakuCache();
  danmaku.setDeviceIdentity({ deviceId: '9876543210123456', installId: '1234567890123456' });
  const identity = await danmaku.resolveDeviceIdentity();
  assert.equal(identity.deviceId, '9876543210123456');
  assert.equal(identity.installId, '1234567890123456');
  danmaku.resetDanmakuCache();
});

test('fetchDanmaku fetches and stitches pages passing cursor, without false failure on natural empty end', async () => {
  danmaku.resetDanmakuCache();
  danmaku.setDeviceIdentity({ deviceId: '111222333444555', installId: '666777888999000' });

  const transportCalls = [];
  const mockTransport = async (url, bodyStr) => {
    const body = JSON.parse(bodyStr);
    transportCalls.push(body);
    const start = body.business_param.start_offset_time;
    if (start === 0) {
      return {
        data: {
          code: 0,
          data: {
            data_list: [
              {
                comment: {
                  common: { group_id: '123456', status: '1', content: { text: '第一页弹幕' } },
                  expand: { offset_time: 1200 },
                  stat: { digg_count: 3 }
                }
              }
            ],
            common_list_info: {
              has_more: true,
              cursor: '{"page":1}'
            },
            extra: { next_query_danmaku_list_time: 30000 }
          }
        }
      };
    }
    // Page 2: natural end with no more comments
    return {
      data: {
        code: 0,
        data: {
          data_list: [],
          common_list_info: {
            has_more: false,
            cursor: ''
          },
          extra: { next_query_danmaku_list_time: 0 }
        }
      }
    };
  };

  const result = await danmaku.fetchDanmaku({
    seriesId: '654321',
    vid: '123456',
    transport: mockTransport,
    fresh: true
  });

  assert.equal(result.success, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].text, '第一页弹幕');
  assert.equal(result.items[0].time, 1.2);
  assert.equal(transportCalls.length, 2);
  assert.equal(transportCalls[0].cursor, '');
  assert.equal(transportCalls[1].cursor, '{"page":1}');
  danmaku.resetDanmakuCache();
});

test('fetchDanmaku reports 本集暂无弹幕 when video naturally ends with 0 comments', async () => {
  danmaku.resetDanmakuCache();
  danmaku.setDeviceIdentity({ deviceId: '111222333444555', installId: '666777888999000' });

  const mockTransport = async () => ({
    data: {
      code: 0,
      data: {
        data_list: [],
        common_list_info: { has_more: false, cursor: '' }
      }
    }
  });

  const result = await danmaku.fetchDanmaku({
    seriesId: '654321',
    vid: '123456',
    transport: mockTransport,
    fresh: true
  });

  assert.equal(result.success, true);
  assert.equal(result.items.length, 0);
  assert.equal(result.notice, '本集暂无弹幕');
  assert.equal(result.error, '');
  danmaku.resetDanmakuCache();
});

test('Danmaku DOM engine provides play, pause, seek on prototype', () => {
  const Danmaku = require('../../src/client/js/danmaku.dom');
  assert.equal(typeof Danmaku.prototype.play, 'function');
  assert.equal(typeof Danmaku.prototype.pause, 'function');
  assert.equal(typeof Danmaku.prototype.seek, 'function');
});
