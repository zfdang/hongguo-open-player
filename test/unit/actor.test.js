// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  catalogCover,
  extractEpisodeCount,
  parseRankingPayload,
  parseDetailPayload,
  parseWorksPayload,
  clearActorSession,
  clearWorksCache,
  fetchActorRankings,
  fetchActorDetail,
  fetchActorWorks
} = require('../../src/server/native/hongguo-actor');
const dramaService = require('../../src/server/services/dramaService');
const { startServer } = require('../../src/server/index');

test('catalogCover converts HEIC and novel-pic URLs to public JPEG variants and preserves external images', () => {
  assert.equal(catalogCover(''), '');
  assert.equal(catalogCover(null), '');

  // External images preserved
  const externalUrl = 'https://img.example.com/cover/abc.jpeg?x=1';
  assert.equal(catalogCover(externalUrl), externalUrl);

  // Signed JPEG avatar URL on fqnovelpic converts to public 640x640 JPEG image
  const avatarJpegUrl = 'http://p3-reading-sign.fqnovelpic.com/novel-pic/c61a718fd0ac4df9afffc0aae28b43e6~tplv-s85hriknmn-jpeg-v1:144:0.jpeg?lk3s=9b9bd2b1&x-expires=1795796883';
  assert.equal(catalogCover(avatarJpegUrl), 'https://p3-novel.byteimg.com/novel-pic/c61a718fd0ac4df9afffc0aae28b43e6~tplv-shrink:640:0.image');

  // HEIC url converts to public JPEG image
  const heicUrl = 'https://p3-reading-sign.fqnovelpic.com/novel-pic/f46efa4c55e9b146f7d4906fd88ceb4e~tplv-81nmtwyey9.heic?x-expires=123';
  const converted = catalogCover(heicUrl);
  assert.ok(converted.includes('p3-novel.byteimg.com'));
  assert.ok(converted.includes('/novel-pic/f46efa4c55e9b146f7d4906fd88ceb4e~tplv-shrink:640:0.image'));
});

test('extractEpisodeCount parses various subtitle formats', () => {
  assert.equal(extractEpisodeCount('都市脑洞·86集'), 86);
  assert.equal(extractEpisodeCount('全 100 集'), 100);
  assert.equal(extractEpisodeCount('暂无'), 0);
  assert.equal(extractEpisodeCount(null), 0);
});

test('parseRankingPayload validates schema, selector mismatches, and extracts actor rankings', () => {
  // 1. Error on invalid code
  assert.throws(() => parseRankingPayload({ code: 1, message: '系统繁忙' }), /系统繁忙/);
  assert.throws(() => parseRankingPayload({ code: 0, data: {} }), /剧星榜返回结构异常/);

  // 2. Error on selector mismatch
  const wrongSelector = {
    code: 0,
    data: {
      cell_view: {
        cell_data: [],
        cell_selector: {
          outer_row: {
            items: [{ is_selected: true, selector_item_id: 'ranklist_series_drama' }]
          }
        }
      }
    }
  };
  assert.throws(() => parseRankingPayload(wrongSelector), /服务端未选中演员榜/);

  // 3. Error on sub selector mismatch (e.g. star fans ranking)
  const wrongSubSelector = {
    code: 0,
    data: {
      cell_view: {
        cell_data: [],
        cell_selector: {
          outer_row: {
            items: [{
              is_selected: true,
              selector_item_id: 'ranklist_celebrity',
              sub_cell_selector: {
                outer_row: {
                  items: [{ is_selected: true, selector_item_id: 'ranklist_actor_fans' }]
                }
              }
            }]
          }
        }
      }
    }
  };
  assert.throws(() => parseRankingPayload(wrongSubSelector), /不可用星光榜冒充/);

  // 4. Valid payload extraction
  const validPayload = {
    code: 0,
    data: {
      has_more: true,
      next_offset: 20,
      session_id: 'sess-12345',
      cell_view: {
        cell_data_json: JSON.stringify({ rank_list_date: '2026年10月28日' }),
        cell_selector: {
          outer_row: {
            items: [{
              is_selected: true,
              selector_item_id: 'ranklist_celebrity',
              sub_cell_selector: {
                outer_row: {
                  items: [{ is_selected: true, selector_item_id: 'ranklist_series_actor' }]
                }
              }
            }]
          }
        },
        cell_data: [
          {
            ugc_user_data: [
              {
                user_info: {
                  user_id: '111',
                  base_info: {
                    actor_id_str: '7602119348190205246',
                    user_name: '何健麒',
                    user_avatar: 'https://p3-reading-sign.fqnovelpic.com/novel-pic/abc~tplv-81nmtwyey9.heic'
                  }
                },
                rec_text_item: { RecommendText: '1047万人气' },
                intro: '青年男演员',
                sub_title_list: [{ content: '《大魔王》' }, { content: '《逆袭归来》' }],
                rank_change_data: { rank_change_type: 1, ChangeNum: 2 }
              }
            ]
          }
        ]
      }
    }
  };

  const parsed = parseRankingPayload(validPayload, { pageNum: 1, pageLimit: 20 });
  assert.equal(parsed.rankDate, '2026年10月28日');
  assert.equal(parsed.hasMore, true);
  assert.equal(parsed.nextOffset, 20);
  assert.equal(parsed.sessionId, 'sess-12345');
  assert.equal(parsed.actors.length, 1);

  const actor = parsed.actors[0];
  assert.equal(actor.rank, 1);
  assert.equal(actor.actor_id, '7602119348190205246');
  assert.equal(actor.name, '何健麒');
  assert.ok(actor.avatar.includes('p3-novel.byteimg.com'));
  assert.equal(actor.score, '1047万人气');
  assert.equal(actor.rank_change.type, 1);
  assert.equal(actor.rank_change.num, 2);
  assert.deepEqual(actor.sub_titles, ['《大魔王》', '《逆袭归来》']);
});

