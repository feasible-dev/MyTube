import { createRequestOwner } from './request-owner.mjs';

// One owner for a page's active search. Providers may settle after cancellation;
// only the current request may publish results or run completion side effects.
export function createSearchLifecycle({ state, changed, errorCode }) {
  const requests = createRequestOwner();
  const cancel = (error) => {
    state.loading = false;
    if (error !== undefined) state.liveError = error;
    requests.cancel();
  };
  return {
    get active() { return requests.active; },
    cancel,
    async run(execute, { partial = () => {}, complete = () => {} } = {}) {
      cancel();
      const request = requests.start();
      const current = request.isCurrent;
      state.loading = true; state.stage = 'planning'; state.liveError = null; changed();
      try {
        const result = await execute(request.signal, stage => {
          if (!current()) return;
          state.stage = stage; changed();
        }, result => {
          if (!current()) return;
          partial(result); state.liveResult = result; changed();
        });
        if (!current()) return;
        state.liveResult = result; state.liveError = result.warning ?? null;
        complete(result);
      } catch (error) {
        if (current()) state.liveError = errorCode(error);
      } finally {
        if (request.finish()) { state.loading = false; changed(); }
      }
    },
  };
}
