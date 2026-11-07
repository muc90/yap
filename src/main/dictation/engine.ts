import { randomUUID } from 'node:crypto';

import { clipboard, type WebContents } from 'electron';

import { hotkeyLabel } from '../../shared/hotkeys';
import { formatSeconds } from '../../shared/i18n';
import type {
  AppSettings,
  AppStatus,
  DeliveryOutcome,
  DictationMetrics,
  FocusInfo,
  HistoryEntry,
  PermissionsState,
  RecordedAudio,
  RecorderEvent,
  RetranscribeMode,
} from '../../shared/types';
import { resolveStyleForApp, loadAppRules } from '../app-rules';
import { deleteAudioRecording, readAudioRecording, writeAudioRecording } from '../audio-store';
import { applyCorrections, loadCorrections, loadDictionary } from '../dictionary';
import { prewarmGroq } from '../groq';
import { addHistoryEntry, loadHistory, removeHistoryEntry, updateHistoryEntry } from '../history';
import { currentLocale, t } from '../i18n';
import type { HotkeySignal, NativeBridge } from '../native';
import { isGroqKeySet } from '../secrets';
import { GestureMachine, type GestureAction } from './gesture';
import { isLikelyHallucination, NothingHeardError, polish, SILENCE_PEAK_RMS, SPEECH_PEAK_RMS, transcribe } from './pipeline';

/** Hard stop for a forgotten hands-free recording. */
const MAX_RECORDING_MS = 10 * 60 * 1000;
/** The recorder answers a stop within a few milliseconds. Anything past this is a dead window. */
const AUDIO_TIMEOUT_MS = 5_000;
const MIN_RECORDING_MS = 200;
/** Asking the helper where the focus is takes a few milliseconds; a hung target app gets this long. */
const FOCUS_TIMEOUT_MS = 400;

export interface EngineHost {
  getSettings(): AppSettings;
  getPermissions(): PermissionsState;
  requestMicrophone(): void;
  isLocalModelReady(): boolean;
  /** The renderer that owns the microphone, created on demand. */
  getRecorder(): Promise<WebContents | null>;
  setStatus(status: AppStatus): void;
  broadcastHistory(entries: HistoryEntry[]): void;
  /** A system notification. Clicking it opens Yap; the window itself never opens on its own. */
  notify(title: string, body: string): void;
  notifyHotkey(down: boolean): void;
  /**
   * Whether a text field has focus in a Yap window. Null when no Yap window
   * has focus, so the text goes to another app.
   */
  ownTextFieldFocused(): Promise<boolean | null>;
}

interface Session {
  id: number;
  startedAt: number;
  handsfree: boolean;
  maxTimer: ReturnType<typeof setTimeout>;
}

interface PendingAudio {
  resolve: (audio: RecordedAudio) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Job {
  phase: 'transcribing' | 'rewriting' | 'pasting';
  preview?: string;
  /** Started from History, not by the hotkey. */
  retranscribing?: boolean;
}

interface DeliverySlot {
  previous: Promise<void>;
  release: () => void;
}

type Delivery = DeliveryOutcome;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns a dictation from key press to pasted text.
 *
 * The microphone opens on the first press, the transcription connection is
 * warmed up while the user speaks, and nothing touches the disk on the way
 * from key release to paste. A new recording can start while the previous one
 * is still being transcribed; results are always pasted in the order they
 * were spoken.
 */
export class DictationEngine {
  private readonly gesture = new GestureMachine((action) => this.onGesture(action));
  private session: Session | null = null;
  private nextSessionId = 1;
  private readonly pendingAudio = new Map<number, PendingAudio>();
  private readonly jobs: Job[] = [];
  private deliveryTail: Promise<void> = Promise.resolve();
  private lastResult: AppStatus | null = null;
  private resultTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: EngineHost,
    private readonly bridge: NativeBridge,
  ) {}

  /* ── Input ─────────────────────────────────────────────────────────── */

