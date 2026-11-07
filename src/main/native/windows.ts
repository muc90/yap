import { spawn, type ChildProcessByStdio } from 'node:child_process';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { clipboard, type NativeImage } from 'electron';

import type { FocusInfo, HotkeyConfig, HotkeyErrorCode } from '../../shared/types';
import {
  ALL_NATIVE_PERMISSIONS_GRANTED,
  NativeBridge,
  type ListenerStatus,
  type NativePermissions,
  type PasteRequest,
  type PasteResult,
} from './bridge';
import { ensureHelperBinary } from './binary';

// Abstract key codes expected by YapHelper.cpp.
const AK = {
  LEFT_META: 1, RIGHT_META: 2,
  LEFT_ALT: 3, RIGHT_ALT: 4,
  LEFT_SHIFT: 5, RIGHT_SHIFT: 6,
  LEFT_CTRL: 7, RIGHT_CTRL: 8,
  FN: 9,
  KEY_A: 100,
  DIGIT_0: 200,
  SPACE: 300, ENTER: 301, TAB: 302, BACKSPACE: 303, ESCAPE: 304,
  F1: 400,
} as const;

// Hotkeys are stored with macOS key codes; the Windows helper speaks abstract ones.
const MAC_TO_ABSTRACT: Record<number, number> = {
  55: AK.LEFT_META, 54: AK.RIGHT_META,
  58: AK.LEFT_ALT, 61: AK.RIGHT_ALT,
  56: AK.LEFT_SHIFT, 60: AK.RIGHT_SHIFT,
  59: AK.LEFT_CTRL, 62: AK.RIGHT_CTRL,
  63: AK.FN,
  0: AK.KEY_A, 11: AK.KEY_A + 1, 8: AK.KEY_A + 2, 2: AK.KEY_A + 3,
  14: AK.KEY_A + 4, 3: AK.KEY_A + 5, 5: AK.KEY_A + 6, 4: AK.KEY_A + 7,
  34: AK.KEY_A + 8, 38: AK.KEY_A + 9, 40: AK.KEY_A + 10, 37: AK.KEY_A + 11,
  46: AK.KEY_A + 12, 45: AK.KEY_A + 13, 31: AK.KEY_A + 14, 35: AK.KEY_A + 15,
  12: AK.KEY_A + 16, 15: AK.KEY_A + 17, 1: AK.KEY_A + 18, 17: AK.KEY_A + 19,
  32: AK.KEY_A + 20, 9: AK.KEY_A + 21, 13: AK.KEY_A + 22, 7: AK.KEY_A + 23,
  16: AK.KEY_A + 24, 6: AK.KEY_A + 25,
  29: AK.DIGIT_0, 18: AK.DIGIT_0 + 1, 19: AK.DIGIT_0 + 2, 20: AK.DIGIT_0 + 3,
  21: AK.DIGIT_0 + 4, 23: AK.DIGIT_0 + 5, 22: AK.DIGIT_0 + 6, 26: AK.DIGIT_0 + 7,
  28: AK.DIGIT_0 + 8, 25: AK.DIGIT_0 + 9,
  49: AK.SPACE, 36: AK.ENTER, 48: AK.TAB, 51: AK.BACKSPACE, 53: AK.ESCAPE,
  122: AK.F1, 120: AK.F1 + 1, 99: AK.F1 + 2, 118: AK.F1 + 3,
  96: AK.F1 + 4, 97: AK.F1 + 5, 98: AK.F1 + 6, 100: AK.F1 + 7,
  101: AK.F1 + 8, 109: AK.F1 + 9, 103: AK.F1 + 10, 111: AK.F1 + 11,
  105: AK.F1 + 12, 107: AK.F1 + 13, 113: AK.F1 + 14,
};

const MAC_MOD = { command: 0x100000, option: 0x80000, shift: 0x20000, control: 0x40000 };
const ABS_MOD = { meta: 0x01, alt: 0x02, shift: 0x04, ctrl: 0x08 };

export function translateHotkey(hotkey: HotkeyConfig): { keyCode: number; modifiers: number } {
  let modifiers = 0;
  if (hotkey.modifiers & MAC_MOD.command) modifiers |= ABS_MOD.meta;
  if (hotkey.modifiers & MAC_MOD.option) modifiers |= ABS_MOD.alt;
  if (hotkey.modifiers & MAC_MOD.shift) modifiers |= ABS_MOD.shift;
  if (hotkey.modifiers & MAC_MOD.control) modifiers |= ABS_MOD.ctrl;
  return { keyCode: MAC_TO_ABSTRACT[hotkey.keyCode] ?? hotkey.keyCode, modifiers };
}

export interface ClipboardSnapshot {
  text: string;
  html: string;
  rtf: string;
  image: NativeImage;
}

export function snapshotClipboard(): ClipboardSnapshot {
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: clipboard.readImage(),
  };
}

export function restoreClipboard(snapshot: ClipboardSnapshot): void {
  const hasImage = !snapshot.image.isEmpty();
  if (!snapshot.text && !snapshot.html && !snapshot.rtf && !hasImage) {
    clipboard.clear();
    return;
  }
  clipboard.write({
    text: snapshot.text || undefined,
    html: snapshot.html || undefined,
    rtf: snapshot.rtf || undefined,
    image: hasImage ? snapshot.image : undefined,
  });
}

