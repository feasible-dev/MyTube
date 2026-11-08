import { startConnector, EXTENSION_ID } from './server.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterpretationTask } from './interpretation-task.mjs';
const compact = { direct_subjects: ['THX Deep Note'], ...Object.fromEntries(['direct', 'adjacent', 'wildcard'].map(stream =>
  [stream, { queries: Array.from({ length: 4 }, (_, i) => `${stream === 'direct' ? 'THX Deep Note' : stream} angle ${i}`), why: 'A relevant viewing angle' }])) };
const response = value => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
test('interpretation returns a reusable validated plan or a clarification without a plan', () => {
  let accepted;
  const task = createInterpretationTask('Cinema sound, perhaps Dolby, falling then rising', value => { accepted = value; });
  const body = task.build('test-model');
  assert.equal(body.input[0].content, 'Cinema sound, perhaps Dolby, falling then rising');
  assert.equal(body.tools, undefined);
  const ready = { decision: 'ready', search_intention: 'Learn how the THX Deep Note was created', summary: 'The sound is probably THX Deep Note.', question: '', options: [], plan: compact };
  task.accept(task.validate(response(ready), 'test-model'));
  assert.equal(accepted.plan.queries.length, 12);
  assert.equal(accepted.plan.queries[0].query, 'THX Deep Note angle 0');
  const clarify = { decision: 'clarify', search_intention: '', summary: 'Two sounds could fit.', question: 'Do you mean THX or a Dolby trailer?', options: ['THX Deep Note', 'Dolby trailer'], plan: null };
  task.accept(task.validate(response(clarify), 'test-model')); assert.deepEqual(accepted, clarify);
  for (const bad of [{ ...ready, plan: null }, { ...clarify, question: '' }, { ...clarify, plan: compact }, { ...ready, options: ['guess'] }]) {
    assert.throws(() => task.validate(response(bad), 'test-model'), { message: 'INVALID_GENERATED_RESPONSE' });
  }
});

test('the protected interpretation route dispatches interpretation without retrieving videos', async () => {
  const clarification = { decision: 'clarify', search_intention: '', summary: 'Ambiguous sound', question: 'THX or Dolby?', options: [], plan: null };
  const server = await startConnector({ port: 0, signOut: async () => {},
    planner: async (intention, signal, authorize, preferences, recovery, mode) => {
      assert.equal(intention, 'Cinema sound'); assert.equal(mode, 'interpret'); return clarification;
    }, youtube: { search: () => assert.fail('No video lookup during interpretation') } });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/interpret`, { method: 'POST',
      headers: { Origin: `chrome-extension://${EXTENSION_ID}`, 'Content-Type': 'application/json', 'X-MyTube-Protocol': '1' },
      body: JSON.stringify({ intention: 'Cinema sound' }) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), clarification);
  } finally { await server.close(); }
});