  handleHotkey(signal: HotkeySignal): void {
    if (signal.type === 'chord') {
      this.gesture.chord();
      return;
    }
    this.host.notifyHotkey(signal.type === 'down');
    if (signal.type === 'down') {
      this.gesture.keyDown();
    } else {
      this.gesture.keyUp();
    }
  }

  handleRecorderEvent(event: RecorderEvent): void {
    if (event.type !== 'failed') return;

    const pending = this.pendingAudio.get(event.sessionId);
    if (pending) {
      this.pendingAudio.delete(event.sessionId);
      clearTimeout(pending.timer);
      pending.reject(new Error(event.message));
    }

    if (this.session?.id === event.sessionId) {
      const session = this.session;
      this.session = null;
      clearTimeout(session.maxTimer);
      this.gesture.reset();
      this.showResult({ phase: 'error', title: t().status.microphoneError, detail: event.message });
    }
  }

  handleRecordedAudio(audio: RecordedAudio): void {
    const pending = this.pendingAudio.get(audio.sessionId);
    if (!pending) return;
    this.pendingAudio.delete(audio.sessionId);
    clearTimeout(pending.timer);
    pending.resolve(audio);
  }

  /** The current idle text, e.g. after the hotkey changed. */
  refreshStatus(): void {
    this.publishStatus();
  }

  private onGesture(action: GestureAction): void {
    switch (action) {
      case 'start':
        void this.startSession();
        break;
      case 'handsfree':
        if (this.session) {
          this.session.handsfree = true;
          this.publishStatus();
        }
        break;
      case 'stop':
        void this.stopSession();
        break;
      case 'cancel':
        void this.cancelSession();
        break;
    }
  }

  /* ── Recording ─────────────────────────────────────────────────────── */

  private findBlocker(): { title: string; detail: string; openApp: boolean } | null {
    const settings = this.host.getSettings();
    const { microphone } = this.host.getPermissions();
    const { status } = t();

    if (microphone === 'denied' || microphone === 'restricted') {
      return { title: status.microphoneBlocked, detail: status.microphoneBlockedDetail, openApp: true };
    }
    if (microphone === 'not-determined') {
      this.host.requestMicrophone();
      return { title: status.microphoneNeeded, detail: status.microphoneNeededDetail, openApp: false };
    }
    if (settings.transcriptionMode === 'cloud' && !isGroqKeySet(settings)) {
      return { title: status.groqKeyMissing, detail: status.groqKeyMissingDetail, openApp: true };
    }
    if (settings.transcriptionMode === 'local' && !this.host.isLocalModelReady()) {
      return { title: status.localModelMissing, detail: status.localModelMissingDetail, openApp: true };
    }
    return null;
  }

  private async startSession(): Promise<void> {
    const blocker = this.findBlocker();
    if (blocker) {
      this.gesture.reset();
      this.showResult({ phase: 'error', title: blocker.title, detail: blocker.detail });
      // The user is in another app: tell them, but leave the window closed.
      if (blocker.openApp) this.host.notify(blocker.title, blocker.detail);
      return;
    }

    const settings = this.host.getSettings();
    const id = this.nextSessionId++;
    const session: Session = {
      id,
      startedAt: Date.now(),
      handsfree: false,
      maxTimer: setTimeout(() => this.onMaxDuration(id), MAX_RECORDING_MS),
    };
    this.session = session;
    this.clearResult();
    this.publishStatus();

    // Everything that can happen while the user speaks happens now.
    if (settings.transcriptionMode === 'cloud') prewarmGroq();
    if (settings.autoPaste && !settings.copyToClipboard) this.bridge.prepareClipboard();

    const recorder = await this.host.getRecorder();
    if (this.session !== session) return;
    if (!recorder) {
      this.handleRecorderEvent({ type: 'failed', sessionId: id, message: t().status.recorderUnavailable });
      return;
    }
    recorder.send('recorder:command', { type: 'start', sessionId: id, encodeOpus: settings.transcriptionMode === 'cloud' });
  }

