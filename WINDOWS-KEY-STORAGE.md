# Windows-protected YouTube key

Implemented in 0.8.40. Run `npm.cmd run key:setup` from your Windows account,
or click **Connect YouTube** in MyTube settings with the connector
running. Paste into the native masked window, then **Save key**. The
window confirms success; opening it does not mean a key was saved or validated by Google.

## Storage and transport

Windows DPAPI CurrentUser encrypts the key using the current Windows account.
The encrypted file is `%LOCALAPPDATA%\MyTube\Credentials\youtube-key.dpapi`,
outside the repository and extension. The credential directory allows only the
current account and SYSTEM, with inheritance disabled. Writes use an encrypted
temporary file and atomic replacement; no plaintext temporary file or backup.
The setup refuses Codex sandbox identities and reparse points on its store paths.
Updates do not remove this user-data directory.

The browser endpoint accepts only an empty setup request and returns an opened
status. It cannot accept or return a key or a filesystem path. Existing exact
loopback Host, extension Origin, protocol and request-ID checks apply. The native
helper supplies decrypted bytes through a private child-process pipe to the
connector. Do not run its Read mode manually or through an agent: stdout on that
internal mode contains the key. No key in command arguments, HTTP setup requests,
ChatGPT prompts, browser storage, logging or generated bundles.

The bundled PowerShell helper runs without profiles, with process-only execution
policy Bypass; it does not change the user's or machine's execution policy.
Organization-enforced policy can still prevent it from running. This preview
requires Windows PowerShell/.NET; non-Windows users retain the development fallback.

## Precedence and migration

1. Explicit `MYTUBE_YOUTUBE_API_KEY` environment override for development.
2. Windows-protected key, if present.
3. Existing `.secrets` development fallback if no protected key exists.

A corrupt or inaccessible protected file fails closed instead of silently using
another key. The real `.secrets` is never migrated or deleted automatically.
Paste the key yourself into the native window. After a successful search, remove
your old plaintext copy yourself if you no longer need it. Saving a replacement
key takes effect on the next operation; no connector restart is needed.

## Limits and verification

DPAPI protects a copied file; it does not protect against malware running as the
same Windows user or an administrator controlling the session. The connector
needs the plaintext in memory to contact Google; JavaScript cannot guarantee
complete memory erasure. Restrict the key to YouTube Data API v3 in Google Cloud.
Do not copy the encrypted file as a portable key for friends or another account.

Regression checks cover a real native DPAPI round trip using a synthetic key,
source precedence, fail-closed behavior and the setup endpoint access controls.
The user's key is never read by agent tools or included in tests. Native setup
and an actual Google request still require the user's installation check.

Reference: [Microsoft DPAPI / ProtectedData](https://learn.microsoft.com/en-us/dotnet/standard/security/how-to-use-data-protection).
