import { app, dialog } from 'electron';
import path from 'node:path';

import type {
  AppSettings,
  CloudTranscriptionModel,
  CustomPlusVoice,
  EnhancementLevel,
  HotkeyConfig,
  LocalWhisperModel,
  StyleMode,
  ThemePreference,
  TranscriptionMode,
  UpdateSettingsInput,
} from '../shared/types';
import { buildHotkeyLabel, FN_KEY_CODE } from '../shared/hotkeys';
import { UI_LANGUAGES } from '../shared/i18n';
import { isValidAccelerator } from '../shared/shortcuts';
import { CLOUD_MODELS, LANGUAGES, LOCAL_MODELS, REWRITE_MODELS } from '../shared/models';
import { SETUP_STEPS } from '../shared/setup';
import { createDefaultSettings, SETTINGS_VERSION } from './defaults';
import { t } from './i18n';
import { encryptSecret } from './secrets';
import { readJsonFile, writeJsonFile } from './json-file';

const SETTINGS_FILE = 'settings.json';

const STYLE_MODES: readonly StyleMode[] = ['conversation', 'vibe-coding', 'custom-plus'];
const VOICES: readonly CustomPlusVoice[] = ['conversation', 'developer'];
const LEVELS: readonly EnhancementLevel[] = ['none', 'soft', 'medium', 'high'];
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isHotkey(value: unknown): value is HotkeyConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.keyCode === 'number' &&
    typeof candidate.modifiers === 'number' &&
    typeof candidate.label === 'string'
  );
}

/**
 * Turns whatever is on disk into a valid current-version settings object.
 *
 * Version 1 files come from before the Groq-only cleanup: they carry the key
 * as `openaiApiKeyEncrypted`, may select the removed `auto` transcription mode
 * or the removed OpenRouter, Fireworks and Ollama rewrite paths. The key is
 * kept (it is still a Groq key unless the user pointed the old base URL
 * somewhere else), everything removed maps onto its closest survivor.
 */
