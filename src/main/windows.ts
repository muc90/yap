import { fileURLToPath } from 'node:url';

import { BrowserWindow, nativeTheme, screen } from 'electron';

import type { Locale } from '../shared/i18n';
import type { OverlayPosition, ThemePreference } from '../shared/types';

const isMac = process.platform === 'darwin';

const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));
const rendererFilePath = fileURLToPath(new URL('../renderer/index.html', import.meta.url));

export const OVERLAY_WIDTH = 360;
export const OVERLAY_HEIGHT = 88;

/** The sidebar colour of the current theme, so a window never flashes the wrong one. */
export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#141519' : '#f1f0ea';
}

async function loadRenderer(window: BrowserWindow, hash = ''): Promise<void> {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    await window.loadURL(hash ? `${devServerUrl.replace(/\/$/, '')}/#${hash}` : devServerUrl);
    return;
  }
  await window.loadFile(rendererFilePath, { hash });
}

export async function createMainWindow(theme: ThemePreference, locale: Locale): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1080,
    height: 740,
    minWidth: 860,
    minHeight: 560,
    show: false,
    // Matches the sidebar colour so the first frame does not flash.
    backgroundColor: windowBackground(),
    title: 'Yap',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } }
      : { autoHideMenuBar: true }),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      spellcheck: false,
      // Read by the preload, so the first frame already has the right theme and language.
      additionalArguments: [`--yap-theme=${theme}`, `--yap-locale=${locale}`],
    },
  });

  await loadRenderer(window);
  return window;
}

export function positionOverlayWindow(window: BrowserWindow, position: OverlayPosition = 'bottom-center'): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workArea } = display;
  const right = position.endsWith('right');
  const top = position.startsWith('top');
  const x = right
    ? workArea.x + workArea.width - OVERLAY_WIDTH - 16
    : workArea.x + Math.round((workArea.width - OVERLAY_WIDTH) / 2);
  const y = top ? workArea.y + 16 : workArea.y + workArea.height - OVERLAY_HEIGHT - 16;
  // The pill sits inside a larger transparent window; the page aligns it to the chosen edge.
  window.webContents
    .executeJavaScript(`document.documentElement.dataset.overlayPosition = ${JSON.stringify(position)}`)
    .catch(() => undefined);
  const current = window.getBounds();
  if (current.x !== x || current.y !== y || current.width !== OVERLAY_WIDTH || current.height !== OVERLAY_HEIGHT) {
    window.setBounds({ x, y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT });
  }
}

/**
 * The overlay doubles as the recorder: it owns the microphone, so it exists
 * for the whole session even while hidden, and it never takes focus away
 * from the app the user is dictating into.
 *
 * On macOS it is a non-activating panel. That floats over full-screen apps
 * and shows on every Space by itself, so the window never needs
 * setVisibleOnAllWorkspaces, whose process type switch hides the windows and
 * the Dock icon for a moment and can activate Yap.
 */
export async function createOverlayWindow(locale: Locale): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    ...(isMac ? { type: 'panel' } : {}),
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      // Recording runs while the window is hidden.
      backgroundThrottling: false,
      spellcheck: false,
      additionalArguments: [`--yap-locale=${locale}`],
    },
  });

  window.setAlwaysOnTop(true, 'floating');
  window.setIgnoreMouseEvents(true);
  positionOverlayWindow(window);

  await loadRenderer(window, 'overlay');
  return window;
}
