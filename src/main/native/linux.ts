import { clipboard } from 'electron';

import { setHotkeyLabelStyle } from '../../shared/hotkeys';
import type { PasteRequest, PasteResult } from './bridge';
import { MacHelperBridge } from './mac';
import { restoreClipboard, snapshotClipboard, type ClipboardSnapshot } from './windows';

const PASTE_TIMEOUT_MS = 3_000;
/** How long the target app gets to read the clipboard before the old content returns. */
const RESTORE_DELAY_MS = 1_000;

/**
 * The Linux helper (linux/YapHelper.cpp) speaks the macOS helper's protocol:
 * one long-running `serve` process for hotkey, focus and paste. Only the
 * clipboard differs: on X11 Electron owns the selection, so the text is put
 * there from main and the helper just sends the paste keystroke.
 */
export class LinuxHelperBridge extends MacHelperBridge {
  override readonly kind = 'linux' as const;

  private preparedSnapshot: ClipboardSnapshot | null = null;
  private pendingRestore: { snapshot: ClipboardSnapshot; timer: ReturnType<typeof setTimeout> } | null = null;

  /** After the helper is up, learn what the keyboard layout prints, so labels say Z on QWERTZ. */
  override async start(): Promise<boolean> {
    const ok = await super.start();
    if (ok) {
      try {
        const keymap = await this.callStarted('keymap');
        setHotkeyLabelStyle({
          printed: (macKeyCode) => {
            const value = keymap[String(macKeyCode)];
            return typeof value === 'string' ? value : undefined;
          },
        });
      } catch {
        // Labels fall back to US names.
      }
    }
    return ok;
  }

  /** Taken when recording starts, so reading the old clipboard costs nothing at delivery. */
  override prepareClipboard(): void {
    if (this.pendingRestore) return;
    try {
      this.preparedSnapshot = snapshotClipboard();
    } catch {
      this.preparedSnapshot = null;
    }
  }

  override async paste(request: PasteRequest): Promise<PasteResult> {
    let snapshot: ClipboardSnapshot | null = null;
    if (this.pendingRestore) {
      // A previous paste has not restored yet: its snapshot is the real old content.
      clearTimeout(this.pendingRestore.timer);
      snapshot = this.pendingRestore.snapshot;
      this.pendingRestore = null;
    } else {
      snapshot = this.preparedSnapshot;
    }
    this.preparedSnapshot = null;
    if (request.restoreClipboard && !snapshot) snapshot = snapshotClipboard();
    if (!request.restoreClipboard) snapshot = null;

    clipboard.writeText(request.text);

    let result: PasteResult;
    try {
      const raw = await this.callStarted(
        'paste',
        { selfEditable: request.selfEditable, ownPid: process.pid },
        PASTE_TIMEOUT_MS,
      );
      if (raw.ok === true) {
        result = { ok: true };
      } else {
        const reason = raw.reason === 'no-target' || raw.reason === 'unavailable' ? raw.reason : 'failed';
        result = { ok: false, reason };
      }
    } catch (error) {
      console.warn('[yap] paste failed:', error instanceof Error ? error.message : error);
      result = { ok: false, reason: 'failed' };
    }

    // After a failed paste the text stays on the clipboard as a fallback.
    if (snapshot && result.ok) {
      const saved = snapshot;
      const timer = setTimeout(() => {
        this.pendingRestore = null;
        if (clipboard.readText() === request.text) restoreClipboard(saved);
      }, RESTORE_DELAY_MS);
      this.pendingRestore = { snapshot: saved, timer };
    }

    return result;
  }

  override dispose(): void {
    if (this.pendingRestore) {
      clearTimeout(this.pendingRestore.timer);
      restoreClipboard(this.pendingRestore.snapshot);
      this.pendingRestore = null;
    }
    super.dispose();
  }
}
