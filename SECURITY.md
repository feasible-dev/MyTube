# Security model

MyTube is a personal development preview, not an independently audited product.
It uses a local connector and an unpacked browser extension. Do not expose the
connector to the internet or distribute a working directory containing user data.

## Credentials

- YouTube keys can be stored with Windows DPAPI CurrentUser, outside the repository.
  The native masked dialog keeps the key out of browser requests and storage.
- The connector decrypts the key in memory and sends it only to fixed Google
  HTTPS endpoints, in a request header. No keys in URLs, prompts or logs.
- An explicit environment key overrides DPAPI; a plaintext `.secrets` is an
  optional development fallback. Existing plaintext copies are not auto-deleted.
- ChatGPT tokens remain in connector memory. Registration metadata in `.private/`
  is installation-specific and must not be shared. Subscriptions use separate
  Google consent; a YouTube API key does not authorize access to subscriptions.
- DPAPI does not stop malware running as the same account or an administrator
  controlling that account. JavaScript cannot guarantee complete memory erasure.

See [Windows key storage](WINDOWS-KEY-STORAGE.md) for implementation and limits.

## Local API and provider access

The connector binds to loopback and requires the exact configured extension
Origin, expected Host, protocol headers and bounded typed requests. Setup accepts
no key or arbitrary path. A local process can imitate these headers; this is a
browser-origin boundary, not authentication against other programs on the PC.

Provider access uses fixed origins and validated video identifiers, bounded
responses, timeouts and cancellation. Redirects, returned embed HTML and arbitrary
model-supplied endpoints are not executed. Provider errors are reduced to fixed
codes. Thumbnail URLs must match the provider allowlist. CSP and manifest host
permissions restrict browser network access; no remote scripts or content scripts.

## Local data and limitations

Search history, requests, saved/hidden choices and channel bans remain on the
device. Video metadata expires after 30 days; saved request text remains until
cleared. Preferences and channel bans are stored independently. Removing the
extension or clearing its browser storage can erase these records.

User requests and chosen viewing preferences are sent to ChatGPT; searches are
sent to the selected providers. Displaying remote thumbnails contacts their CDNs.
Public metadata verification does not prove relevance, accuracy, ownership or
continued playback availability. Source platforms do not certify political views.

## Sharing and verification

Run `npm test` and `npm run release:check` before sharing. The release check uses
an explicit source allowlist and checks common credential patterns without reading
private files. It is a guardrail, not proof that every possible secret is detected.
Never publish `.private/`, `.secrets*`, `.env*`, DPAPI blobs, local Google config,
logs, generated previews, datasets or copied browser storage.

Report vulnerabilities privately to the repository owner. Do not paste credentials
or personal logs into a public issue. If a credential was exposed, revoke it at
its provider; deleting a file or commit is not sufficient.
