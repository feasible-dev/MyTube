# Dot task: register MyTube for a bounded live-search experiment

Paste the following instructions into Dot. This is one-time developer setup; end users will not need Google Cloud or API keys. Do not publish the app or enable billing.

---

In the existing Google Cloud project **MyTube Feasibility** (`mytube-feasibility`), prepare an OAuth client for our locally installed MyTube browser extension.

1. Keep billing disabled and YouTube Data API v3 enabled. Do not change the existing API key, its restrictions, or other clients.
2. Find **MyTube Local Preview** in `brave://extensions` and copy its exact 32-character extension ID from Details. Do not transcribe a screenshot or include spaces. If you cannot access the Brave extension page, ask me for this public ID; do not guess it.
3. In Google Auth Platform, configure the consent screen for a personal development test: app name **MyTube Feasibility**, audience **External**, publishing status **Testing**. Use my signed-in account for required developer/support contact fields and add that same account as a test user. If ownership or consent information is unclear, ask instead of inventing it. Do not publish or submit for verification.
4. Add only the scope `https://www.googleapis.com/auth/youtube.readonly`. The planned test reads public search/video metadata. The consent scope can permit broader read-only access; do not add write scopes, email, profile, Gmail, or Drive scopes.
5. Create an OAuth client with application type **Chrome Extension**, name **MyTube local live search**, and the exact extension ID from step 2. Do not substitute a Web application client, create a client secret, or configure a loopback/hosted callback. If the console requires Chrome Web Store publication or app ownership verification before creating the test client, report that requirement and stop rather than publishing anything.
6. Return only the **public Client ID** ending in `.apps.googleusercontent.com`, the extension ID used, and whether the consent screen is in Testing with the test user added. Never return an API key, client secret, access/refresh token, password, cookie, or authentication URL.

This tests native `chrome.identity.getAuthToken`. Brave compatibility is still unverified, and an open Brave issue reports rejected custom URI callbacks. Creating the client does not establish that login works. Do not change Brave security settings or browser account settings as part of this task.

---

After receiving the public client ID, Codex can set `client_id` in `extension/google-client.json`, rebuild, and verify the configured package. No secret belongs in that file. The founder then reloads the extension and explicitly starts one live search to review Google's consent screen. If Brave rejects the native flow, preserve the sanitized error and reassess the browser/authentication requirement; do not silently add a server, scrape YouTube, or switch to the discouraged implicit OAuth flow.

References: [Chrome extension OAuth setup](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth), [Google API authorization](https://developers.google.com/youtube/data/guides/authentication), [Brave compatibility issue](https://github.com/brave/brave-browser/issues/38066), [Google's implicit-flow warning](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow).