/** The helper reports listener failures in English; the UI needs a code it can word. */
export function listenerErrorCode(message: string | undefined): HotkeyErrorCode {
  if (message?.startsWith('Fn key')) return 'fn-unsupported';
  if (message?.startsWith('Unsupported key')) return 'key-unsupported';
  return 'listener-failed';
}

/**
 * The Windows helper keeps its original one-shot protocol: a long-running
 * `listen` process for the hotkey and short-lived processes for focus and
 * paste. The clipboard round trip happens here with Electron's clipboard.
 */
export class WindowsHelperBridge extends NativeBridge {
  readonly kind = 'windows' as const;

  private binary: string | null = null;
  private listenerProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private listener: ListenerStatus = { active: false, mode: null, error: null };
  private pendingRestore: { snapshot: ClipboardSnapshot; timer: ReturnType<typeof setTimeout> } | null = null;
  private disposed = false;

  async start(): Promise<boolean> {
    this.binary = await ensureHelperBinary();
    return this.binary !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.listenerProcess?.kill();
    this.listenerProcess = null;
  }

  async restart(): Promise<boolean> {
    return this.start();
  }

  private setListener(status: ListenerStatus): void {
    this.listener = status;
    this.emit('listener', status);
  }

  async listen(hotkey: HotkeyConfig): Promise<ListenerStatus> {
    if (!this.binary && !(await this.start())) {
      this.setListener({ active: false, mode: null, error: 'helper-missing' });
      return this.listener;
    }

    this.listenerProcess?.kill();
    const { keyCode, modifiers } = translateHotkey(hotkey);
    const child = spawn(this.binary!, ['listen', String(keyCode), String(modifiers)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.listenerProcess = child;

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line) as { type?: string; message?: string };
        if (message.type === 'fnDown') this.emit('hotkey', { type: 'down' });
        if (message.type === 'fnUp') this.emit('hotkey', { type: 'up' });
        if (message.type === 'error') {
          console.warn('[yap] listener error:', message.message);
          this.setListener({ active: false, mode: null, error: listenerErrorCode(message.message) });
        }
      } catch {
        // Ignore malformed lines.
      }
    });

    child.on('exit', () => {
      if (this.listenerProcess !== child) return;
      this.listenerProcess = null;
      if (!this.disposed && this.listener.active) {
        this.setListener({ active: false, mode: null, error: 'stopped' });
      }
    });

    this.setListener({ active: true, mode: 'listen-only', error: null });
    return this.listener;
  }

  getListenerStatus(): ListenerStatus {
    return this.listener;
  }

  async getPermissions(): Promise<NativePermissions> {
    return ALL_NATIVE_PERMISSIONS_GRANTED;
  }

  async requestAccessibility(): Promise<NativePermissions> {
    return ALL_NATIVE_PERMISSIONS_GRANTED;
  }

  async requestInputMonitoring(): Promise<NativePermissions> {
    return ALL_NATIVE_PERMISSIONS_GRANTED;
  }

  private runOnce<T>(args: string[]): Promise<T> {
    const binary = this.binary;
    if (!binary) return Promise.reject(new Error('The native helper is not available.'));

    return new Promise<T>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error('The native helper failed.'));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as T);
        } catch (error) {
          reject(error as Error);
        }
      });
    });
  }

  async getFocus(): Promise<FocusInfo | null> {
    try {
      const raw = await this.runOnce<{ appName?: string; bundleIdentifier?: string; processIdentifier?: number }>(['focus']);
      return { appName: raw.appName, bundleIdentifier: raw.bundleIdentifier, processIdentifier: raw.processIdentifier };
    } catch {
      return null;
    }
  }

  prepareClipboard(): void {}

  async paste(request: PasteRequest): Promise<PasteResult> {
    let snapshot: ClipboardSnapshot | null = null;
    if (this.pendingRestore) {
      clearTimeout(this.pendingRestore.timer);
      snapshot = request.restoreClipboard ? this.pendingRestore.snapshot : null;
      this.pendingRestore = null;
    } else if (request.restoreClipboard) {
      snapshot = snapshotClipboard();
    }

    clipboard.writeText(request.text);

    let ok = false;
    try {
      // No target arguments: the helper would bring that window forward, and
      // the text belongs wherever the user is now.
      ok = (await this.runOnce<{ ok: boolean }>(['paste'])).ok;
    } catch {
      ok = false;
    }

    // After a failed paste the engine leaves the text on the clipboard as a
    // fallback, so restoring the old content would take it away again.
    if (snapshot && ok) {
      const saved = snapshot;
      const timer = setTimeout(() => {
        this.pendingRestore = null;
        if (clipboard.readText() === request.text) {
          restoreClipboard(saved);
        }
      }, 800);
      this.pendingRestore = { snapshot: saved, timer };
    }

    return ok ? { ok } : { ok, reason: 'failed' };
  }

  async getFnUsage(): Promise<number | null> {
    return null;
  }
}
