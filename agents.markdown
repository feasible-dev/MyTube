# MyTube installation and agent handbook

This file contains the detailed setup, operating instructions and development rules.
The root README intentionally stays short. Follow the credential rules below before
examining or changing the workspace.

## Create a personal YouTube API key

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. Select the project. Open **APIs & Services > Library**, find **YouTube Data API v3**,
   and enable it.
3. Open **APIs & Services > Credentials > Create credentials > API key**.
   Use a standard API key, not a service account or OAuth client.
4. Edit the key. Under **API restrictions**, restrict it to **YouTube Data API v3**.
5. Website/referrer restrictions do not fit the local Node connector. An application
   IP restriction is possible with a stable public outbound IP; otherwise leave the
   application restriction unset while retaining the API restriction.
6. Never paste the key into chat, GitHub issues or screenshots. Each user supplies
   their own key. Check the project's quotas; one MyTube search can make multiple
   API calls. Do not rotate projects or keys to evade quota limits.

Provider references: [YouTube authentication](https://developers.google.com/youtube/data/guides/authentication)
and [API key management](https://docs.cloud.google.com/docs/authentication/api-keys).
Google Cloud menu wording can vary.

## Recommended launcher

After installing Node.js 22+, double-click MyTube.cmd in the extracted repository.
The launcher checks installed dependencies and built assets. On first use it runs
setup (dependency installation, build and guided native key window), then starts
the connector setup. The user still loads dist/brave in Chrome manually and pastes
the public extension ID once. Leave the launcher console open while using MyTube.

Later launches reuse installed dependencies, assets and the saved ID. After an
update, missing/mismatched dependencies or assets trigger installation and rebuild
without reopening key entry when a local extension ID is already saved. Reload
the extension after rebuilding. A second concurrent connector still reports a port
conflict; close the previous launcher before starting another. The launcher does
not change the trusted-origin policy or register a background Windows service.

The commands below remain available for developers and troubleshooting.

## Fresh installation

The supported development path is Windows with Chrome. Brave compatibility is not
fully verified; Firefox is an experimental package without live authentication.
Install Node.js 22 or newer, clone/download the repository into a stable private
folder, and open PowerShell there:

```powershell
npm.cmd run setup
```

The native Windows dialog has a masked field. Paste the key and click **Encrypt and
save**. Only **Key saved** confirms storage; merely opening
that window does not save a key or validate it with Google.

Windows DPAPI CurrentUser encrypts the key in
`%LOCALAPPDATA%\MyTube\Credentials\youtube-key.dpapi`, outside the repository.
The connector decrypts it in memory for Google requests. It is not sent to ChatGPT
or saved in the browser. No additional password is needed. Malware running under
the same user account can still access it.

With the connector running, settings **Connect YouTube** opens
the same dialog. Source precedence is explicit `MYTUBE_YOUTUBE_API_KEY` environment
override, then Windows-protected storage, then the optional development `.secrets`
fallback. Existing plaintext copies are neither migrated nor deleted automatically.
After confirming a successful search, the user can remove an old plaintext copy.
Updates preserve the protected key. See [Windows storage](WINDOWS-KEY-STORAGE.md)
and [development fallback](LOCAL-SETUP.md).

In `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and
select `dist/brave`. This historical directory name is also the Chrome package.
Copy its public 32-letter extension ID, then start the connector:

```powershell
npm.cmd start
```

Keep this terminal open. The first start asks for the extension ID and stores only
that public ID in ignored .mytube-local.json. Later starts reuse it. Use
npm start -- --configure to change it after moving/reinstalling the extension.
An explicit MYTUBE_EXTENSION_ID environment variable overrides the saved value.
The connector still accepts exactly one extension ID, never arbitrary origins.

Setup installs dependencies, builds the extension, and opens the native key window.
Saving automatically applies Windows protection; there is no encryption decision.
If the window is cancelled, a key has not been saved. Run npm run key:setup or use
Connect YouTube in settings to reopen it. Node.js and loading the unpacked extension
remain manual prerequisites. The Google Cloud steps are also shown in the window.

The lower-level npm run connector command remains available for development;
it uses MYTUBE_EXTENSION_ID or the existing development default, not the saved
npm start settings.

Normal discovery does not require a Google OAuth client file. **Subscriptions**
is optional and requires separate Google read-only OAuth configuration and consent.
A personal API key does not grant access to private subscriptions.

## First search and saved data

Open MyTube from the Chrome toolbar and click **New search**. Complete ChatGPT
sign-in when requested; the account must have access to the flow MyTube uses.
The YouTube key does not replace this login. Describe the request, click **Find
videos**, and answer any clarification with a suggested option or typed response.

Results arrive progressively in three columns. **Save for later** saves a link,
not a downloaded video. **Hide** hides a video. Channel bans persist separately.
**For you** uses previous searches, **Last search** restores the last results, and
**Past searches** retains requests when Remember is enabled.

History lives in per-browser IndexedDB without a rolling request-count limit.
Public video metadata expires after 30 days; request text persists until cleared.
The small working cache is not the full archive. Preferences and channel bans are
independent. Removing the extension or clearing browser storage can erase data.
No shared SQLite service is involved.

## Updates and troubleshooting

- Start one connector before using MyTube. Avoid launching a second instance.
- Update in the same directory. Reinstall dependencies, rebuild, reload the existing
  extension in `chrome://extensions`, and reopen its tab. Do not uninstall it.
- Restart the connector after connector changes; ChatGPT sign-in may be required
  again. Windows key storage and browser preferences remain intact.
- **Port in use:** stop the old connector with Ctrl+C. If necessary, identify the
  exact listener on loopback port 43817; never terminate every Node process.
- **Missing /interpret or version mismatch:** restart the updated connector.
- **CSP image errors:** reload the extension itself, not just its tab. Clear old
  browser errors and inspect only newly recurring messages without secrets.
- **Access denied:** check the installed extension ID and MYTUBE_EXTENSION_ID.
- **Key errors:** check API enablement and restrictions, then rerun key:setup.
- **Quota exhausted:** check Google Cloud quotas. Web fallback may be available,
  but neither result count nor latency is guaranteed.

For a realistic fresh-install test, use a separate Windows account and a fresh
clone. A new Chrome profile alone still shares the Windows user's protected key.
Verify sign-in, one search, thumbnails, reopening the last page, and persistence
of preferences after reloading. Offline tests cannot establish these live results.

## Developer commands

| Command | Purpose |
| --- | --- |
| `npm.cmd run setup` | Install dependencies, build and open guided key setup |
| `npm.cmd start` | Remember the extension ID once and start the connector |
| `npm.cmd test` | Build and run current product checks without historical datasets |
| `npm.cmd run release:check` | Validate the publication allowlist and common credential patterns |
| `npm.cmd run extension:build` | Build packages without claiming tests passed |
| `npm.cmd run test:connector` | Connector, discovery and authentication-window tests |
| `npm.cmd run check:extension` | Focused checks including historical UI fixtures |
| `npm.cmd run test:all` | Product, experiments and legacy demo; may need historical datasets |
| `npm.cmd run connector` | Run the local connector; Ctrl+C stops it |

The verification runner records scope, counts and artifact hashes in
`results/extension-build.json`. Failures, skipped checks or changed artifacts
prevent success. Tests use synthetic inputs and local fixtures, not provider
accounts or quotas. Clean-build checks omit Google configuration and historical
media. Legacy model/UI checks remain separate from the current product suite.
Keep tests at their owning layer; add a regression for a distinct failure rather
than duplicating assertions. Never delete useful tests just to reduce the count.

## Repository and known limits

- `poc/`: shared UI, lifecycle, filtering, storage and historical demo.
- `extension/`: browser bridge, provider clients, discovery and packaging.
- `connector/`: loopback API, private-key transport and in-memory ChatGPT session.
- `spikes/`: experiments; some protocol helpers remain runtime dependencies.
- `scripts/`: build, setup and verification utilities.
- `dist/`: generated packages. Edit source, not these files.
- `results/`: local verification/experiment outputs, excluded from publication.
- `.private/`: installation-specific registration data; never publish.

Discovery targets, retrieved candidate counts and visible page sizes differ.
Scrolling reveals received results rather than guaranteeing new provider calls.
Public metadata checks do not prove semantic relevance, accuracy or continued
playback availability. Synthetic-production filtering uses explicit disclosures;
it cannot reliably detect undisclosed AI-generated video or voice.

See [security](SECURITY.md), [connector operation](connector/README.md),
[extension notes](extension/README.md) and [release history](CHANGELOG.md).
Package.json supplies the release version; keep the lockfile synchronized.
Documentation-only changes need no version bump or connector restart.

## Mandatory agent rules

# Private credentials

- Do not, under any circumstance, read the content of `.secrets`, `.secrets.*`,
  `.env`, `.env.*`, or credential/token files in `.private/`.
- Do not print, search, copy, hash, inspect, or transmit real secret values,
  including via shell environment dumps, debugger state, screenshots or logs.
- Exclude these files from repository-wide searches and from uploads/archives.
- The local connector may read `.secrets` at runtime for its intended API calls.
  Agents may run the documented setup and fixed-status checks, which never
  return credential values. Test only with synthetic credentials in temporary files.
- Never place credentials in browser code, manifests, generated artifacts,
  ChatGPT prompts, error messages, or source control. Do not ask users to paste
  credentials into chat. Do not overwrite an existing secret file.
- Windows DPAPI store: never inspect `%LOCALAPPDATA%/MyTube/Credentials` or run
  `scripts/windows-key.ps1 -Mode Read` as a tool/diagnostic. That internal mode
  returns plaintext exclusively to the runtime connector through a private pipe.
  `RoundTripTest` uses only an in-memory synthetic key; `key:setup` opens the user's
  masked native dialog. Never automate typing, reading or screenshotting its key.
- Do not create or restrict the real `.secrets` using a Codex sandbox account.
  Run setup and the connector under the user's Windows account. Tests must use
  synthetic temporary files. Never grant a sandbox account access to a real key
  to work around access failures; report only fixed status codes.


# Product and distribution contract

- The goal is an extension-first personal installation, not a shared SQLite
  service. Keep per-browser storage unless the user explicitly changes this scope.
- README.md is the short quick start; agents.markdown holds detailed instructions. Keep both accurate and
  distinguish present capabilities from installer work still to be done.
- A personal YouTube API key enables public metadata/search through the connector.
  ChatGPT interpretation/login is separate; subscriptions need separate Google
  read-only OAuth consent. Do not imply one credential enables all three.
- Current delivery is a development preview requiring Node >=22, a running local
  connector, and an unpacked extension. Do not describe it as one-click installation.
- Do not ask friends to share the owner's key, private registration, account data,
  or developer OAuth identity. A distributed personal-key arrangement is not an
  automatic exemption from provider terms or quota rules.

# Fresh-install blockers and preparation

1. Build with `npm.cmd ci --ignore-scripts --no-audit --no-fund` then
   `npm.cmd run extension:build`. Generated packages live in dist/brave and
   dist/firefox. The brave directory is also used by Chrome.
2. Inspect source and sanitized manifest capabilities, never secret files.
   Chromium network permissions must work without extension/google-client.json.
   Only optional Google identity permissions and subscriptions OAuth depend on it.
   Do not fabricate a client ID or ship the owner's local Google configuration.
3. The unpacked extension ID may differ by computer/path. The connector's default
   trusted ID is for the development installation. Set nonsecret
   MYTUBE_EXTENSION_ID to the actual installed 32-letter ID for each launch.
   Never relax the exact Origin/Host checks or allow wildcard origins as a shortcut.
4. Runtime ChatGPT registration is handled by connector/session.mjs; never ship
   .private registration data from another user. Do not assume successful offline
   tests prove a new user's account has provider access.
5. Validate fresh installation without private experiment data using `npm.cmd test`.
   Then verify actual sign-in, one search, received thumbnails, and persistence in
   the target browser. State explicitly which live steps were not verified.

# Runtime operations and troubleshooting

- A UI rebuild does not restart the connector. Refreshing a tab does not reload
  the extension manifest. Explain which of these operations is required.
- When authorized to fix a running connector, identify the listener on loopback
  port 43817 and verify its process identity before stopping it. Do not kill all
  Node processes. Prefer graceful shutdown. Never print process command lines or
  environments that could contain credentials.
- Start the connector under the user's Windows account, not CodexSandbox. An
  authorized elevated tool invocation can be used if it actually runs as that
  user. Do not modify secret ACLs to make an isolated process work.
- Background Windows launches must use Start-Process -WindowStyle Hidden. Do not
  open extra visible terminals unless the user wants them.
- Verify startup using OPTIONS /interpret, /connect and /youtube/status on
  http://127.0.0.1:43817 with the exact installed extension Origin and
  Access-Control-Request-Method: POST. Expect 204. This checks route availability
  without searching or reading credentials; it does not verify key validity/login.
- A 404 on /interpret means the running connector lacks that capability, not an
  arbitrary package-version mismatch. A port conflict means another listener is
  still running; inspect before acting. Restart clears ChatGPT memory session.
- If user consent is needed, ask for that specific step; do authorized mechanical
  work yourself. Preserve drafts, preferences and history during troubleshooting.

# Code map and verification

- poc/: shared UI, dialogs, cards, preference/history stores. Full history uses
  search-archive.mjs (IndexedDB); home.mjs is only a bounded working cache.
- extension/: browser bridge, interpretation/discovery, YouTube metadata, provider
  previews, CSP and build. External-preview changes also affect the connector.
- connector/: loopback server, private-key transport, in-memory ChatGPT sessions.
- scripts/: build/test workflow. dist/: generated outputs, never edit directly.
- `npm.cmd test`: current product build/checks, independent of historical inputs.
- `npm.cmd run test:all`: includes historical demo/experiments and may require
  private local datasets. Do not publish those datasets to make a clean clone pass.
- `npm.cmd run check:extension`: focused checks including historical UI fixtures.
- Add meaningful regressions for behavior, cancellation and migration. Keep tests
  at their owning layer; do not duplicate entire scenarios at every layer.
- Runtime changes: bump package and lockfile with
  `npm.cmd version patch --no-git-tag-version --ignore-scripts`, rebuild and verify.
  Documentation-only changes do not require a version bump or connector restart.
- Keep HTML CSP, manifest CSP, host permissions and image validation in agreement.
  Validate real provider metadata/image retrieval when fixing thumbnail behavior;
  mocked tests alone cannot establish that a provider endpoint works.
- Provider video metadata expires after 30 days; search text persists until erased.
  Preserve independently stored preferences and banned channels across updates.
- No publication, uploads, deployment, or distribution of the working directory
  is implied by a request to edit documentation. Review a clean release allowlist
  before any separately authorized sharing action.
