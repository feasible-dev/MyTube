# MyTube

Describe what you want to watch. Get videos on your topic, related subjects, and unexpected discoveries.

**Requires:** Windows, Chrome, [Node.js 22+](https://nodejs.org/), and ChatGPT sign-in.

1. Download or clone this repository. Open PowerShell in its folder:

   ```powershell
   npm.cmd run setup
   ```

2. The setup window explains how to get your YouTube key:
   - Open [Google Cloud](https://console.cloud.google.com/apis/credentials) and create a project.
   - **APIs & Services > Library:** enable **YouTube Data API v3**.
   - **Credentials > Create credentials > API key**. Restrict it to **YouTube Data API v3**.
   - Paste it into MyTube and click **Save key**. Protection is automatic.
3. In `chrome://extensions`, enable **Developer mode**, then **Load unpacked** and select `dist/brave`.
4. Start MyTube:

   ```powershell
   npm.cmd start
   ```

   Paste the extension ID when asked (once only). Keep this terminal open.
5. Open MyTube, click **New search**, and sign in to ChatGPT. Next time, just run `npm start`.

Development preview. [Detailed instructions](agents.markdown).
