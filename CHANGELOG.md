# MyTube release notes

## Guided setup: 0.8.42

`npm run setup` installs dependencies, builds the extension and opens a guided
YouTube key window with a Google Cloud link and key-creation steps. Save key
automatically uses Windows protection. `npm start` asks for the extension ID once
and remembers it locally; no repeated environment-variable setup is required.

## Repository preparation: 0.8.41

Clean Chromium builds now enable normal discovery without a Google OAuth client
file. Identity permissions and Google OAuth remain optional for subscriptions.
Current installation and security guides replace contradictory historical notes.
An explicit release-file check excludes private configuration, local reports and
generated artifacts. Authorization browser helpers no longer inherit an
environment-provided YouTube API key.

## Windows-protected key storage: 0.8.40

Settings can open a native Windows masked key dialog, also available through
`npm run key:setup`. DPAPI CurrentUser protects the key outside the repository,
with private directory permissions and atomic encrypted-file replacement. The
browser never receives or submits the key. Explicit environment overrides remain
first, followed by protected storage, then the existing development .secrets file.
Existing plaintext files are not automatically read for migration or deleted.

## Adaptive sparse-column searches: 0.8.39

Keep three initial OR searches. Once API and web discovery finish, columns with
fewer than six selectable cards can receive one additional single-angle search
each, emptiest first. At most two top-ups and five YouTube search calls total.
Counts account for duplicate videos/titles and creator/platform limits. Prefer
unused planned angles, retain existing candidates, and stop on cancellation or
quota/key errors. Metadata and external web calls remain separate.

## OR budgets and alternative platforms: 0.8.38

YouTube discovery executes at most three search.list calls, one per column,
without repair searches. Direct queries use quoted subject aliases; other columns
combine two angles with OR. Metadata matches distribute candidates across angles
without treating lexical absence as proof of irrelevance. Existing duration,
language, bans, duplicate and creator limits remain. Metadata calls are separate.

BitChute, Rumble and Rutube have dedicated web tasks; a fourth searches Odysee,
Internet Archive, Vimeo and Dailymotion. Two workers execute these tasks, each
limited to two web tool calls. Odysee and movie-only Archive previews are supported.
Verified external discoveries rise above YouTube in the third column and rotate
platforms; late arrivals can therefore move earlier cards down.

## Earlier development

Earlier prototypes established the three-column UI, local history, channel bans,
query clarification and provider previews. Experimental modules remain under
spikes/ where the current connector or tests still depend on them. Current
behavior is described in README.md and SECURITY.md.
