# MyTube release notes

## Clearer browser setup: 0.8.51

The welcome guide presents toolbar setup as three short numbered steps. Opening
MyTube stays prominent; keyboard shortcuts, bookmarks and troubleshooting move
into expandable sections. Firefox guidance no longer appears as a wall of text.

## Browser installation and access guide: 0.8.50

Added a standalone Install MyTube.html guide and browser-aware welcome instructions
for Chrome, Edge, Brave and Firefox. Users can open MyTube immediately, learn to
pin its icon, bookmark its page or use the suggested Alt+Shift+M shortcut. The
welcome guide offers connection-ID copying and opens troubleshooting when the
companion is unreachable. Settings links back to setup and browser access.

## Consistent card dimensions and blue icon: 0.8.49

All video cards reserve the same title, metadata and action-row space, removing
the extra height of wildcard cards. The extension icon now uses a navy play mark
on a pale blue tile in every size and browser package.

## Firefox companion support: 0.8.48

Firefox now uses its browser API, network permissions and exact profile-specific
extension origin for companion connection, ChatGPT sign-in and discovery. Setup
accepts and remembers the connection address shown in the welcome guide while
preserving strict Host and Origin checks. Browser history/preferences persist in
Firefox too. Optional Google subscriptions remain Chromium-only.

Distribution packaging emits a separate unsigned Firefox ZIP. An isolated real
Firefox smoke test exercises installation, loopback requests, synthetic discovery
and theme persistence without reading credentials. Real provider login/search and
Mozilla signing remain unverified/pending.

## Sun/moon theme switch: 0.8.47

Replaced the text theme button with a compact sun/moon switch and sliding circular
thumb on both pages. The switch exposes its state to screen readers, supports
keyboard activation and respects reduced-motion preferences.

## Light and dark appearance: 0.8.46

The main page and welcome guide now have a header button to switch between light
and dark themes. Light is the default until a choice is saved. Theme preference
persists independently of search history and synchronizes between open pages.
Cards, dialogs, settings and discovery status surfaces support both palettes.

## In-extension welcome and distribution candidate: 0.8.45

New installations open a packaged welcome guide; Extension options reopens it.
The guide checks the local companion, explains key setup, launches the protected
Windows key window, and supports ChatGPT sign-in with cancellation. Updates do
not reopen onboarding. The extension now has original packaged toolbar icons.

`npm run extension:package` creates a Chrome ZIP from verified generated assets,
without reading local Google registration or archiving the repository. It does
not publish anything or install the companion. The development preview still
requires Node.js, a running launcher and a configured extension ID.

## Setup guidance and quota clarity: 0.8.44

The native key window links directly to API enablement and key management. Setup
instructions consistently use Save key; Windows protection remains automatic.
The quick start and handbook distinguish the five-search-call ceiling from
metadata calls, explain the daily budget, and avoid guaranteeing result counts.

## One launcher: 0.8.43

Double-click MyTube.cmd to install on first use and start on later visits. Missing
or outdated dependencies/assets trigger setup or an update build; configured
installations skip key entry during updates. Chrome extension loading and the
one-time extension ID prompt remain explicit. The README now follows this flow.

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
