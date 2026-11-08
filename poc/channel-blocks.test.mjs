import test from 'node:test';
import assert from 'node:assert/strict';
import { blockChannel, isChannelBlocked, loadChannelBlocks, saveChannelBlocks, channelBlocksJSON } from './channel-blocks.mjs';
import { cleanHome, emptyHome } from './home.mjs';
import { defaultPreferences } from '../extension/preferences.mjs';
import { filterLiveResults, videoUrl } from './model.mjs';

test('channel ban follows IDs, handles and older name-only cards; survives history removal and reload', () => {
  const data = new Map(), storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
  const source = { channel_id: `UC${'a'.repeat(22)}`, channel: 'Old Name', channel_url: 'https://www.youtube.com/@museum', source: 'youtube_web' };
  const records = blockChannel([], source); assert.ok(saveChannelBlocks(storage, records));
  storage.setItem('mytube.home.v1', JSON.stringify(emptyHome()));
  const restored = loadChannelBlocks(storage);
  for (const row of [{ ...source, channel: 'New Name' }, { channel: 'old name' }, { channel: 'Other', channel_url: source.channel_url }]) assert.ok(isChannelBlocked(row, restored));
  assert.equal(isChannelBlocked({ channel: 'Different museum' }, restored), false);
  assert.equal(isChannelBlocked({ channel: source.channel, source: 'external_web' }, restored), false);
  assert.equal(blockChannel(restored, source).length, 1);
  assert.equal(JSON.parse(channelBlocksJSON(restored)).version, 1);
  const video = { ...source, video_id: 'abcdefghijk', title: 'History', source: 'youtube_live', duration_seconds: 1800 };
  assert.equal(filterLiveResults([video], { blockedChannels: restored, search: '', minMinutes: 1, maxMinutes: 360, hidden: new Set(), saved: new Set() }).length, 0);
  assert.equal(filterLiveResults([video], { blockedChannels: [], search: '', minMinutes: 1, maxMinutes: 360, hidden: new Set(), saved: new Set() }).length, 1);
});

test('cache keeps canonical external links and stable YouTube channel IDs through upgrades', () => {
  const now = Date.now(), url = 'https://vimeo.com/123456';
  const video = { video_id: `web:${url}`, source_url: url, source: 'external_web', title: 'Navigation film', channel: 'Vimeo', platform: 'Vimeo', channel_unknown: true,
    duration_seconds: null, published_at: null, cachedAt: now, discovery_stream: 'wildcard', discovery_why: 'Pacific navigation' };
  const yt = { ...video, video_id: 'abcdefghijk', source: 'youtube_web', channel: 'Museum', channel_id: `UC${'b'.repeat(22)}`, channel_url: 'https://www.youtube.com/@museum' };
  const home = cleanHome({ ...emptyHome(), topics: [{ label: 'Navigation', queries: ['Navigation'], preferences: defaultPreferences(), updatedAt: now, videos: [video, yt] }] }, now);
  assert.equal(home.topics[0].videos.length, 2);
  assert.equal(videoUrl(home.topics[0].videos[0].video_id), url);
  assert.equal(home.topics[0].videos[1].channel_id, yt.channel_id);
  assert.throws(() => videoUrl('web:https://evil.example/1234'));
});
