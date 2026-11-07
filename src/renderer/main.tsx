import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
// Bundled, not fetched from Google Fonts: works offline and leaks nothing.
import '@fontsource/instrument-serif/latin-400.css';
import './styles.css';

import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';

import { MAC_TO_DOM, setHotkeyLabelStyle } from '../shared/hotkeys';
import { I18nProvider } from './lib/i18n';

const isOverlay = window.location.hash === '#overlay';
document.documentElement.classList.toggle('overlay-route', isOverlay);
document.documentElement.lang = window.yap.initialLocale;
if (!isOverlay && window.yap.initialTheme !== 'system') {
  document.documentElement.dataset.theme = window.yap.initialTheme;
}

/* Two entry points in one page: the overlay window only loads the recorder
   and its pill, not the settings app. */
async function mount(): Promise<void> {
  await applyKeyLabelStyle();
  const Root: ComponentType = isOverlay
    ? (await import('./overlay/Overlay')).Overlay
    : (await import('./App')).App;

  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <I18nProvider>
        <Root />
      </I18nProvider>
    </StrictMode>,
  );
  dismissSplash();
}

/**
 * Windows and Linux name keys the PC way, with the letters of the active
 * layout (Z at the US Y position on QWERTZ). Done before the first render,
 * because labels are computed while rendering.
 */
async function applyKeyLabelStyle(): Promise<void> {
  if (navigator.userAgent.includes('Mac')) return;
  setHotkeyLabelStyle({ mac: false, superKey: navigator.userAgent.includes('Windows') ? 'Win' : 'Super' });
  const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<{ get(code: string): string | undefined }> } }).keyboard;
  try {
    const map = await Promise.race([keyboard?.getLayoutMap(), new Promise<undefined>((resolve) => setTimeout(resolve, 300))]);
    if (map) setHotkeyLabelStyle({ printed: (macKeyCode) => map.get(MAC_TO_DOM[macKeyCode] ?? '') });
  } catch {
    // US names then.
  }
}

/** Minimum time the splash stays up, so it reads as a launch screen instead of a flicker. */
const SPLASH_MIN_MS = 700;

/* The splash in index.html covers the gap between the window appearing and
   the app's first render. It fades out once React has painted. */
function dismissSplash(): void {
  const splash = document.getElementById('splash');
  if (!splash) return;
  if (isOverlay) {
    splash.remove();
    return;
  }
  const wait = Math.max(0, SPLASH_MIN_MS - performance.now());
  window.setTimeout(() => {
    requestAnimationFrame(() => {
      splash.classList.add('splash-done');
      splash.addEventListener('transitionend', () => splash.remove(), { once: true });
      // Reduced motion has no transition, so transitionend never fires.
      window.setTimeout(() => splash.remove(), 400);
    });
  }, wait);
}

void mount();
