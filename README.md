# MyTube

Describe what you want to watch. Get videos on your topic, related subjects, and unexpected discoveries.

**Requires:** Windows, Chrome, Node.js 22+, a personal YouTube API key, and ChatGPT sign-in.

1. Download or clone this repository. Open PowerShell in its folder:

   ```powershell
   npm.cmd ci --ignore-scripts --no-audit --no-fund
   npm.cmd run extension:build
   npm.cmd run key:setup
   ```

2. Paste your YouTube key into the Windows dialog and click **Encrypt and save**.
3. Open `chrome://extensions`, enable **Developer mode**, and **Load unpacked** ? `dist/brave`. Copy its extension ID.
4. Start the connector and keep the terminal open:

   ```powershell
   $env:MYTUBE_EXTENSION_ID = 'YOUR_EXTENSION_ID'
   npm.cmd run connector
   ```

5. Open MyTube, click **New search**, and sign in to ChatGPT.

Development preview. [Key creation, troubleshooting, security, and developer instructions ? agents.markdown](agents.markdown)