test('fetchActorRankings handles pagination and in-memory session caching', async () => {
  clearActorSession();

  let requestCount = 0;
  const mockRequest = async (signed) => {
    requestCount++;
    const isFirstPage = signed.url.includes('tab_type=26');
    return {
      code: 0,
      data: {
        has_more: isFirstPage,
        next_offset: isFirstPage ? 10 : 20,
        session_id: 'mock-session-id',
        cell_view: {
          cell_data_json: JSON.stringify({ rank_list_date: '2026年10月29日' }),
          cell_data: [
            {
              ugc_user_data: [
                {
                  user_info: {
                    base_info: {
                      actor_id_str: isFirstPage ? '7602119348190205246' : '7602119348190205247',
                      user_name: isFirstPage ? '演员A' : '演员B'
                    }
                  },
                  rec_text_item: { RecommendText: isFirstPage ? '1000万人气' : '900万人气' }
                }
              ]
            }
          ]
        }
      }
    };
  };

  // 1. Fetch page 1
  const resPage1 = await fetchActorRankings({ page: 1, limit: 10, request: mockRequest });
  assert.equal(resPage1.success, true);
  assert.equal(resPage1.actors[0].name, '演员A');
  assert.equal(requestCount, 1);

  // 2. Fetch page 1 again -> should hit memory cache without network call
  const resPage1Cached = await fetchActorRankings({ page: 1, limit: 10, request: mockRequest });
  assert.equal(resPage1Cached.from_cache, true);
  assert.equal(requestCount, 1);

  // 3. Fetch page 2 -> should use session to fetch next page
  const resPage2 = await fetchActorRankings({ page: 2, limit: 10, request: mockRequest });
  assert.equal(resPage2.success, true);
  assert.equal(resPage2.actors[0].name, '演员B');
  assert.equal(requestCount, 2);

  // 4. Clear session (simulating TTL expiration) and jump directly to page 3
  // hongguo-actor should sequentially rebuild cursors from page 1 to 2, then fetch page 3
  clearActorSession();
  const requestedPages = [];
  const pagedMockRequest = async (signed) => {
    const isP1 = signed.url.includes('tab_type=26');
    const urlObj = new URL(signed.url);
    const offset = urlObj.searchParams.get('offset') || '0';
    requestedPages.push({ isP1, offset });
    return {
      code: 0,
      data: {
        has_more: true,
        next_offset: Number(offset) + 10,
        session_id: 'rebuilt-sess',
        cell_view: {
          cell_data: [
            {
              ugc_user_data: [
                {
                  user_info: {
                    base_info: {
                      actor_id_str: `760211934819020524${offset}`,
                      user_name: `演员_off${offset}`
                    }
                  },
                  rec_text_item: { RecommendText: '100万人气' }
                }
              ]
            }
          ]
        }
      }
    };
  };

  const resPage3 = await fetchActorRankings({ page: 3, limit: 10, request: pagedMockRequest });
  assert.equal(resPage3.success, true);
  assert.equal(resPage3.page, 3);
  // Requested page 1 (tab_type=26, offset=0), then page 2 (offset=10), then page 3 (offset=20)
  assert.equal(requestedPages.length, 3);
  assert.equal(requestedPages[0].offset, '0');
  assert.equal(requestedPages[1].offset, '10');
  assert.equal(requestedPages[2].offset, '20');
  // Rank of actor on page 3 must be correctly computed as (3 - 1) * 10 + 1 = 21
  assert.equal(resPage3.actors[0].rank, 21);
  assert.equal(resPage3.actors[0].name, '演员_off20');
});

