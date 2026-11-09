# Browser extension

Build with `npm run extension:build`. Load `dist/brave` as an unpacked
extension in Chrome. The directory name is historical; it is the Chromium build.
Firefox uses `dist/firefox`: open `about:debugging#/runtime/this-firefox`, click
**Load Temporary Add-on**, then select `dist/firefox/manifest.json`. The welcome
guide shows the profile-specific `moz-extension://...` connection address. Close
any old connector, run `npm start -- --configure`, and paste that exact address.
Allow MyTube's requested site permissions. ChatGPT sign-in and discovery now use
the companion; optional Google subscriptions remain Chromium-only. Temporary
installation lasts until Firefox closes; regular installation requires signing.
See [Mozilla's temporary installation guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

Normal discovery needs the local connector, a personal YouTube key and ChatGPT
sign-in. It does **not** require a Google OAuth client file. Google OAuth is
optional and used for subscriptions and legacy Google-authenticated features.

To enable subscriptions, follow [Google OAuth setup](DOT-GOOGLE-SETUP.md) with
your own public client ID. Never distribute someone else's configuration.
The ignored `google-client.json` accepts only a public `client_id`.

Preferences, channel bans, saved links and search history stay in the browser.
Update by rebuilding and reloading the existing extension; removing it can erase
that data. Reload the extension itself when permissions or CSP change.

Edit source files, never `dist/`. `npm test` rebuilds both packages and checks
the current product. Historical demo suites require separately retained data.

[Installation](../README.md) ? [Security](../SECURITY.md)
