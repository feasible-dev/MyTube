import { mountWelcome } from './welcome.mjs';
import { bindTheme } from '../poc/theme.mjs';
bindTheme();
const guide = mountWelcome({ document, live: globalThis.MyTubeLive });
globalThis.addEventListener('pagehide', () => guide.dispose(), { once: true });