test('fetchActorRankings isolates cache and session cursors by pageLimit', async () => {
  clearActorSession();
  const requestsMade = [];

  const mockPagedRequest = async (signed) => {
    const urlObj = new URL(signed.url);
    const limit = Number(urlObj.searchParams.get('limit') || 20);
    const offset = Number(urlObj.searchParams.get('offset') || 0);
    requestsMade.push({ limit, offset });

    const ugc_user_data = [];
    for (let i = 0; i < limit; i++) {
      const idx = offset + i;
      ugc_user_data.push({
        user_info: {
          base_info: {
            actor_id_str: `7600000000000000${idx}`,
            user_name: `演员_${idx + 1}`
          }
        },
        rec_text_item: { RecommendText: `${1000 - idx}万人气` }
      });
    }

    return {
      code: 0,
      data: {
        has_more: true,
        next_offset: offset + limit,
        session_id: `sess-limit-${limit}`,
        cell_view: {
          cell_data_json: JSON.stringify({ rank_list_date: '2026年10月29日' }),
          cell_data: [{ ugc_user_data }]
        }
      }
    };
  };

  // 1. Request limit=5, page=1
  const resLimit5P1 = await fetchActorRankings({ page: 1, limit: 5, request: mockPagedRequest });
  assert.equal(resLimit5P1.success, true);
  assert.equal(resLimit5P1.actors.length, 5);
  assert.equal(resLimit5P1.actors[0].rank, 1);
  assert.equal(resLimit5P1.actors[4].rank, 5);
  assert.equal(requestsMade.length, 1);
  assert.deepEqual(requestsMade[0], { limit: 5, offset: 0 });

  // 2. Request limit=20, page=1 -> Must NOT return cached 5 actors! Must isolate and fetch 20 actors
  const resLimit20P1 = await fetchActorRankings({ page: 1, limit: 20, request: mockPagedRequest });
  assert.equal(resLimit20P1.success, true);
  assert.equal(resLimit20P1.actors.length, 20);
  assert.equal(resLimit20P1.actors[0].rank, 1);
  assert.equal(resLimit20P1.actors[19].rank, 20);
  assert.equal(requestsMade.length, 2);
  assert.deepEqual(requestsMade[1], { limit: 20, offset: 0 });

  // 3. Request limit=20, page=2 -> Must use session for limit=20 (offset=20, not offset=5)
  const resLimit20P2 = await fetchActorRankings({ page: 2, limit: 20, request: mockPagedRequest });
  assert.equal(resLimit20P2.success, true);
  assert.equal(resLimit20P2.actors.length, 20);
  assert.equal(resLimit20P2.actors[0].rank, 21); // TOP 21 correctly corresponds to actor_21
  assert.equal(resLimit20P2.actors[0].name, '演员_21');
  assert.equal(requestsMade.length, 3);
  assert.deepEqual(requestsMade[2], { limit: 20, offset: 20 });

  // 4. Request limit=5, page=1 again -> Hits limit=5 cache without disturbing limit=20
  const resLimit5P1Cached = await fetchActorRankings({ page: 1, limit: 5, request: mockPagedRequest });
  assert.equal(resLimit5P1Cached.from_cache, true);
  assert.equal(resLimit5P1Cached.actors.length, 5);
  assert.equal(requestsMade.length, 3);
});