  private async cancelSession(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = null;
    clearTimeout(session.maxTimer);
    this.publishStatus();
    const recorder = await this.host.getRecorder();
    recorder?.send('recorder:command', { type: 'cancel', sessionId: session.id });
  }

  private onMaxDuration(sessionId: number): void {
    if (this.session?.id !== sessionId) return;
    console.log('[yap] recording reached the length limit');
    this.gesture.reset();
    void this.stopSession();
  }

  private awaitAudio(sessionId: number): Promise<RecordedAudio> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAudio.delete(sessionId);
        reject(new Error(t().status.recordingUnfinished));
      }, AUDIO_TIMEOUT_MS);
      this.pendingAudio.set(sessionId, { resolve, reject, timer });
    });
  }

  /**
   * Where the user is when the dictation ends. That app gets the text and
   * decides the style, no matter where the dictation started.
   */
  private focusAtRelease(): Promise<FocusInfo | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), FOCUS_TIMEOUT_MS);
    });
    const focus = this.bridge
      .getFocus()
      .then((value) => value ?? undefined)
      .catch(() => undefined);
    return Promise.race([focus, timeout]).finally(() => clearTimeout(timer));
  }

  /** Reserves this dictation's place in the paste order at the moment it ends. */
  private reserveDeliverySlot(): DeliverySlot {
    const previous = this.deliveryTail;
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.deliveryTail = done;
    return { previous, release };
  }

  private async stopSession(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = null;
    clearTimeout(session.maxTimer);

    const releasedAt = Date.now();
    const focus = this.focusAtRelease();
    const audioPromise = this.awaitAudio(session.id);
    // Awaited below; this only keeps an early failure path from leaving it unhandled.
    audioPromise.catch(() => undefined);
    const slot = this.reserveDeliverySlot();
    const job: Job = { phase: 'transcribing' };
    this.jobs.push(job);
    this.publishStatus();

    try {
      const recorder = await this.host.getRecorder();
      if (!recorder) throw new Error(t().status.recorderUnavailable);
      recorder.send('recorder:command', { type: 'stop', sessionId: session.id });
      const audio = await audioPromise;
      await this.process(job, audio, releasedAt, slot, focus);
    } catch (error) {
      if (error instanceof NothingHeardError) {
        this.showResult({ phase: 'error', title: t().status.nothingHeard, detail: error.message });
      } else {
        console.warn('[yap] dictation failed:', errorMessage(error));
        this.showResult({ phase: 'error', title: t().status.dictationFailed, detail: errorMessage(error) });
      }
    } finally {
      slot.release();
      this.jobs.splice(this.jobs.indexOf(job), 1);
      this.publishStatus();
    }
  }

  /* ── Processing ────────────────────────────────────────────────────── */

  private async process(
    job: Job,
    audio: RecordedAudio,
    releasedAt: number,
    slot: DeliverySlot,
    focusPromise: Promise<FocusInfo | undefined>,
  ): Promise<void> {
    const settings = this.host.getSettings();

    if (audio.durationMs < MIN_RECORDING_MS || audio.peakRms < SILENCE_PEAK_RMS) {
      throw new NothingHeardError();
    }

    const wav = new Uint8Array(audio.wav);
    const opus = audio.opus && audio.opus.byteLength > 0 ? new Uint8Array(audio.opus) : null;
    const historyId = randomUUID();
    // Saved in the background while the request runs, so a failed dictation
    // can still be retranscribed from History.
    const persisted = this.persistRecording(historyId, settings, wav, focusPromise);

    const [dictionary, corrections, rules] = await Promise.all([loadDictionary(), loadCorrections(), loadAppRules()]);

    const transcribeStartedAt = Date.now();
    let outcome;
    try {
      outcome = await transcribe(settings, { wav, opus }, dictionary, corrections, {
        expectSpeech: audio.peakRms >= SPEECH_PEAK_RMS,
      });
    } catch (error) {
      await persisted;
      await this.updateEntry(historyId, { status: 'transcription-failed', errorMessage: errorMessage(error) });
      throw error;
    }
    const transcribeMs = Date.now() - transcribeStartedAt;

    const rawText = outcome.text.trim();
    if (!rawText || isLikelyHallucination(rawText, audio.peakRms)) {
      await persisted;
      await this.discardRecording(historyId, settings);
      throw new NothingHeardError();
    }

    const corrected = applyCorrections(rawText, corrections);
    // Resolved long ago in practice: the helper answers while Groq is still busy.
    const focus = await focusPromise;
    const style = resolveStyleForApp(focus, rules, settings.styleMode, settings.enhancementLevel);

    if (settings.enhancementEnabled && style.polish && isGroqKeySet(settings)) {
      job.phase = 'rewriting';
      job.preview = corrected;
      this.publishStatus();
    }
    // Off in Style stops polishing everywhere (polish() checks it); an app
    // rule set to Off stops it for that app.
    const polished = style.polish
      ? await polish({
          settings,
          text: corrected,
          styleMode: style.styleMode,
          enhancementLevel: style.enhancementLevel,
          dictionary,
          corrections,
        })
      : { text: corrected, durationMs: null };

    job.phase = 'pasting';
    job.preview = polished.text;
    this.publishStatus();

    await slot.previous;
    const delivery = await this.deliver(polished.text, settings);
    slot.release();

    const metrics: DictationMetrics = {
      recordingMs: audio.durationMs,
      transcribeMs,
      rewriteMs: polished.durationMs,
      totalMs: Date.now() - releasedAt,
      uploadBytes: outcome.uploadBytes,
    };
    // Lengths only: dictated text never goes into the log file.
    console.log('[yap:dictation]', {
      source: outcome.source,
      model: outcome.source === 'cloud' ? settings.cloudModel : settings.localModel,
      rewriteModel: polished.model ?? null,
      style: style.styleMode,
      level: style.enhancementLevel,
      matchedApp: style.matchedApp ?? null,
      chars: polished.text.length,
      delivery,
      ...metrics,
    });

    await persisted;
    await this.updateEntry(historyId, {
      rawText,
      finalText: polished.text,
      transcriptionSource: outcome.source,
      styleMode: style.styleMode,
      enhancementLevel: style.enhancementLevel,
      appName: focus?.appName,
      appBundleId: focus?.bundleIdentifier,
      status: 'success',
      errorMessage: polished.notice,
      latencyMs: metrics.totalMs,
      rewriteModel: polished.model,
      appRule: style.matchedApp,
    });

    this.showResult(this.describeDelivery(delivery, polished.text, metrics, polished.notice));
  }

  private describeDelivery(delivery: Delivery, text: string, metrics: DictationMetrics, notice?: string): AppStatus {
    const { status } = t();
    const timing = status.doneIn(formatSeconds(metrics.totalMs, currentLocale()));
    const base = { phase: 'done' as const, preview: text, metrics, delivery };
    switch (delivery) {
      case 'pasted':
        return { ...base, title: status.pasted, detail: notice ?? timing };
      case 'copied':
        return { ...base, title: status.copied, detail: notice ?? `${timing} ${status.onClipboard}` };
      case 'saved':
        return { ...base, title: status.saved, detail: notice ?? `${timing} ${status.inHistory}` };
      case 'needs-accessibility':
        return { ...base, title: status.copiedInstead, detail: status.needsAccessibility };
      case 'paste-failed':
        return { ...base, title: status.copiedInstead, detail: status.pasteFailed };
      case 'no-target':
        return { ...base, title: status.copied, detail: status.noTarget };
    }
  }

  private async deliver(text: string, settings: AppSettings): Promise<Delivery> {
    if (settings.autoPaste) {
      // Cmd+V goes to whatever has focus right now. A Yap window in front
      // only takes the text into a focused text field.
      const ownTextField = await this.host.ownTextFieldFocused().catch(() => null);
      if (ownTextField === false) {
        console.info('[yap] not pasting: a Yap window is in front without a text field');
        clipboard.writeText(text);
        return 'no-target';
      }

      const result = await this.bridge.paste({
        text,
        // Only when the user did not ask for the text on the clipboard: then
        // the old clipboard comes back and history managers skip the text.
        restoreClipboard: !settings.copyToClipboard,
        selfEditable: ownTextField === true,
      });
      if (result.ok) return 'pasted';

      // The text must not get lost, so it lands on the clipboard after all.
      clipboard.writeText(text);
      if (result.reason === 'accessibility') return 'needs-accessibility';
      return result.reason === 'no-target' ? 'no-target' : 'paste-failed';
    }

    if (settings.copyToClipboard) {
      clipboard.writeText(text);
      return 'copied';
    }
    return 'saved';
  }

  /**
   * Pastes an earlier dictation into whatever has focus now. Main moves the
   * Yap window out of the way first, so the app behind it is the target.
   */
  async pasteAgain(text: string): Promise<void> {
    const settings = this.host.getSettings();
    const delivery = await this.deliver(text, { ...settings, autoPaste: true });
    const { status } = t();
    const titles: Record<Delivery, string> = {
      pasted: status.pasted,
      copied: status.copied,
      saved: status.saved,
      'needs-accessibility': status.copiedInstead,
      'paste-failed': status.copiedInstead,
      'no-target': status.copied,
    };
    this.showResult({
      phase: 'done',
      title: titles[delivery],
      detail: delivery === 'pasted' ? status.pastedAgain : status.onClipboard,
      preview: text,
      delivery,
    });
  }

  /**
   * The copy-last shortcut: the newest dictation that has text goes on the
   * clipboard, whatever is running. One still being transcribed has no text
   * yet, so the one before it is the last.
   */
  async copyLastDictation(): Promise<void> {
    const { status } = t();
    const entry = (await loadHistory()).find((candidate) => candidate.status === 'success' && candidate.finalText);
    if (!entry) {
      this.showResult({ phase: 'error', title: status.nothingToCopy, detail: status.nothingToCopyDetail });
      return;
    }
    clipboard.writeText(entry.finalText);
    this.showResult({ phase: 'done', title: status.copied, detail: status.lastCopied, preview: entry.finalText, delivery: 'copied' });
  }

  /* ── History ───────────────────────────────────────────────────────── */

  private async persistRecording(
    id: string,
    settings: AppSettings,
    wav: Uint8Array,
    focusPromise: Promise<FocusInfo | undefined>,
  ): Promise<void> {
    let audioFilename: string | null = null;
    try {
      audioFilename = (await writeAudioRecording(settings, id, Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength))).filename;
    } catch (error) {
      console.warn('[yap] audio could not be saved:', errorMessage(error));
    }

    const focus = await focusPromise;
    try {
      const { entries } = await addHistoryEntry({
        id,
        rawText: '',
        finalText: '',
        transcriptionSource: null,
        styleMode: settings.styleMode,
        enhancementLevel: settings.enhancementLevel,
        appName: focus?.appName,
        appBundleId: focus?.bundleIdentifier,
        audioFilename,
        status: 'audio-only',
      });
      this.host.broadcastHistory(entries);
    } catch (error) {
      console.warn('[yap] history entry could not be created:', errorMessage(error));
    }
  }

  private async updateEntry(id: string, patch: Parameters<typeof updateHistoryEntry>[1]): Promise<void> {
    try {
      const { entries } = await updateHistoryEntry(id, patch);
      this.host.broadcastHistory(entries);
    } catch (error) {
      console.warn('[yap] history entry could not be updated:', errorMessage(error));
    }
  }

  private async discardRecording(id: string, settings: AppSettings): Promise<void> {
    const entry = (await loadHistory()).find((candidate) => candidate.id === id);
    if (entry?.audioFilename) {
      await deleteAudioRecording(settings, entry.audioFilename).catch(() => undefined);
    }
    this.host.broadcastHistory(await removeHistoryEntry(id));
  }

  async retranscribe(id: string, mode: RetranscribeMode): Promise<HistoryEntry[]> {
    const settings = this.host.getSettings();
    const entry = (await loadHistory()).find((candidate) => candidate.id === id);
    if (!entry) throw new Error(t().status.entryGone);
    if (!entry.audioFilename) throw new Error(t().status.audioExpired);

    const wav = await readAudioRecording(settings, entry.audioFilename).catch(() => null);
    if (!wav) throw new Error(t().status.audioMissing);

    const job: Job = { phase: 'transcribing', retranscribing: true };
    this.jobs.push(job);
    this.publishStatus();

    try {
      const [dictionary, corrections] = await Promise.all([loadDictionary(), loadCorrections()]);
      const outcome = await transcribe(settings, { wav: new Uint8Array(wav), opus: null }, dictionary, corrections);
      const rawText = outcome.text.trim();
      if (!rawText) {
        const { status } = t();
        await this.updateEntry(id, { status: 'transcription-failed', errorMessage: status.noSpeech });
        this.showResult({ phase: 'error', title: status.nothingHeard, detail: status.noSpeech });
        return loadHistory();
      }

      let finalText = rawText;
      let notice: string | undefined;
      if (mode === 'transcribe-and-stylize') {
        job.phase = 'rewriting';
        this.publishStatus();
        const polished = await polish({
          settings,
          text: applyCorrections(rawText, corrections),
          styleMode: settings.styleMode,
          enhancementLevel: settings.enhancementLevel,
          dictionary,
          corrections,
        });
        finalText = polished.text;
        notice = polished.notice;
      }

      await this.updateEntry(id, {
        rawText,
        finalText,
        transcriptionSource: outcome.source,
        styleMode: settings.styleMode,
        enhancementLevel: settings.enhancementLevel,
        status: 'success',
        errorMessage: notice,
      });
      this.showResult({
        phase: 'done',
        title: t().status.retranscribed,
        detail: notice ?? t().status.retranscribedDetail,
        preview: finalText,
      });
      return loadHistory();
    } catch (error) {
      await this.updateEntry(id, { status: 'transcription-failed', errorMessage: errorMessage(error) });
      this.showResult({ phase: 'error', title: t().status.retranscriptionFailed, detail: errorMessage(error) });
      throw error;
    } finally {
      this.jobs.splice(this.jobs.indexOf(job), 1);
      this.publishStatus();
    }
  }

  /* ── Status ────────────────────────────────────────────────────────── */

  private publishStatus(): void {
    const { status, keys } = t();
    const label = hotkeyLabel(this.host.getSettings().hotkey, keys);

    if (this.session) {
      const handsfree = this.session.handsfree;
      this.host.setStatus({
        phase: 'listening',
        title: handsfree ? status.handsfree : status.listening,
        detail: handsfree ? status.pressToFinish(label) : status.releaseToFinish(label),
        handsfree,
      });
      return;
    }

    const job = this.jobs[0];
    if (job) {
      this.host.setStatus({
        phase: job.phase,
        title: job.retranscribing ? status.retranscribing : status.phases[job.phase],
        detail: status.phaseDetails[job.phase],
        preview: job.preview,
      });
      return;
    }

    this.host.setStatus(this.lastResult ?? { phase: 'idle', title: status.ready, detail: status.holdToDictate(label) });
  }

  private showResult(status: AppStatus): void {
    this.lastResult = status;
    if (this.resultTimer) clearTimeout(this.resultTimer);
    this.resultTimer = setTimeout(() => {
      this.resultTimer = null;
      this.lastResult = null;
      this.publishStatus();
    }, status.phase === 'error' ? 4_000 : 2_500);
    this.publishStatus();
  }

  private clearResult(): void {
    if (this.resultTimer) clearTimeout(this.resultTimer);
    this.resultTimer = null;
    this.lastResult = null;
  }
}
