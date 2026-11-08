import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderVideoCard } from './video-card.mjs';

test('isolated cards render untrusted titles as text and delegate actions without application globals', () => {
  const { document } = parseHTML('<html><body></body></html>');
  const video = { video_id: 'abcdefghijk', title: '<img src=x onerror=alert(1)>',
    channel: 'History', source: 'youtube_web', discovery_stream: 'wildcard', duration_seconds: null };
  let saved = false; const actions = [];
  const card = renderVideoCard(document, video, {
    saved, persistent: true, onSave: v => { assert.equal(v, video); actions.push('save'); return saved = !saved; },
    onHide: v => { assert.equal(v, video); actions.push('hide'); },
    onBan: v => { assert.equal(v, video); actions.push('ban'); },
  });
  assert.equal(card.querySelector('.video-title').textContent, video.title);
  assert.equal(card.querySelector('.video-title img'), null);
  assert.equal(card.querySelector('.duration-badge'), null);
  assert.equal(card.querySelector('.wildcard-joker'), null);
  const save = card.querySelector('.save-video');
  assert.equal(save.textContent, 'Save for later');
  assert.ok(save.classList.contains('outline-button'));
  assert.match(save.title, /No video download/);
  assert.equal(card.querySelector('.hide-video').textContent, 'Hide');
  save.click(); assert.equal(save.getAttribute('aria-pressed'), 'true');
  save.click(); assert.equal(save.getAttribute('aria-pressed'), 'false');
  card.querySelector('.hide-video').click(); card.querySelector('.ban-channel').click();
  assert.deepEqual(actions, ['save', 'save', 'hide', 'ban']);
  for (const link of card.querySelectorAll('a')) {
    assert.equal(link.getAttribute('href'), 'https://www.youtube.com/watch?v=abcdefghijk');
    assert.equal(link.rel, 'noopener noreferrer');
  }
});

test('external thumbnails render while untrusted image URLs fall back to a placeholder', () => {
  const { document } = parseHTML('<html><body></body></html>');
  const v = { video_id: 'web:https://vimeo.com/123', source_url: 'https://vimeo.com/123',
    source: 'external_web', platform: 'Vimeo', title: 'Film discussion', channel: 'Vimeo',
    thumbnail_url: 'https://i.vimeocdn.com/video/123.jpg' };
  const card = renderVideoCard(document, v, {});
  assert.equal(card.querySelector('.cover img').src, v.thumbnail_url);
  card.querySelector('.cover img').dispatchEvent(new document.defaultView.Event('error'));
  assert.equal(card.querySelector('.cover img'), null);
  assert.equal(card.querySelector('.cover-placeholder').textContent, 'Thumbnail unavailable');
  const rejected = renderVideoCard(document, { ...v, thumbnail_url: 'https://evil.example/image' }, {});
  assert.equal(rejected.querySelector('.cover img'), null);
});
