import { SafeError, validateApiKey } from './core.mjs';

// Masked echo only; no credential persistence or clipboard access. Memory zeroization is not guaranteed.
export async function readKey(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) throw new SafeError('INTERACTIVE_TERMINAL_REQUIRED');
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  input.setEncoding('utf8');
  output.write('Paste the API key VALUE, not its name. Characters appear as stars. Enter submits; Ctrl+C cancels.\nAPI key: ');
  return new Promise((resolve, reject) => {
    let value = '', finished = false, skipLF = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.setRawMode(wasRaw);
      input.pause();
      value = '';
      output.write('\n');
      if (error) reject(error); else resolve(result);
    };
    const onEnd = () => finish(new SafeError('INPUT_CLOSED'));
    const onError = () => finish(new SafeError('INPUT_ERROR'));
    const onData = text => {
      for (const char of text) {
        if (skipLF && char === '\n') { skipLF = false; continue; }
        skipLF = false;
        if (char === '\u0003') { finish(new SafeError('CANCELLED')); return; }
        if (char === '\r' || char === '\n') {
          if (!value.trim()) {
            value = ''; skipLF = char === '\r';
            output.write('\nNo key received. Paste the actual key value, then press Enter. Ctrl+C cancels.\nAPI key: ');
            continue;
          }
          try { finish(null, validateApiKey(value)); } catch (error) { finish(error); }
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length) { value = value.slice(0, -1); output.write('\b \b'); }
        }
        else if (char === '\u0015') { output.write('\b \b'.repeat(value.length)); value = ''; }
        else if (/^[A-Za-z0-9_ -]$/.test(char)) {
          value += char;
          output.write('*');
        } else { finish(new SafeError('INVALID_KEY_INPUT')); return; }
        if (value.length > 200) { finish(new SafeError('API_KEY_LENGTH_INVALID')); return; }
      }
    };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.resume();
  });
}
