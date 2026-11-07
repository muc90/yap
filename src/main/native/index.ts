import { NativeBridge, NullBridge } from './bridge';
import { MacHelperBridge } from './mac';
import { LinuxHelperBridge } from './linux';
import { WindowsHelperBridge } from './windows';

export function createNativeBridge(): NativeBridge {
  if (process.platform === 'darwin') return new MacHelperBridge();
  if (process.platform === 'win32') return new WindowsHelperBridge();
  // The helper talks to X11; a pure Wayland session has no DISPLAY.
  if (process.platform === 'linux' && process.env.DISPLAY) return new LinuxHelperBridge();
  return new NullBridge();
}

export type { HotkeySignal, ListenerStatus, NativePermissions, PasteRequest, PasteResult } from './bridge';
export { NativeBridge } from './bridge';
