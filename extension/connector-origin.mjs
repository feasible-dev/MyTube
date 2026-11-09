// Firefox runtime.id is the add-on ID, not the profile-specific network origin.
// Accept one exact browser origin; never URLs with paths, wildcards or credentials.
export function connectorOrigin(identity) {
  if (typeof identity !== 'string') throw new Error('INVALID_EXTENSION_ID');
  if (/^[a-p]{32}$/.test(identity)) return `chrome-extension://${identity}`;
  if (/^moz-extension:\/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity)) return identity;
  throw new Error('INVALID_EXTENSION_ID');
}

export function setupIdentity(api) {
  if (api?.runtime?.getManifest?.()?.browser_specific_settings?.gecko) {
    try {
      const value = api.runtime.getURL('').replace(/\/$/, '');
      return connectorOrigin(value);
    } catch { return null; }
  }
  return api?.runtime?.id ?? null;
}
