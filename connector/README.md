# Local connector

The Node.js connector listens only on `127.0.0.1:43817`. Start it with
`npm run connector`; stop it with Ctrl+C. Set `MYTUBE_EXTENSION_ID` to your
installed Chromium extension ID. See the [installation guide](../README.md).

## Responsibilities

- Interpret requests with ChatGPT and ask for clarification when needed.
- Search YouTube with the user's key; return public video metadata, never the key.
- Search alternative video platforms and retrieve bounded public previews.
- Keep ChatGPT tokens in memory. Local registration metadata lives in ignored
  `.private/`; do not distribute it to other users.
- Open the native Windows key dialog through an empty, authenticated-origin setup
  request. The key itself never passes through that HTTP endpoint.

YouTube search starts with one OR query per column. Once the initial API and web
work finishes, columns with fewer than six selectable cards can receive one
extra single-angle search each, emptiest first. Maximum: five YouTube search
calls per operation. Metadata calls and ChatGPT web searches are additional.

Four external-search groups cover BitChute, Rumble, Rutube, and a combined
Odysee/Internet Archive/Vimeo/Dailymotion group. Two tasks run concurrently;
each allows at most two web-tool calls. Availability and result quality vary.

## Boundaries

Exact Host and extension Origin checks, JSON schemas, request IDs, deadlines,
response-size limits and fixed provider endpoints constrain requests. This is
not an internet-facing server. Do not expose its port through a tunnel.
A local process running as the user can imitate HTTP headers.

[Security](../SECURITY.md) ? [Windows keys](../WINDOWS-KEY-STORAGE.md) ?
[Release history](../CHANGELOG.md)
