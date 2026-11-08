import { QueryError, validateKey } from './core.mjs';

// Separate from the immutable B1 Google-key input: OpenAI keys may be longer.
export async function readOpenAIKey(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) throw new QueryError('INTERACTIVE_TERMINAL_REQUIRED');
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  input.setEncoding('utf8');
  output.write('Paste your OpenAI API key VALUE (sk-...), not a Google key or ChatGPT password.\nCharacters appear as stars. Enter authorizes the one request described above; Ctrl+C cancels.\nOpenAI API key: ');
  return new Promise((resolve, reject) => {
    let value = '', finished = false, skipLF = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      input.off('data', onData); input.off('end', onEnd); input.off('error', onError);
      input.setRawMode(wasRaw); input.pause(); value = ''; output.write('\n');
      if (error) reject(error); else resolve(result);
    };
    const onEnd = () => finish(new QueryError('INPUT_CLOSED'));
    const onError = () => finish(new QueryError('INPUT_ERROR'));
    const onData = text => {
      for (const char of text) {
        if (skipLF && char === '\n') { skipLF = false; continue; }
        skipLF = false;
        if (char === '\u0003') { finish(new QueryError('CANCELLED')); return; }
        if (char === '\r' || char === '\n') {
          if (!value.trim()) {
            value = ''; skipLF = char === '\r';
            output.write('\nNo key received. Paste the API key value, or Ctrl+C to cancel.\nOpenAI API key: '); continue;
          }
          try { finish(null, validateKey(value)); } catch (error) { finish(error); }
          return;
        }
        if (char === '\u007f' || char === '\b') { if (value.length) { value = value.slice(0, -1); output.write('\b \b'); } }
        else if (char === '\u0015') { output.write('\b \b'.repeat(value.length)); value = ''; }
        else if (/^[A-Za-z0-9_ -]$/.test(char)) { value += char; output.write('*'); }
        else { finish(new QueryError('INVALID_KEY_INPUT')); return; }
        if (value.length > 512) { finish(new QueryError('INVALID_OPENAI_KEY_FORMAT')); return; }
      }
    };
    input.on('data', onData); input.once('end', onEnd); input.once('error', onError); input.resume();
  });
}
