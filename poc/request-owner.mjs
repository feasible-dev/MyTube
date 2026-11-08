// A cancelled or superseded request must never publish into its successor.
export function createRequestOwner() {
  let active = null;
  function cancel() {
    const previous = active;
    active = null;
    previous?.abort();
  }
  return {
    get active() { return active !== null; },
    cancel,
    start() {
      cancel();
      const controller = new AbortController(); active = controller;
      const isCurrent = () => active === controller && !controller.signal.aborted;
      return {
        signal: controller.signal,
        isCurrent,
        finish() {
          if (!isCurrent()) return false;
          active = null; return true;
        },
      };
    },
  };
}
