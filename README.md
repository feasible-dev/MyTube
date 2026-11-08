# MyTube

Describe what you want to watch. Get videos on your topic, related subjects, and unexpected discoveries.

**Requires:** Windows, Chrome, [Node.js 22+](https://nodejs.org/), and ChatGPT sign-in.

MyTube has two parts: a Chrome extension and a local helper running on your PC.

1. Download or clone this repository. Open PowerShell in its folder:

   ```powershell
   npm.cmd run setup
   ```

2. Setup opens a separate Windows window titled **MyTube - Connect YouTube**. Leave it open while you get your key:
   - Open [Google Cloud](https://console.cloud.google.com/apis/credentials) and create a project.
   - **APIs & Services > Library:** enable **YouTube Data API v3**.
   - **Credentials > Create credentials > API key**. Restrict it to **YouTube Data API v3**.
   - Return to that Windows window, paste the key into its masked text field, and click **Save key**. Close the window after **Key saved** appears. This happens before installing the Chrome extension.
3. In `chrome://extensions`, enable **Developer mode**, then **Load unpacked** and select `dist/brave`.
4. Start the local helper:

   ```powershell
   npm.cmd start
   ```

   Copy MyTube's ID from `chrome://extensions` and paste it into the terminal when asked (once only). This is the extension ID, not your YouTube key. Keep this terminal open.
5. Open MyTube, click **New search**, and sign in to ChatGPT. Next time, just run `npm start`.

Development preview. [Detailed instructions](agents.markdown).
