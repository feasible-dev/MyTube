'use strict';
const extensionApi = globalThis.browser ?? globalThis.chrome;
extensionApi.action.onClicked.addListener(async () => {
  try {
    await extensionApi.tabs.create({ url: extensionApi.runtime.getURL('index.html') });
  } catch {
    console.warn('MyTube could not open its preview tab. Try the toolbar button again.');
  }
});
