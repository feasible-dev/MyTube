import { validateDiscoveryPlan } from './discovery.mjs';
import { LiveSearchError } from './youtube-live.mjs';
export function validateInterpretation(value) {
  const fail = () => { throw new LiveSearchError('INVALID_SEARCH_PLAN'); };
  const text = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f<>]/.test(v);
  if (!value || Object.keys(value).length !== 6 || !['ready', 'clarify'].includes(value.decision)
    || !text(value.search_intention, 3000) || !text(value.summary, 300) || !value.summary.trim()
    || !text(value.question, 300) || !Array.isArray(value.options) || value.options.length > 3
    || value.options.some(v => !text(v, 250) || !v.trim()) || new Set(value.options).size !== value.options.length) fail();
  if (value.decision === 'ready') {
    if (!value.search_intention.trim() || value.question || value.options.length || !value.plan) fail();
    validateDiscoveryPlan(value.plan);
  } else if (!value.question.trim() || value.plan !== null || value.search_intention) fail();
  return value;
}
