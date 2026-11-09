'use strict';
const extensionApi = globalThis.browser ?? globalThis.chrome;
extensionApi.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  try {
    await extensionApi.tabs.create({ url: extensionApi.runtime.getURL('welcome.html') });
  } catch {
    console.warn('Open MyTube extension options to finish setup.');
  }
});
extensionApi.action.onClicked.addListener(async () => {
  try {
    await extensionApi.tabs.create({ url: extensionApi.runtime.getURL('index.html') });
  } catch {
    console.warn('MyTube could not open its preview tab. Try the toolbar button again.');
  }
});
