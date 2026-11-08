import { MODEL, STREAMS } from './core.mjs';

// Synthetic parser/transport fixtures only. Never interpreted as model evidence or user ratings.
export function generatedFixture(reference) {
  return { underlying_interests: ['Engineering failure analysis', 'Institutional decision making', 'Historical technical investigation'],
    streams: Object.fromEntries(STREAMS.map((s, i) => [s, {
      objective: `${s} synthetic discovery objective`, connection: 'Synthetic connection for validating structure only',
      queries: reference.intents[i].queries.map(query => ({ query,
        why: 'Synthetic explanation for testing only', interest_index: i })),
    }])) };
}
export function responseFixture(generated) {
  return { object: 'response', status: 'completed', model: MODEL, error: null, incomplete_details: null,
    output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(generated) }] }],
    usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 } };
}
