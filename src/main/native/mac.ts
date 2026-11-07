import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

import type { FocusInfo, HotkeyConfig, HotkeyErrorCode } from '../../shared/types';
import {
  NativeBridge,
  type ListenerStatus,
  type NativePermissions,
  type PasteRequest,
  type PasteResult,
} from './bridge';
import { ensureHelperBinary } from './binary';

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CALL_TIMEOUT_MS = 5_000;
const PASTE_TIMEOUT_MS = 3_000;
const MAX_RESTARTS_PER_MINUTE = 5;

function toPermissions(value: Record<string, unknown>): NativePermissions {
  return {
    accessibility: value.accessibility === true,
    inputMonitoring: value.inputMonitoring === true,
    postEvents: value.postEvents === true,
  };
}

const HELPER_ERROR_CODES: readonly HotkeyErrorCode[] = ['needs-access', 'refused', 'fn-unsupported', 'key-unsupported'];

export function toListenerStatus(value: Record<string, unknown>): ListenerStatus {
  let error: HotkeyErrorCode | null = null;
  if (HELPER_ERROR_CODES.includes(value.errorCode as HotkeyErrorCode)) {
    error = value.errorCode as HotkeyErrorCode;
    if (typeof value.error === 'string') console.warn('[yap] listener error:', value.error);
  } else if (typeof value.error === 'string') {
    // The helper's English message is for the log, the code for the UI.
    console.warn('[yap] listener error:', value.error);
    error = 'listener-failed';
  }
  return {
    active: value.active === true,
    mode: value.mode === 'listen-only' || value.mode === 'active' ? value.mode : null,
    error,
  };
}

function toFocus(value: unknown): FocusInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const focus: FocusInfo = {
    appName: typeof raw.appName === 'string' ? raw.appName : undefined,
    bundleIdentifier: typeof raw.bundleIdentifier === 'string' ? raw.bundleIdentifier : undefined,
    processIdentifier: typeof raw.processIdentifier === 'number' ? raw.processIdentifier : undefined,
    role: typeof raw.role === 'string' ? raw.role : undefined,
    editable: typeof raw.editable === 'boolean' ? raw.editable : undefined,
  };
  return focus.appName || focus.bundleIdentifier || focus.processIdentifier ? focus : undefined;
}

/**
 * Talks to the long-running Swift helper (`yap-helper serve`) over JSON lines.
 * One process for the whole session: no launch cost per paste or focus query,
 * and it can push hotkey, permission and listener changes as they happen.
 */
export class MacHelperBridge extends NativeBridge {
  readonly kind: 'mac' | 'linux' = 'mac';

  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<boolean> | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private hotkey: HotkeyConfig | null = null;
  private listener: ListenerStatus = { active: false, mode: null, error: null };
  private restarts: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  start(): Promise<boolean> {
    if (this.child) return Promise.resolve(true);
    if (!this.starting) {
      this.starting = this.launch().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async launch(): Promise<boolean> {
    if (this.disposed) return false;

    const binary = await ensureHelperBinary();
    if (!binary) {
      this.setListener({ active: false, mode: null, error: 'helper-missing' });
      return false;
    }

    const child = spawn(binary, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message) console.warn('[yap:helper]', message);
    });
    // Writing to a helper that just died raises EPIPE here instead of crashing main.
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => console.error('[yap] helper failed to start:', error.message));
    child.on('exit', (code, signal) => this.handleExit(child, code, signal));

    try {
      await this.call('hello', {}, CALL_TIMEOUT_MS);
    } catch (error) {
      console.error('[yap] helper did not answer:', error instanceof Error ? error.message : error);
      // Unresponsive, so it would not act on SIGTERM either.
      child.kill('SIGKILL');
      return false;
    }

