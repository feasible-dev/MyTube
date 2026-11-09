import { readFile, readdir, lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Publication is opt-in: never inspect private files or depend on gitignore
// alone to decide what can leave the workstation.
export async function releaseFiles(root = new URL('../', import.meta.url)) {
  const files = ['.gitignore', '.npmignore', 'MyTube.cmd', 'Install MyTube.html', 'package.json', 'package-lock.json',
    'README.md', 'AGENTS.md', 'agents.markdown', 'SECURITY.md', 'CHANGELOG.md', 'LOCAL-SETUP.md', 'WINDOWS-KEY-STORAGE.md'];
  const historicalDocs = new Set(['connector/HISTORY.md', 'extension/CHANGELOG.md']);
  async function walk(folder) {
    for (const entry of await readdir(new URL(folder + '/', root), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'thumbnails'].includes(entry.name)) continue;
      const path = folder + '/' + entry.name;
      if (historicalDocs.has(path) || (folder.startsWith('spikes/') && entry.name.endsWith('.md'))) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(?:mjs|js|css|html|ps1|md)$/.test(entry.name) && entry.name !== 'index.html') files.push(path);
    }
  }
  for (const folder of ['connector', 'extension', 'poc', 'scripts', 'spikes']) await walk(folder);
  files.push('spikes/a2-extension-only/fixtures.json', 'spikes/b1-controlled-discovery/plan.json',
    'spikes/b1-youtube-candidates/intents.json', 'spikes/b1-youtube-candidates/synthetic-ratings.json');
  const suspicious = /AIza[\w-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{25,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
  for (const path of files) {
    const url = new URL(path, root), stat = await lstat(url);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe release file: ${path}`);
    if (suspicious.test(await readFile(url, 'utf8'))) throw new Error(`Review credential-like content in ${path}; content withheld.`);
  }
  return files.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const files = await releaseFiles();
    console.log(`Release allowlist checked: ${files.length} source, documentation and fixture files. No known credential patterns detected.`);
    console.log('Private storage, local Google configuration, reports, dependencies and generated packages are excluded. Nothing was uploaded.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
