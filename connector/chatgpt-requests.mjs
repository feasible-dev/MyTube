import { PLAN_RECOVERY_REASONS } from '../extension/plan-errors.mjs';
import { validatePreferences } from '../extension/preferences.mjs';
import { validateIntention } from './task.mjs';

export function parseChatGPTRequest(path, body, validRequestId) {
  if (!body || Array.isArray(body) || typeof body !== 'object') return null;
  if (path === '/connect') return validRequestId && !Object.keys(body).length ? { type: 'connect' } : null;
  if (path === '/signout') return Object.keys(body).length ? null : { type: 'signout' };
  const mode = path === '/interpret' ? 'interpret' : path === '/plan' ? 'plan' : path === '/web-discover' ? 'web' : path === '/wildcard-discover' ? 'wildcard' : null;
  if (!mode || !Object.keys(body).every(key => ['intention', 'preferences', 'recovery'].includes(key))
    || !Object.hasOwn(body, 'intention')
    || (Object.hasOwn(body, 'recovery') && !PLAN_RECOVERY_REASONS.includes(body.recovery))) return null;
  return { type: 'search', mode, intention: validateIntention(body.intention),
    preferences: validatePreferences(body.preferences), recovery: body.recovery };
}