    if (this.hotkey) {
      await this.listen(this.hotkey).catch(() => undefined);
    }
    return true;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof message.id === 'number' && message.id > 0) {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.ok === true) {
        call.resolve((message.result as Record<string, unknown>) ?? {});
      } else {
        call.reject(new Error(typeof message.error === 'string' ? message.error : 'Helper command failed.'));
      }
      return;
    }

    switch (message.event) {
      case 'hotkey':
        this.emit('hotkey', {
          type: message.state === 'down' ? 'down' : message.state === 'chord' ? 'chord' : 'up',
        });
        break;
      case 'permissions':
        this.emit('permissions', toPermissions(message));
        break;
      case 'listener':
        this.setListener(toListenerStatus(message));
        break;
      case 'error':
        console.warn('[yap:helper]', message.message);
        break;
      default:
        break;
    }
  }

  private setListener(status: ListenerStatus): void {
    this.listener = status;
    this.emit('listener', status);
  }

  private handleExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;

    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error('The native helper stopped.'));
    }
    this.pending.clear();

    if (this.disposed) return;

    console.warn('[yap] helper exited', { code, signal });
    const now = Date.now();
    this.restarts = this.restarts.filter((time) => now - time < 60_000);
    if (this.restarts.length >= MAX_RESTARTS_PER_MINUTE) {
      this.setListener({ active: false, mode: null, error: 'helper-crashing' });
      return;
    }

    this.restarts.push(now);
    this.setListener({ active: false, mode: null, error: 'reconnecting' });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, 300 * this.restarts.length);
  }

  protected call(cmd: string, args: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error('The native helper is not running.'));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The native helper did not answer "${cmd}".`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  protected async callStarted(cmd: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (!this.child && !(await this.start())) {
      throw new Error('The native helper is not available.');
    }
    return this.call(cmd, args, timeoutMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdin.end();
      child.kill();
    }
  }

  async restart(): Promise<boolean> {
    const child = this.child;
    if (child) {
      this.child = null;
      for (const call of this.pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error('The native helper is restarting.'));
      }
      this.pending.clear();
      const exited = new Promise<boolean>((resolve) => child.once('exit', () => resolve(true)));
      child.kill();
      // SIGTERM lets it finish a pending clipboard restore (under a second).
      const stopped = await Promise.race([exited, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500))]);
      if (!stopped) child.kill('SIGKILL');
    }
    this.restarts = [];
    return this.start();
  }

  async listen(hotkey: HotkeyConfig): Promise<ListenerStatus> {
    this.hotkey = hotkey;
    const result = await this.callStarted('listen', { keyCode: hotkey.keyCode, modifiers: hotkey.modifiers });
    const status = toListenerStatus(result);
    this.setListener(status);
    return status;
  }

  getListenerStatus(): ListenerStatus {
    return this.listener;
  }

  async getPermissions(): Promise<NativePermissions> {
    return toPermissions(await this.callStarted('permissions'));
  }

  async requestAccessibility(): Promise<NativePermissions> {
    return toPermissions(await this.callStarted('requestAccessibility'));
  }

  async requestInputMonitoring(): Promise<NativePermissions> {
    return toPermissions(await this.callStarted('requestInputMonitoring'));
  }

  async getFocus(): Promise<FocusInfo | null> {
    return toFocus(await this.callStarted('focus')) ?? null;
  }

  prepareClipboard(): void {
    if (this.child) {
      void this.call('prepareClipboard').catch(() => undefined);
    }
  }

  async paste(request: PasteRequest): Promise<PasteResult> {
    try {
      const result = await this.callStarted(
        'paste',
        {
          text: request.text,
          restore: request.restoreClipboard,
          selfEditable: request.selfEditable,
        },
        PASTE_TIMEOUT_MS,
      );
      if (result.ok === true) return { ok: true };
      const reason = result.reason === 'accessibility' || result.reason === 'no-target' ? result.reason : 'failed';
      return { ok: false, reason };
    } catch (error) {
      console.warn('[yap] paste failed:', error instanceof Error ? error.message : error);
      return { ok: false, reason: 'failed' };
    }
  }

  async getFnUsage(): Promise<number | null> {
    try {
      const result = await this.callStarted('fnUsage');
      return typeof result.value === 'number' ? result.value : null;
    } catch {
      return null;
    }
  }
}
