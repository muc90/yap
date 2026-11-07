import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

/** Linux has no login-item API; desktop environments read ~/.config/autostart instead. */
function applyLinuxAutostart(openAtLogin: boolean): void {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const file = path.join(configHome, 'autostart', 'yap.desktop');

  if (!openAtLogin) {
    rmSync(file, { force: true });
    return;
  }

  const quote = (value: string) => `"${value.replace(/(["\\`$])/g, '\\$1')}"`;
  // An AppImage runs from a temporary mount; the file itself is what has to start.
  const exec = process.env.APPIMAGE
    ? [quote(process.env.APPIMAGE)]
    : app.isPackaged
      ? [quote(process.execPath)]
      : [quote(process.execPath), quote(app.getAppPath())];

  const icon = app.isPackaged
    ? path.join(process.resourcesPath, 'icons', 'appIcon.png')
    : path.join(app.getAppPath(), 'build', 'icons', 'appIcon.png');

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Yap',
      'Comment=Voice dictation',
      `Exec=${[...exec, '--hidden'].join(' ')}`,
      `Icon=${icon}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'),
  );
}

export function applyLaunchAtLogin(openAtLogin: boolean): void {
  try {
    if (process.platform === 'linux') {
      // Works for source checkouts too: the entry starts Electron with this project.
      applyLinuxAutostart(openAtLogin);
      return;
    }

    // Development builds would register the Electron binary itself.
    if (!app.isPackaged) {
      return;
    }

    app.setLoginItemSettings(
      process.platform === 'win32'
        ? { openAtLogin, args: ['--hidden'] }
        : { openAtLogin },
    );
  } catch (error) {
    console.warn('[yap] launch at login could not be changed:', error instanceof Error ? error.message : error);
  }
}