test('fetchActorRankings filters by gender (male, female) and isolates pagination/sessions', async () => {
  clearActorSession();

  const mockGenderRequest = async (signed) => {
    return {
      code: 0,
      data: {
        has_more: false,
        next_offset: 4,
        session_id: 'mock-gender-session',
        cell_view: {
          cell_data_json: JSON.stringify({ rank_list_date: '2026年10月29日' }),
          cell_data: [
            {
              ugc_user_data: [
                {
                  user_info: {
                    base_info: { actor_id_str: '101', user_name: '王凯沐' } // Known male
                  },
                  rec_text_item: { RecommendText: '100万人气' },
                  intro: '中国内地男演员'
                },
                {
                  user_info: {
                    base_info: { actor_id_str: '102', user_name: '王小亿' } // Known female
                  },
                  rec_text_item: { RecommendText: '90万人气' },
                  intro: '中国内地女演员'
                },
                {
                  user_info: {
                    base_info: { actor_id_str: '103', user_name: '梁思伟' } // Known male
                  },
                  rec_text_item: { RecommendText: '80万人气' },
                  intro: '中国内地男演员'
                },
                {
                  user_info: {
                    base_info: { actor_id_str: '104', user_name: '何雅馨' } // Known female
                  },
                  rec_text_item: { RecommendText: '70万人气' },
                  intro: '全网知名达人何娜娜'
                }
              ]
            }
          ]
        }
      }
    };
  };

  // 1. Male filter -> only male actors
  const maleRes = await fetchActorRankings({ page: 1, limit: 10, gender: 'male', request: mockGenderRequest });
  assert.equal(maleRes.success, true);
  assert.equal(maleRes.gender, 'male');
  assert.equal(maleRes.actors.length, 2);
  assert.equal(maleRes.actors[0].name, '王凯沐');
  assert.equal(maleRes.actors[1].name, '梁思伟');

  // 2. Female filter -> only female actors
  const femaleRes = await fetchActorRankings({ page: 1, limit: 10, gender: 'female', request: mockGenderRequest });
  assert.equal(femaleRes.success, true);
  assert.equal(femaleRes.gender, 'female');
  assert.equal(femaleRes.actors.length, 2);
  assert.equal(femaleRes.actors[0].name, '王小亿');
  assert.equal(femaleRes.actors[1].name, '何雅馨');

  // 3. All filter -> all 4 actors
  const allRes = await fetchActorRankings({ page: 1, limit: 10, gender: 'all', request: mockGenderRequest });
  assert.equal(allRes.success, true);
  assert.equal(allRes.gender, 'all');
  assert.equal(allRes.actors.length, 4);
});

test('fetchActorDetail and fetchActorWorks parse profiles, related actors and drama works', async () => {
  // 1. Detail parsing
  const mockDetailRequest = async () => ({
    code: 0,
    data: {
      celebrity_info: {
        nickname: '何健麒',
        avatar: 'https://p3-reading-sign.fqnovelpic.com/novel-pic/avatar.jpeg',
        intro: '中国内地短剧演员',
        related_celebrities: [
          { celebrity_id: '7602119348190205248', nickname: '马秋元', intro: '常驻搭档' }
        ]
      }
    }
  });

  const detailRes = await fetchActorDetail('7602119348190205246', { request: mockDetailRequest });
  assert.equal(detailRes.success, true);
  assert.equal(detailRes.actor.actor_id, '7602119348190205246');
  assert.equal(detailRes.actor.name, '何健麒');
  assert.equal(detailRes.actor.related_celebrities.length, 1);
  assert.equal(detailRes.actor.related_celebrities[0].name, '马秋元');

  // 2. Works parsing & multi-page slicing with cache
  clearWorksCache();
  let upstreamWorksCalls = 0;
  const mockWorksRequest = async () => {
    upstreamWorksCalls++;
    return {
      code: 0,
      data: {
        works: {
          '7602119348190205246': {
            total_count: 5,
            has_more: true,
            video_list: [
              { series_id: '101', title: '短剧1', cover: 'https://img/1.jpeg', sub_title: '10集' },
              { series_id: '102', title: '短剧2', cover: 'https://img/2.jpeg', sub_title: '20集' },
              { series_id: '103', title: '短剧3', cover: 'https://img/3.jpeg', sub_title: '30集' },
              { series_id: '104', title: '短剧4', cover: 'https://img/4.jpeg', sub_title: '40集' },
              { series_id: '105', title: '短剧5', cover: 'https://img/5.jpeg', sub_title: '50集' }
            ]
          }
        }
      }
    };
  };

  // Batch 1: offset=0, count=2 -> items 101, 102
  const worksRes1 = await fetchActorWorks('7602119348190205246', { count: 2, offset: 0, request: mockWorksRequest });
  assert.equal(worksRes1.success, true);
  assert.equal(worksRes1.works.length, 2);
  assert.equal(worksRes1.works[0].series_id, '101');
  assert.equal(worksRes1.works[1].series_id, '102');
  assert.equal(worksRes1.total_count, 5);
  assert.equal(worksRes1.has_more, true);
  assert.equal(upstreamWorksCalls, 1);

  // Batch 2: offset=2, count=2 -> items 103, 104 (served from cache)
  const worksRes2 = await fetchActorWorks('7602119348190205246', { count: 2, offset: 2, request: mockWorksRequest });
  assert.equal(worksRes2.success, true);
  assert.equal(worksRes2.works.length, 2);
  assert.equal(worksRes2.works[0].series_id, '103');
  assert.equal(worksRes2.works[1].series_id, '104');
  assert.equal(worksRes2.from_cache, true);
  assert.equal(worksRes2.has_more, true);
  assert.equal(upstreamWorksCalls, 1); // No new upstream call

  // Batch 3: offset=4, count=2 -> item 105 (served from cache, has_more=false)
  const worksRes3 = await fetchActorWorks('7602119348190205246', { count: 2, offset: 4, request: mockWorksRequest });
  assert.equal(worksRes3.success, true);
  assert.equal(worksRes3.works.length, 1);
  assert.equal(worksRes3.works[0].series_id, '105');
  assert.equal(worksRes3.has_more, false);
  assert.equal(upstreamWorksCalls, 1);

  // 3. Input validation
  await assert.rejects(fetchActorDetail('abc!'), /无效的演员 ID/);
  await assert.rejects(fetchActorWorks(''), /无效的演员 ID/);
});

