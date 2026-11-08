// Confirmation UI delegates storage changes to explicit application actions.
export function bindHistoryControls({ document, isEnabled, enable, clear, sync }) {
  const $ = id => document.getElementById(id);
  let pending = null;
  function ask(disable) {
    pending = { disable };
    $('forget-history-title').textContent = disable ? 'Turn off history and clear it?' : 'Clear history on this device?';
    $('forget-history-dialog').showModal(); $('cancel-forget-history').focus();
  }
  function cancel() {
    const disable = pending?.disable;
    pending = null;
    $('forget-history-dialog').close(); sync();
    $(disable ? 'remember-interests' : 'clear-home').focus();
  }
  $('remember-interests').addEventListener('change', () => {
    if (!$('remember-interests').checked && isEnabled()) {
      $('remember-interests').checked = true;
      ask(true); return;
    }
    enable();
  });
  $('clear-home').addEventListener('click', () => ask(false));
  $('cancel-forget-history').addEventListener('click', cancel);
  $('forget-history-dialog').addEventListener('cancel', event => { event.preventDefault(); cancel(); });
  $('confirm-forget-history').addEventListener('click', () => {
    if (!pending) return;
    const { disable } = pending; pending = null;
    clear(disable);
    $('forget-history-dialog').close(); $(disable ? 'remember-interests' : 'clear-home').focus();
  });
}
