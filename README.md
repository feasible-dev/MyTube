# MyTube

Find videos on your topic, related subjects, and unexpected discoveries.

## Install (Windows + Chrome)

1. Install [Node.js 22+](https://nodejs.org/). Download this repository and extract it into a permanent folder.
2. Double-click **MyTube.cmd**. It installs what is needed and opens **Connect YouTube**.
3. Get your key in [Google Cloud](https://console.cloud.google.com/apis/credentials): create a project, enable **YouTube Data API v3** in **Library**, then **Credentials > Create credentials > API key**. Restrict the key to **YouTube Data API v3**. Paste it into the **Connect YouTube** window and click **Save key**.
4. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this project's `dist/brave` folder. Paste the extension's ID into the launcher's prompt (once only).
5. Leave the launcher running. Open MyTube from Chrome, click **New search**, and sign in to ChatGPT.

**Next time:** double-click **MyTube.cmd**. Your key and extension ID are remembered.

Development preview: Chrome extension + local helper. [Details and troubleshooting](agents.markdown).
