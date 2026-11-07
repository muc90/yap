import { EventEmitter } from 'node:events';

import type { FocusInfo, HotkeyConfig, HotkeyErrorCode } from '../../shared/types';

export interface NativePermissions {
  accessibility: boolean;
  inputMonitoring: boolean;
  postEvents: boolean;
}

export interface ListenerStatus {
  active: boolean;
  mode: 'listen-only' | 'active' | null;
  /** Why it is not running, as a code the UI words in its language. */
  error: HotkeyErrorCode | null;
}

export interface HotkeySignal {
  /** 'chord': another key was pressed while the hotkey was held, so it was used as a modifier. */
  type: 'down' | 'up' | 'chord';
}

/** Pastes into whatever has keyboard focus. No app or window is ever brought forward. */
export interface PasteRequest {
  text: string;
  /** Put the previous clipboard content back afterwards and keep the text out of clipboard history. */
  restoreClipboard: boolean;
  /** Whether a text field has focus in a Yap window, in case Yap itself is in front. */
  selfEditable: boolean;
}

export interface PasteResult {
  ok: boolean;
  /** 'no-target': Yap itself was in front without a text field to paste into. */
  reason?: 'accessibility' | 'unavailable' | 'failed' | 'no-target';
}

export interface NativeBridgeEvents {
  hotkey: [HotkeySignal];
  permissions: [NativePermissions];
  listener: [ListenerStatus];
}

export abstract class NativeBridge extends EventEmitter<NativeBridgeEvents> {
  abstract readonly kind: 'mac' | 'windows' | 'linux' | 'none';

  /** Starts the helper. Resolves false when no helper binary is available. */
  abstract start(): Promise<boolean>;
  abstract dispose(): void;
  /** Kills and relaunches the helper, which also refreshes its view of the permissions. */
  abstract restart(): Promise<boolean>;

  abstract listen(hotkey: HotkeyConfig): Promise<ListenerStatus>;
  abstract getListenerStatus(): ListenerStatus;
  abstract getPermissions(): Promise<NativePermissions>;
  abstract requestAccessibility(): Promise<NativePermissions>;
  abstract requestInputMonitoring(): Promise<NativePermissions>;
  abstract getFocus(): Promise<FocusInfo | null>;
  /** Snapshot the clipboard ahead of a paste that will restore it. */
  abstract prepareClipboard(): void;
  abstract paste(request: PasteRequest): Promise<PasteResult>;
  /** macOS AppleFnUsageType, null when unknown or not applicable. */
  abstract getFnUsage(): Promise<number | null>;
}

const GRANTED: NativePermissions = { accessibility: true, inputMonitoring: true, postEvents: true };

/** Used where no helper exists (e.g. Wayland-only or unknown platforms). */
export class NullBridge extends NativeBridge {
  readonly kind = 'none' as const;

  async start(): Promise<boolean> {
    return false;
  }

  dispose(): void {}

  async restart(): Promise<boolean> {
    return false;
  }

  async listen(): Promise<ListenerStatus> {
    return this.getListenerStatus();
  }

  getListenerStatus(): ListenerStatus {
    return { active: false, mode: null, error: 'unsupported' };
  }

  async getPermissions(): Promise<NativePermissions> {
    return GRANTED;
  }

  async requestAccessibility(): Promise<NativePermissions> {
    return GRANTED;
  }

  async requestInputMonitoring(): Promise<NativePermissions> {
    return GRANTED;
  }

  async getFocus(): Promise<FocusInfo | null> {
    return null;
  }

  prepareClipboard(): void {}

  async paste(): Promise<PasteResult> {
    return { ok: false, reason: 'unavailable' };
  }

  async getFnUsage(): Promise<number | null> {
    return null;
  }
}

export { GRANTED as ALL_NATIVE_PERMISSIONS_GRANTED };
