# Recommended on Windows: protected key

Run `npm.cmd run key:setup`, or use **YouTube key ? Windows protection** in settings.
Paste into the native masked window and click **Encrypt and save**. See
[Windows storage](WINDOWS-KEY-STORAGE.md) for precedence, limitations and migration.
The instructions below describe the optional plaintext development fallback.

# Your local YouTube key

The key belongs on your computer, in `.secrets` at the project root. Never put
it in chat, an issue, a screenshot, a browser form, `google-client.json`, or a
GitHub commit. Agents must follow [AGENTS.md](AGENTS.md) and must not read it.

## Paste once

From this directory, on Windows:

Use **your own Windows terminal**, not an agent's isolated execution account.
Setup refuses to create or lock the real file from a Codex sandbox account.

```powershell
npm.cmd run secrets:edit
```

This creates the file if missing, removes inherited access and common broad
Windows access grants, grants your account and SYSTEM access, and opens Notepad.
If an existing file has custom grants to other accounts, review those in its
Windows Security properties. An existing file is preserved without
reading its contents. Paste your key after the equals sign on this line:

```dotenv
MYTUBE_YOUTUBE_API_KEY=
```

No quotes or spaces inside the key. Save and close Notepad. The connector reads
the file again on each new operation: editing the key does not require a rebuild
or restart once you have this connector version. Settings/history are separate.

Start the connector with `npm.cmd run connector` in **your own Windows terminal**,
under the same account as the secret file. Setup takes ownership for that account
and removes grants to Codex sandbox accounts left by earlier setup attempts.
An isolated sandbox connector cannot read this user-private file after those
grants are removed. An authorized agent launch under your actual Windows account
can run the connector normally without reading the file itself. For this version upgrade only,
stop the old connector with Ctrl+C, start the new one, and reload the extension
in chrome://extensions. A connector restart requires ChatGPT sign-in again.

The first search after clicking New search detects whether a key is configured.
ChatGPT first interprets the request and may ask for clarification. With a key,
each column uses one YouTube query combining alternatives with OR: at most
three initial search calls. After web discovery finishes, columns with fewer than
six selectable videos may each receive one additional single-angle search,
emptiest first, capped at five search calls total. Metadata requests are additional.
Separate web tasks search alternative platforms to supplement the third column. No candidate
count, final result count, or latency target is guaranteed.

Without a key, existing ChatGPT web discovery stays available. A quota/provider
failure before any API results also falls back to web discovery. Results already
received survive a later failure. No page scraping or quota-key rotation is used.

## Environment variable option

The connector also accepts `MYTUBE_YOUTUBE_API_KEY` from its process environment,
which takes precedence over `.secrets`. Have your secret manager set it when
launching the connector. Avoid typing a literal key into a shell command because
shell history can retain it. The file loader does not export secrets into the
global environment or inject them during the extension build.

## What leaves the computer

- Only the local Node connector reads the key. It sends it in the
  `X-Goog-Api-Key` HTTPS header to `https://www.googleapis.com/youtube/v3/`.
- The extension receives only metadata and fixed status/error codes. No route
  returns the key, environment, file contents, provider error text, or arbitrary
  proxy responses. Redirects are rejected and provider key echoes are rejected.
- The key is never passed to ChatGPT, bundled into JavaScript, placed in a URL,
  or intentionally written into application logs. The search text/preferences
  still go to the relevant providers as described in the application.
- `.gitignore` and `.npmignore` exclude secret files. Extension packaging uses a
  fixed six-file allowlist. Do not manually zip/upload the whole working folder,
  force-add ignored files, or put this folder in a public/shared sync directory.
- `.secrets` is plaintext with restricted file permissions, not an encrypted
  vault. Software running as you, administrators, and backups can still access
  it. A comment is an agent instruction, not an operating-system security boundary.

In Google Cloud, enable YouTube Data API v3 and restrict the key to **YouTube Data
API v3 only**. Server IP restrictions are optional if you have a stable public
outbound IP; browser-referrer restrictions do not fit this local Node transport.
Google controls quota and credential validity. This setup does not certify a
distributed bring-your-own-key model as compliant with YouTube policy.

## Another computer / unpacked extension ID

The connector trusts one exact Chrome extension ID, not all extensions. The
default is the existing local installation (`fagpjbnjdebnnhdgbkooeclhcbfjjakl`).
If another installation has a different ID, copy **its public ID** from
chrome://extensions and start the connector in that terminal with:

```powershell
$env:MYTUBE_EXTENSION_ID = 'the-32-letter-id-from-your-installed-extension'
npm.cmd run connector
```

This ID is not a secret. Do not use an arbitrary website origin. This change is
only for Chromium; Firefox support remains outside this local preview. The
current product build does not require historical sample datasets. See [README.md](README.md) for optional subscriptions OAuth. The key alone is not
a complete public distribution installer.

Localhost Host/Origin/protocol checks protect against ordinary websites, but a
process running under your account can impersonate HTTP headers. Never expose
port 43817 via a tunnel or bind it to a public interface.
