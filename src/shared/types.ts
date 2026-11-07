import type { UiLanguage } from './i18n';
import type { SetupStep } from './setup';

export type EnhancementLevel = 'none' | 'soft' | 'medium' | 'high';
export type StyleMode = 'conversation' | 'vibe-coding' | 'custom-plus';
export type CustomPlusVoice = 'conversation' | 'developer';
export type TranscriptionMode = 'cloud' | 'local';
/** System follows the macOS appearance. */
export type ThemePreference = 'system' | 'light' | 'dark';
/** Where the dictation pill sits on the screen. */
export type OverlayPosition = 'bottom-center' | 'top-center' | 'top-right' | 'bottom-right';
export type CloudTranscriptionModel = 'whisper-large-v3' | 'whisper-large-v3-turbo';
export type LocalWhisperModel = 'onnx-community/whisper-base' | 'onnx-community/whisper-small';

export type DictationPhase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'rewriting'
  | 'pasting'
  | 'done'
  | 'error';

export interface DictionaryEntry {
  word: string;
  addedAt: string;
}

export interface CorrectionEntry {
  from: string;
  to: string;
  addedAt: string;
}

/** A rule can also switch polishing off for its app. */
export type RuleLevel = EnhancementLevel | 'off';

export interface AppRule {
  appIdentifier: string;
  label: string;
  styleMode: StyleMode;
  enhancementLevel: RuleLevel;
}

export interface HotkeyConfig {
  keyCode: number;
  modifiers: number;
  label: string;
}

export interface AppSettings {
  settingsVersion: number;
  storageDirectory: string;
  transcriptionMode: TranscriptionMode;
  cloudModel: CloudTranscriptionModel;
  localModel: LocalWhisperModel;
  /** ISO-639-1 code, empty string means auto-detect. */
  language: string;
  groqApiKeyEncrypted: string;
  enhancementEnabled: boolean;
  rewriteModel: string;
  styleMode: StyleMode;
  customPlusVoice: CustomPlusVoice;
  enhancementLevel: EnhancementLevel;
  hotkey: HotkeyConfig;
  autoPaste: boolean;
  copyToClipboard: boolean;
  showOverlay: boolean;
  overlayPosition: OverlayPosition;
  launchAtLogin: boolean;
  theme: ThemePreference;
  /** The language of Yap itself, not the one dictated in. */
  uiLanguage: UiLanguage;
  /** Electron accelerator that copies the last dictation from anywhere; empty when off. */
  copyLastShortcut: string;
  setupComplete: boolean;
  /** Where the setup wizard resumes, e.g. after macOS restarted Yap for a permission. */
  setupStep: SetupStep;
}

/** Settings as the renderer sees them: the encrypted key never leaves main. */
export type PublicSettings = Omit<AppSettings, 'groqApiKeyEncrypted'>;

/** Why the shortcut listener is not running. The UI words it in the current language. */
export type HotkeyErrorCode =
  | 'needs-access'
  | 'refused'
  | 'helper-missing'
  | 'helper-crashing'
  | 'reconnecting'
  | 'fn-unsupported'
  | 'key-unsupported'
  | 'listener-failed'
  | 'stopped'
  | 'unsupported';

export type MicrophoneStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

export interface PermissionsState {
  microphone: MicrophoneStatus;
  accessibility: boolean;
  inputMonitoring: boolean;
  /** The global hotkey listener is running. This is the ground truth for hotkey capability. */
  hotkeyActive: boolean;
  hotkeyError: HotkeyErrorCode | null;
  /** macOS needs Accessibility and Input Monitoring, Windows does not. */
  nativePermissionsRequired: boolean;
}

export type PermissionKind = 'microphone' | 'accessibility' | 'inputMonitoring';

/** What the Globe/Fn key does in macOS keyboard settings. */
export type FnKeyAction = 'nothing' | 'input-source' | 'emoji' | 'dictation' | 'unknown';

