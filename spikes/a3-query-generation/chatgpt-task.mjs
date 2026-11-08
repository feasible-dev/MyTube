import { Failure } from '../a1-openai-login/protocol.mjs';
import { QueryError, SCHEMA, INTENTION, INSTRUCTIONS, validateGenerated } from './core.mjs';

export function chatgptRequest(model) {
  return { model, store: false, stream: true, instructions: INSTRUCTIONS,
    input: [{ role: 'user', content: INTENTION }],
    text: { format: { type: 'json_schema', name: 'mytube_discovery_queries', strict: true, schema: structuredClone(SCHEMA) } } };
}

export function validateChatgptResponse(response, model, validateOutput = validateGenerated) {
  try {
    if (response?.status !== 'completed' || response.error != null || response.incomplete_details != null
      || !Array.isArray(response.output) || response.output.length < 1 || response.output.length > 8) throw new Failure('INFERENCE_INCOMPLETE');
    // The OAuth route may omit envelope metadata, but an explicit mismatch is rejected.
    if (response.model !== undefined && response.model !== model) throw new Failure('UNEXPECTED_MODEL');
    const messages = [];
    for (const item of response.output) {
      if (item?.type === 'reasoning') continue;
      if (item?.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed'
        || !Array.isArray(item.content)) throw new Failure('UNEXPECTED_OUTPUT_TYPE');
      if (item.content.some(c => c?.type === 'refusal')) throw new Failure('MODEL_REFUSAL');
      messages.push(item);
    }
    if (messages.length !== 1 || messages[0].content.length !== 1
      || messages[0].content[0]?.type !== 'output_text') throw new Failure('INVALID_RESPONSE_OUTPUT');
    const text = messages[0].content[0].text;
    if (typeof text !== 'string' || Buffer.byteLength(text) > 32768) throw new Failure('GENERATED_TEXT_TOO_LARGE');
    let value;
    try { value = JSON.parse(text); } catch { throw new Failure('INVALID_GENERATED_JSON'); }
    const generated = validateOutput(value);
    const usage = response.usage, fields = ['input_tokens', 'output_tokens', 'total_tokens'];
    const validUsage = fields.every(k => Number.isSafeInteger(usage?.[k]) && usage[k] >= 0)
      && usage.total_tokens === usage.input_tokens + usage.output_tokens;
    return { generated, usage: validUsage ? Object.fromEntries(fields.map(k => [k, usage[k]])) : null };
  } catch (error) {
    if (error instanceof QueryError) throw new Failure(error.message);
    if (error instanceof Failure) throw error;
    throw new Failure('INVALID_GENERATED_RESPONSE');
  }
}
