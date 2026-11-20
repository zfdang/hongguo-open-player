const axios = require('axios');
const { webMediaRequestOptions } = require('./web-media-guard');

const SITE = 'https://hongguoduanju.com';
const CATEGORIES = new Set(['real-drama', 'comic-drama', 'comic']);
const RANKINGS = new Set(['hot-drama', 'hot-real-drama', 'hot-comic-drama']);
const TIMEOUT_MS = 10000;

function publicMetadata(item) {
  const episode_label = typeof item?.episode_right_text === 'string' ? item.episode_right_text.trim().slice(0, 80) : '';
  const completion_status = /^(?:全\s*\d+\s*集|已完结|完结)$/.test(episode_label) ? 'completed'
    : /连载|更新至\s*\d+\s*集/.test(episode_label) ? 'ongoing' : 'unknown';
  const raw = Number(item?.first_visible_time);
  const timestamp = raw < 1e12 ? raw * 1000 : raw;
  const published_at = Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() ? timestamp : null;
  return { episode_label, completion_status, published_at };
}

function readRouterData(html) {
  const match = String(html).match(/(?:window\.)?_ROUTER_DATA\s*=\s*(\{)/);
  if (!match) throw new Error('来源页面未返回目录数据，请重试或打开来源页面');
  const start = match.index + match[0].length - 1;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('来源目录数据不完整，请重试');
}

module.exports = {
  readRouterData,
  publicMetadata,
  SITE,
  CATEGORIES,
  RANKINGS
};