export interface FocusInfo {
  appName?: string;
  bundleIdentifier?: string;
  processIdentifier?: number;
  /** Accessibility role of the focused element, e.g. AXTextArea. */
  role?: string;
  /** A text field or similar has focus. */
  editable?: boolean;
}

export interface DictationMetrics {
  recordingMs: number;
  transcribeMs: number;
  rewriteMs: number | null;
  /** From key release to the text arriving in the target app. */
  totalMs: number;
  uploadBytes: number | null;
}

/** Where a finished dictation went. */
export type DeliveryOutcome = 'pasted' | 'copied' | 'saved' | 'paste-failed' | 'needs-accessibility' | 'no-target';

export interface AppStatus {
  phase: DictationPhase;
  title: string;
  detail: string;
  preview?: string;
  handsfree?: boolean;
  metrics?: DictationMetrics;
  /** Set on a finished dictation, so the pill can word it without parsing the title. */
  delivery?: DeliveryOutcome;
}

export interface LocalModelDownload {
  model: LocalWhisperModel;
  progress: number;
  detail: string;
}

export interface EngineState {
  groqKeySet: boolean;
  localModelReady: boolean;
  localModelDownload: LocalModelDownload | null;
  /** Rewrite models this key can use, in catalogue order. */
  rewriteModelIds: string[];
}

export type DictationStatus = 'success' | 'transcription-failed' | 'audio-only';
export type RetranscribeMode = 'transcribe-only' | 'transcribe-and-stylize';

export interface HistoryEntry {
  id: string;
  rawText: string;
  finalText: string;
  transcriptionSource: 'cloud' | 'local' | null;
  styleMode: StyleMode;
  enhancementLevel: EnhancementLevel;
  appName?: string;
  /** Lets History offer the app for an app rule. */
  appBundleId?: string;
  /** The app rule that chose style and polish, by app name. */
  appRule?: string;
  createdAt: string;
  audioFilename: string | null;
  audioExpiresAt: string | null;
  status: DictationStatus;
  errorMessage?: string;
  /** Key release to delivered text, in milliseconds. */
  latencyMs?: number;
  /** The model that polished the text; absent when it went out as transcribed. */
  rewriteModel?: string;
}

/** Whether the copy-last shortcut is registered with the system. */
export type ShortcutState = 'off' | 'active' | 'taken';

export type UpdaterState =
  | { kind: 'idle' | 'disabled' | 'checking' | 'current' | 'error' }
  | { kind: 'available' | 'downloaded'; version: string }
  | { kind: 'downloading'; version: string; percent: number };

export interface AppState {
  updater: UpdaterState;
  platform: string;
  version: string;
  isPackaged: boolean;
  settings: PublicSettings;
  permissions: PermissionsState;
  engine: EngineState;
  dictionary: DictionaryEntry[];
  corrections: CorrectionEntry[];
  appRules: AppRule[];
  history: HistoryEntry[];
  status: AppStatus;
  fnKeyAction: FnKeyAction | null;
  copyLastShortcut: ShortcutState;
}

export type UpdateSettingsInput = Partial<Omit<PublicSettings, 'settingsVersion'>>;

export interface KeyValidationResult {
  valid: boolean;
  error?: string;
}

/* ── Recorder protocol between main and the overlay window ──────────────── */

export type RecorderCommand =
  | { type: 'start'; sessionId: number; encodeOpus: boolean }
  | { type: 'stop'; sessionId: number }
  | { type: 'cancel'; sessionId: number };

export interface RecordedAudio {
  sessionId: number;
  /** 16 kHz mono PCM16 WAV. Always present. */
  wav: ArrayBuffer;
  /** WebM/Opus, much smaller upload. Present when requested and the encoder produced data. */
  opus: ArrayBuffer | null;
  durationMs: number;
  /** Loudest 50 ms window, RMS in 0..1. Used to skip silent recordings. */
  peakRms: number;
}

export type RecorderEvent =
  | { type: 'started'; sessionId: number }
  | { type: 'failed'; sessionId: number; message: string };
