import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assess } from './assessment.mjs';

const fixture = JSON.parse(await readFile(new URL('./synthetic-ratings.json', import.meta.url), 'utf8'));
const run = (lists = fixture.lists, ratings = fixture.ratings) => assess(lists, ratings, fixture.data_kind);

test('synthetic calculation matches independently specified totals and deltas', () => {
  const report = run();
  assert.equal(report.product_verdict, null);
  assert.equal(report.quality_evidence, 'NONE_SYNTHETIC_FIXTURE');
  const [a, b] = report.summaries;
  assert.equal(a.metrics.relevant.total, 7);
  assert.equal(a.metrics.want_to_watch.total, 5);
  assert.equal(a.mean_quality, 1.5);
  assert.equal(a.novel_count, 5);
  assert.equal(a.provisional_thresholds_met, true);
  assert.equal(b.metrics.relevant.total, 7);
  assert.equal(b.metrics.want_to_watch.total, 2);
  assert.equal(b.mean_quality, 0.5);
  assert.equal(b.novel_count, 10);
  assert.equal(b.provisional_thresholds_met, false);
  assert.deepEqual(report.comparisons[0].delta_keyword_minus_search,
    { relevant: 0, want_to_watch: -3, mean_quality: -1, novel_count: 5, short: 1 });
});
test('blank, omitted, and null judgments stay unknown; no false zero or comparison', () => {
  for (const blank of ['', null, undefined]) {
    const ratings = structuredClone(fixture.ratings);
    ratings[0].relevant = blank;
    const report = run(fixture.lists, ratings);
    assert.equal(report.summaries[0].metrics.relevant.total, null);
    assert.equal(report.summaries[0].metrics.relevant.observed, 9);
    assert.equal(report.summaries[0].provisional_thresholds_met, null);
    assert.equal(report.comparisons[0].delta_keyword_minus_search, null);
  }
  assert.equal(run(fixture.lists, []).summaries[0].fully_rated_rows, 0);
});
test('lists below ten and empty lists cannot pass even with perfect ratings', () => {
  for (const length of [0, 9]) {
    const lists = fixture.lists.map(list => ({ ...list, item_ids: list.item_ids.slice(0, length) }));
    const allowed = new Set(lists.flatMap(list => list.item_ids));
    const ratings = fixture.ratings.filter(r => allowed.has(r.item_id)).map(r => ({ ...r, relevant: 1, want_to_watch: 1, short: 0 }));
    for (const summary of run(lists, ratings).summaries) {
      assert.equal(summary.status, 'INSUFFICIENT_COVERAGE');
      assert.equal(summary.provisional_thresholds_met, null);
    }
  }
});
test('threshold boundaries independently reject low relevance, desire, or any Short', () => {
  for (const [index, field, value] of [[0, 'relevant', 0], [0, 'want_to_watch', 0], [0, 'short', 1]]) {
    const ratings = structuredClone(fixture.ratings); ratings[index][field] = value;
    assert.equal(run(fixture.lists, ratings).summaries[0].provisional_thresholds_met, false);
  }
});
test('out-of-range, fractional, nonnumeric and boolean judgments are rejected', () => {
  for (const value of [-1, 2, 0.5, NaN, Infinity, '1', true, '=1']) {
    const ratings = structuredClone(fixture.ratings); ratings[0].relevant = value;
    assert.throws(() => run(fixture.lists, ratings), /INVALID_RATING_VALUE/);
  }
  const ratings = structuredClone(fixture.ratings); ratings[0].perceived_quality = 3;
  assert.throws(() => run(fixture.lists, ratings), /INVALID_RATING_VALUE/);
});
test('duplicate or unknown ratings and malformed membership cannot inflate scores', () => {
  assert.throws(() => run(fixture.lists, [...fixture.ratings, fixture.ratings[0]]), /UNKNOWN_OR_DUPLICATE_RATING/);
  assert.throws(() => run(fixture.lists, [{ item_id: 'unknown' }]), /UNKNOWN_OR_DUPLICATE_RATING/);
  const lists = structuredClone(fixture.lists); lists[0].item_ids[1] = lists[0].item_ids[0];
  assert.throws(() => run(lists), /INVALID_LIST/);
  assert.throws(() => run([fixture.lists[0]]), /MISSING_COMPARISON_LIST/);
  assert.throws(() => run([...fixture.lists, fixture.lists[0]]), /DUPLICATE_LIST/);
});
test('rating order does not change calculations and unlabeled provenance is refused', () => {
  assert.deepEqual(run(fixture.lists, [...fixture.ratings].reverse()), run());
  assert.throws(() => assess(fixture.lists, fixture.ratings), /DATA_KIND_REQUIRED/);
});