test('actor REST API endpoints return JSON and handle invalid parameters', async (t) => {
  // Mock dramaService actor methods to ensure offline reliability in CI
  const originalGetRankings = dramaService.getActorRankings;
  const originalGetDetail = dramaService.getActorDetail;
  const originalGetWorks = dramaService.getActorWorks;

  t.after(() => {
    dramaService.getActorRankings = originalGetRankings;
    dramaService.getActorDetail = originalGetDetail;
    dramaService.getActorWorks = originalGetWorks;
  });

  dramaService.getActorRankings = async ({ page, limit, gender = 'all' }) => ({
    success: true,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
    gender,
    actors: [
      { actor_id: '7602119348190205246', name: '何健麒', rank: 1, score: '1000万人气' }
    ]
  });

  dramaService.getActorDetail = async (actorId) => {
    if (!/^\d{1,30}$/.test(actorId)) {
      throw Object.assign(new Error('无效的演员 ID'), { code: 'ACTOR_ID_INVALID', status: 400 });
    }
    return {
      success: true,
      actor: { actor_id: actorId, name: '何健麒', intro: '演员' }
    };
  };

  dramaService.getActorWorks = async (actorId) => {
    if (!/^\d{1,30}$/.test(actorId)) {
      throw Object.assign(new Error('无效的演员 ID'), { code: 'ACTOR_ID_INVALID', status: 400 });
    }
    return {
      success: true,
      actor_id: actorId,
      works: [{ series_id: '7700249043456248857', series_title: '测试短剧' }]
    };
  };

  const { server, port } = await startServer(0);
  try {
    // 1. Establish player session cookie
    const cookie = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, res => {
        const rawCookie = res.headers['set-cookie']?.[0]?.split(';')[0] || '';
        resolve(rawCookie);
      }).on('error', reject);
    });

    const get = (path) => new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}${path}`, {
        headers: { Cookie: cookie }
      }, res => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
      }).on('error', reject);
    });

    // 2. GET /api/actors/ranking
    const rankRes = await get('/api/actors/ranking?page=1&limit=5');
    assert.equal(rankRes.status, 200);
    assert.equal(rankRes.data.success, true);
    assert.ok(Array.isArray(rankRes.data.actors));
    assert.equal(rankRes.data.actors[0].name, '何健麒');

    // 2.1 GET /api/actors/ranking with gender filter
    const rankFemaleRes = await get('/api/actors/ranking?page=1&limit=5&gender=female');
    assert.equal(rankFemaleRes.status, 200);
    assert.equal(rankFemaleRes.data.success, true);
    assert.equal(rankFemaleRes.data.gender, 'female');

    // 3. GET /api/actors/:actorId
    const detailRes = await get('/api/actors/7602119348190205246');
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.data.success, true);
    assert.equal(detailRes.data.actor.actor_id, '7602119348190205246');

    // 4. GET /api/actors/:actorId/works
    const worksRes = await get('/api/actors/7602119348190205246/works');
    assert.equal(worksRes.status, 200);
    assert.equal(worksRes.data.success, true);
    assert.ok(Array.isArray(worksRes.data.works));

    // 5. Invalid ID returns 400
    const badRes = await get('/api/actors/not-a-number');
    assert.equal(badRes.status, 400);
    assert.ok(badRes.data.error.includes('无效的演员 ID'));
  } finally {
    server.close();
  }
});
