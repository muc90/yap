import { app } from 'electron';
import path from 'node:path';

import type { AppSettings } from '../shared/types';
import { DEFAULT_HOTKEY, DEFAULT_HOTKEY_WINDOWS } from '../shared/hotkeys';
import { DEFAULT_CLOUD_MODEL, DEFAULT_LOCAL_MODEL, DEFAULT_REWRITE_MODEL } from '../shared/models';

export const APP_NAME = 'Yap';
export const SETTINGS_VERSION = 2;

export function getDefaultStorageDirectory(): string {
  return path.join(app.getPath('documents'), APP_NAME);
}

export function createDefaultSettings(): AppSettings {
  return {
    settingsVersion: SETTINGS_VERSION,
    storageDirectory: getDefaultStorageDirectory(),
    transcriptionMode: 'cloud',
    cloudModel: DEFAULT_CLOUD_MODEL,
    localModel: DEFAULT_LOCAL_MODEL,
    language: 'de',
    groqApiKeyEncrypted: '',
    enhancementEnabled: true,
    rewriteModel: DEFAULT_REWRITE_MODEL,
    styleMode: 'conversation',
    customPlusVoice: 'conversation',
    enhancementLevel: 'medium',
    hotkey: process.platform === 'darwin' ? DEFAULT_HOTKEY : DEFAULT_HOTKEY_WINDOWS,
    autoPaste: true,
    copyToClipboard: false,
    showOverlay: true,
    overlayPosition: 'bottom-center',
    launchAtLogin: false,
    theme: 'system',
    uiLanguage: 'system',
    copyLastShortcut: '',
    setupComplete: false,
    setupStep: 'welcome',
  };
}
