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
- README.md is the user-facing Windows/Chrome setup guide. Keep it actionable and
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
