import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderSearchDetails } from './search-details.mjs';

function documentFixture() {
  return parseHTML('<html><body><div id="original-request"></div><div id="generated-searches"></div></body></html>').document;
}

test('diagnostics retain each column, retry, platform and timing without interpreting provider text as HTML', () => {
  const document = documentFixture();
  const untrusted = '<img src=x onerror=alert(1)>';
  const snapshot = { query: untrusted, loading: true, version: 'test', result: {
    videos: [], quick_query: 'First keywords',
    adjustments: [{ reason: 'NO_RESULTS', previous_queries: [{ query: 'Narrow keywords' }], queries: [{ query: 'Broader keywords' }] }],
    streams: {
      direct: { status: 'complete', videos: [{}], query: 'Direct keywords', why: untrusted, subjects: ['Subject alias'] },
      adjacent: { status: 'complete', videos: [], retry_reason: 'FEW_RESULTS', searches: [
        { query: 'Related keywords', candidates: 0, off_topic_filtered: 2 },
      ] },
      wildcard: { status: 'failed', error: 'TEST_ERROR', searches: [
        { query: 'Wildcard keywords', platforms: ['Rumble', 'Vimeo'], status: 'failed' },
      ] },
    }, timing_ms: { planning: 1500, first_results: 2500, total: 4000 },
  } };
  const before = JSON.stringify(snapshot);
  renderSearchDetails(document, snapshot, { TEST_ERROR: 'Provider unavailable' });
  assert.equal(document.getElementById('original-request').textContent, untrusted);
  assert.equal(document.querySelector('img'), null);
  const rows = [...document.querySelectorAll('.generated-search')];
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /Direct keywords/);
  assert.match(rows[0].textContent, /Subject alias/);
  assert.match(rows[1].textContent, /Another related query was tried/);
  assert.match(rows[1].textContent, /0 candidates after language and length filters/);
  assert.match(rows[1].textContent, /2 candidates excluded/);
  assert.match(rows[2].textContent, /Platforms searched: Rumble, Vimeo/);
  assert.match(rows[2].textContent, /Provider unavailable/);
  assert.match(document.querySelector('.search-adjustment').textContent, /Narrow keywords.*Broader keywords/);
  assert.match(document.querySelector('.search-timing').textContent, /First results: 2.5s/);
  assert.match(document.querySelector('.search-timing').textContent, /Elapsed: 4.0s/);
  assert.equal(JSON.stringify(snapshot), before);
});

test('reopening diagnostics replaces earlier contents and distinguishes pending from failed planning', () => {
  const document = documentFixture();
  renderSearchDetails(document, { query: 'First request', loading: true }, {});
  assert.match(document.getElementById('generated-searches').textContent, /Search details will appear/);
  renderSearchDetails(document, { query: 'Second request', error: 'QUOTA_EXCEEDED', version: 'test' }, {});
  const text = document.getElementById('generated-searches').textContent;
  assert.match(text, /QUOTA_EXCEEDED/);
  assert.match(text, /No completed search plan/);
  assert.doesNotMatch(text, /Search details will appear/);
  assert.equal(document.getElementById('original-request').textContent, 'Second request');
});