export function migrateSettings(raw: unknown, defaults: AppSettings): AppSettings {
  if (!raw || typeof raw !== 'object') {
    return defaults;
  }

  const source = raw as Record<string, unknown>;

  const legacyBaseUrl = typeof source.cloudApiBaseUrl === 'string' ? source.cloudApiBaseUrl : '';
  const legacyKeyIsGroq = legacyBaseUrl === '' || legacyBaseUrl.includes('groq.com');
  const groqApiKeyEncrypted =
    typeof source.groqApiKeyEncrypted === 'string'
      ? source.groqApiKeyEncrypted
      : typeof source.openaiApiKeyEncrypted === 'string' && legacyKeyIsGroq
        ? source.openaiApiKeyEncrypted
        : '';
  const hasKey = groqApiKeyEncrypted.length > 0;

  let transcriptionMode: TranscriptionMode;
  if (source.transcriptionMode === 'cloud' || source.transcriptionMode === 'local') {
    transcriptionMode = source.transcriptionMode;
  } else if (source.transcriptionMode === 'auto') {
    transcriptionMode = hasKey ? 'cloud' : 'local';
  } else {
    transcriptionMode = defaults.transcriptionMode;
  }

  let enhancementEnabled: boolean;
  if (typeof source.enhancementEnabled === 'boolean') {
    enhancementEnabled = source.enhancementEnabled;
  } else if (source.rewriteMode === 'local') {
    // Ollama is gone. Groq takes over when there is a key to use it with.
    enhancementEnabled = hasKey;
  } else {
    enhancementEnabled = defaults.enhancementEnabled;
  }

  const rewriteModel = REWRITE_MODELS.some((model) => model.id === source.rewriteModel)
    ? (source.rewriteModel as string)
    : REWRITE_MODELS.some((model) => model.id === source.cloudRewriteModel)
      ? (source.cloudRewriteModel as string)
      : defaults.rewriteModel;

  const rawLanguage = typeof source.language === 'string' ? source.language : source.cloudLanguage;
  const language = LANGUAGES.some((entry) => entry.code === rawLanguage)
    ? (rawLanguage as string)
    : defaults.language;

  const localModel = pick<LocalWhisperModel>(
    source.localModel ?? source.whisperModel,
    LOCAL_MODELS.map((model) => model.id),
    defaults.localModel,
  );

  return {
    settingsVersion: SETTINGS_VERSION,
    storageDirectory:
      typeof source.storageDirectory === 'string' && source.storageDirectory.length > 0
        ? source.storageDirectory
        : defaults.storageDirectory,
    transcriptionMode,
    cloudModel: pick<CloudTranscriptionModel>(
      source.cloudModel,
      CLOUD_MODELS.map((model) => model.id),
      defaults.cloudModel,
    ),
    localModel,
    language,
    groqApiKeyEncrypted,
    enhancementEnabled,
    rewriteModel,
    styleMode: pick(source.styleMode, STYLE_MODES, defaults.styleMode),
    customPlusVoice: pick(source.customPlusVoice, VOICES, defaults.customPlusVoice),
    enhancementLevel: pick(source.enhancementLevel, LEVELS, defaults.enhancementLevel),
    // Labels are derived, so older wordings (Right ⌥) follow the current one.
    // Fn never reaches X11 (the keyboard firmware handles it), so Linux falls back to Right Alt.
    hotkey: isHotkey(source.hotkey) && !(process.platform === 'linux' && source.hotkey.keyCode === FN_KEY_CODE)
      ? { ...source.hotkey, label: buildHotkeyLabel(source.hotkey.keyCode, source.hotkey.modifiers) }
      : defaults.hotkey,
    autoPaste: bool(source.autoPaste, defaults.autoPaste),
    copyToClipboard: bool(source.copyToClipboard, defaults.copyToClipboard),
    showOverlay: bool(source.showOverlay, defaults.showOverlay),
    launchAtLogin: bool(source.launchAtLogin, defaults.launchAtLogin),
    theme: pick(source.theme, THEMES, defaults.theme),
    uiLanguage: pick(source.uiLanguage, UI_LANGUAGES, defaults.uiLanguage),
    // Empty switches the shortcut off.
    copyLastShortcut:
      source.copyLastShortcut === '' || isValidAccelerator(source.copyLastShortcut)
        ? source.copyLastShortcut
        : defaults.copyLastShortcut,
    setupComplete: bool(source.setupComplete, defaults.setupComplete),
    setupStep: pick(source.setupStep, SETUP_STEPS, defaults.setupStep),
  };
}

/** Applies a renderer update, ignoring anything that would not survive a reload. */
export function applySettingsUpdate(current: AppSettings, updates: UpdateSettingsInput): AppSettings {
  return migrateSettings({ ...current, ...updates }, current);
}

export async function loadSettings(): Promise<AppSettings> {
  const defaults = createDefaultSettings();
  const raw = await readJsonFile<unknown>(getSettingsPath());
  const settings = migrateSettings(raw, defaults);

  // Rewrite the file when it was missing, broken or from an older version, so
  // the obsolete keys of removed providers do not linger on disk.
  const stored = raw as Record<string, unknown> | undefined;
  if (!stored || stored.settingsVersion !== SETTINGS_VERSION || Object.keys(stored).length !== Object.keys(settings).length) {
    await saveSettings(settings);
  }

  return settings;
}

export function saveSettings(settings: AppSettings): Promise<void> {
  return writeJsonFile(getSettingsPath(), settings);
}

export function withGroqKey(settings: AppSettings, rawKey: string): AppSettings {
  const trimmed = rawKey.trim();
  return {
    ...settings,
    groqApiKeyEncrypted: trimmed.length > 0 ? encryptSecret(trimmed) : '',
  };
}

export async function chooseStorageDirectory(currentDirectory: string): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: t().dialogs.chooseStorage,
    defaultPath: currentDirectory,
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
}
