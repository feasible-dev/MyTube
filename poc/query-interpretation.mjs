import { createRequestOwner } from './request-owner.mjs';

export function createQueryInterpretation({ document, getProvider, messages, onAnswerStart = () => {}, onAnswerEnd = () => {} }) {
  const $ = id => document.getElementById(id), requests = createRequestOwner();
  let clarification = null;
  let timer = null;
  let background = false, ignoreClose = false;
  function stopTimer() { if (timer !== null) clearInterval(timer); timer = null; }
  function controls(busy) {
    $('clarification-answer').disabled = busy;
    for (const button of $('clarification-options').querySelectorAll('button')) button.disabled = busy;
    $('query-form').setAttribute('aria-busy', String(busy));
    $('interpretation-status').classList.toggle('analysis-active', busy);
    $('submit-query').hidden = busy;
    $('submit-query').textContent = clarification ? 'Continue' : 'Find videos';
  }
  function cancel() {
    const wasBusy = requests.active; requests.cancel();
    stopTimer(); controls(false);
    if (wasBusy) { $('query-input').disabled = false; $('submit-query').disabled = false; }
    $('interpretation-status').hidden = true;
    if (background) { background = false; onAnswerEnd(); }
  }
  function reset() {
    cancel(); clarification = null; $('query-clarification').hidden = true;
    controls(false);
    $('clarification-answer').value = ''; $('clarification-options').replaceChildren();
  }
  for (const id of ['close-query', 'cancel-query', 'new-search']) $(id).addEventListener('click', reset);
  $('query-dialog').addEventListener('cancel', reset);
  $('query-dialog').addEventListener('close', () => {
    if (ignoreClose) { ignoreClose = false; return; }
    reset();
  });
  $('query-input').addEventListener('input', reset);
  return {
    get busy() { return requests.active; },
    cancel: reset,
    async prepare(query, preferences) {
      if (requests.active) return null;
      const answer = $('clarification-answer').value.trim();
      if (clarification && !answer) { $('query-error').textContent = 'Choose an option or write a short answer.'; return null; }
      const input = clarification ? `${clarification.context}\n\nClarification question: ${clarification.question}\nUser answer: ${answer}` : query;
      if (input.length > 6000 || new TextEncoder().encode(input).length > 8000) {
        $('query-error').textContent = 'Please shorten your description or answer.'; return null;
      }
      const request = requests.start();
      $('query-error').textContent = ''; $('query-input').disabled = true; $('submit-query').disabled = true;
      controls(true);
      $('interpretation-status').hidden = false;
      const started = Date.now(), answering = Boolean(clarification);
      if (answering) {
        background = true;
        ignoreClose = $('query-dialog').hasAttribute('open');
        $('query-dialog').close();
        onAnswerStart(query);
      }
      const progress = () => {
        $('interpretation-status').textContent = `Analyzing your request... Please wait. ${Math.floor((Date.now() - started) / 1000)}s`;
      };
      progress(); timer = setInterval(progress, 1000);
      try {
        const result = await getProvider().interpret(input, request.signal, preferences);
        if (!request.isCurrent()) return null;
        if (result.decision === 'ready') { reset(); return result; }
        clarification = { ...result, context: input };
        $('query-clarification').hidden = false;
        $('clarification-question').textContent = result.question;
        $('clarification-answer').value = '';
        $('clarification-options').replaceChildren();
        for (const option of result.options) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'outline-button'; button.textContent = option;
          button.addEventListener('click', () => {
            if (requests.active) return;
            $('clarification-answer').value = option; $('query-form').requestSubmit();
          });
          $('clarification-options').append(button);
        }
        $('clarification-answer').focus();
        if (background) { background = false; onAnswerEnd(); $('query-dialog').showModal(); $('clarification-answer').focus(); }
        return null;
      } catch (error) {
        if (request.isCurrent()) {
          $('query-error').textContent = messages[error?.code] ?? 'Could not interpret your request. Please try again.';
          if (background) { background = false; onAnswerEnd(); $('query-dialog').showModal(); }
        }
        return null;
      } finally {
        if (request.finish()) {
          stopTimer(); controls(false);
          $('query-input').disabled = false; $('submit-query').disabled = false;
          $('interpretation-status').hidden = !clarification || Boolean($('query-error').textContent);
          if (clarification) $('interpretation-status').textContent = 'Waiting for your answer. Click an option to continue immediately, or type below and click Continue.';
        }
      }
    },
  };
}
