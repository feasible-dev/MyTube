# MyTube

Find videos on your topic, related subjects, and unexpected discoveries.

## Install (Windows + Chrome, Edge, Brave or Firefox)

**Start here:** double-click **Install MyTube.html** for a visual guide with instructions for your browser, including how to pin and open MyTube.

1. Install [Node.js 22+](https://nodejs.org/). Download this repository and extract it into a permanent folder.
2. Double-click **MyTube.cmd**. It installs what is needed and opens **Connect YouTube**.
3. Get your key in [Google Cloud](https://console.cloud.google.com/apis/credentials): create a project, enable **YouTube Data API v3** in **Library**, then **Credentials > Create credentials > API key**. Restrict the key to **YouTube Data API v3**. Paste it into the **Connect YouTube** window and click **Save key**.
4. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this project's `dist/brave` folder. Paste the extension's ID into the launcher's prompt (once only).
5. Leave the launcher running. The extension opens a welcome guide on first installation: check the companion connection, confirm YouTube key setup, then sign in to ChatGPT. Click **Open MyTube**, then **New search**.

**Next time:** double-click **MyTube.cmd**. Your key and extension ID are remembered.

**Open MyTube:** use the blue icon in your browser’s Extensions menu, the welcome guide’s **Open MyTube now** button, or **Alt+Shift+M** (if available). Pin the icon or bookmark the MyTube page with **Ctrl+D**. In MyTube, **Settings → Setup & browser access** reopens the guide. Each browser needs its own installation; the companion trusts one installation at a time.

**Appearance:** use the **sun/moon switch** in the header to switch colors. Its round thumb marks the active theme. Your choice is remembered in this browser and also applies to the welcome guide.

**Setup help inside the extension:** open MyTube's **Extension options** to return to the welcome guide. Updates keep your history and do not reopen the guide automatically.

**Firefox (Windows):** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `dist/firefox/manifest.json`. Copy the connection address shown in the welcome guide. Close the old launcher, run `npm start -- --configure` from the project folder, and paste that address. Allow the requested site permissions. Temporary add-ons need loading again after Firefox closes. [Mozilla's instructions](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/). Optional Google subscriptions are not supported on Firefox.

**Distribution candidates:** `npm run extension:package` creates Chrome and Firefox ZIPs in `dist/distribution`, excluding local Google registration. They are not signed or published in browser stores. Node.js, the local companion and manual extension loading are still required for this preview.

**Daily budget:** up to 5 YouTube search calls per search: budget for 20 searches/day on Google's default quota. Broad searches can yield around 40 suggestions; results vary. [Quota details](agents.markdown#search-budget-and-results).

Development preview: Chrome extension + local helper. [Details and troubleshooting](agents.markdown).
