import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WebContents } from 'electron';

import type { AppRule, AppSettings, AppStatus, FocusInfo, PermissionsState, RecorderCommand } from '../../src/shared/types';

const pipeline = vi.hoisted(() => ({
  transcribe: vi.fn(),
  polish: vi.fn(),
}));
const keyState = vi.hoisted(() => ({ set: true }));
const rulesState = vi.hoisted(() => ({ rules: [] as AppRule[] }));
const historyState = vi.hoisted(() => ({
  entries: [] as Array<{ id: string; appName?: string; styleMode?: string; appRule?: string; status?: string; finalText?: string }>,
}));

vi.mock('../../src/main/dictation/pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/dictation/pipeline')>()),
  transcribe: pipeline.transcribe,
  polish: pipeline.polish,
}));
vi.mock('../../src/main/app-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/app-rules')>()),
  loadAppRules: async () => rulesState.rules,
}));
vi.mock('../../src/main/dictionary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/dictionary')>()),
  loadDictionary: async () => [],
  loadCorrections: async () => [],
}));
vi.mock('../../src/main/audio-store', () => ({
  writeAudioRecording: async (_settings: unknown, id: string) => ({ filename: `${id}.wav`, absolutePath: `/tmp/${id}.wav` }),
  readAudioRecording: async () => Buffer.alloc(0),
  deleteAudioRecording: async () => undefined,
  computeAudioExpiresAt: (iso: string) => iso,
}));
vi.mock('../../src/main/history', () => ({
  loadHistory: async () => historyState.entries,
  addHistoryEntry: async (input: { id: string }) => {
    historyState.entries = [input, ...historyState.entries];
    return { entry: input, entries: historyState.entries };
  },
  updateHistoryEntry: async (id: string, patch: object) => {
    historyState.entries = historyState.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
    return { entry: historyState.entries.find((entry) => entry.id === id) ?? null, entries: historyState.entries };
  },
  removeHistoryEntry: async (id: string) => {
    historyState.entries = historyState.entries.filter((entry) => entry.id !== id);
    return historyState.entries;
  },
}));
vi.mock('../../src/main/groq', () => ({ prewarmGroq: vi.fn() }));
vi.mock('../../src/main/secrets', () => ({ isGroqKeySet: () => keyState.set }));

import { clipboard } from 'electron';

import { DictationEngine } from '../../src/main/dictation/engine';
import { createDefaultSettings } from '../../src/main/defaults';
import { setLocale } from '../../src/main/i18n';
import type { NativeBridge } from '../../src/main/native';

const permissions: PermissionsState = {
  microphone: 'granted',
  accessibility: true,
  inputMonitoring: true,
  hotkeyActive: true,
  hotkeyError: null,
  nativePermissionsRequired: true,
};

let now = 0;
let settings: AppSettings;
let commands: RecorderCommand[];
let statuses: AppStatus[];
let pasted: Array<{ text: string; restoreClipboard: boolean; selfEditable: boolean }>;
let pasteResult: { ok: boolean; reason?: 'accessibility' | 'no-target' };
let peakRms: number;
let notify: Mock<(title: string, body: string) => void>;
let prepareClipboard: Mock<() => void>;
/** What the helper reports as focused each time it is asked. */
let focusNow: FocusInfo | null;
let focusQueries: number;
/** null: no Yap window has focus. */
let ownTextField: boolean | null;
let engine: DictationEngine;

const NOTES: FocusInfo = { appName: 'Notes', bundleIdentifier: 'com.apple.Notes', processIdentifier: 42 };
const SLACK: FocusInfo = { appName: 'Slack', bundleIdentifier: 'com.tinyspeck.slackmacgap', processIdentifier: 77 };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/* Date.now is mocked, so the deadline is measured with performance.now. */
async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const begin = performance.now();
  while (!check()) {
    if (performance.now() - begin > timeoutMs) throw new Error('condition not met');
    await flush();
  }
}

async function hold(ms: number): Promise<void> {
  engine.handleHotkey({ type: 'down' });
  await flush();
  now += ms;
  engine.handleHotkey({ type: 'up' });
  await flush();
}

beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  settings = { ...createDefaultSettings(), groqApiKeyEncrypted: 'cipher' };
  commands = [];
  statuses = [];
  pasted = [];
  pasteResult = { ok: true };
  peakRms = 0.2;
  keyState.set = true;
  clipboard.writeText('previous clipboard');
  notify = vi.fn();
  prepareClipboard = vi.fn();
  focusNow = NOTES;
  focusQueries = 0;
  ownTextField = null;
  rulesState.rules = [];
  historyState.entries = [];

  pipeline.transcribe.mockReset().mockResolvedValue({ text: 'hallo welt', source: 'cloud', uploadBytes: 1200 });
  pipeline.polish.mockReset().mockImplementation(async ({ text }: { text: string }) => ({ text: `${text}!`, durationMs: 5 }));

  const recorder = {
    send: (_channel: string, command: RecorderCommand) => {
      commands.push(command);
      if (command.type === 'stop') {
        setTimeout(() =>
          engine.handleRecordedAudio({
            sessionId: command.sessionId,
            wav: new ArrayBuffer(64),
            opus: new ArrayBuffer(8),
            durationMs: 1_500,
            peakRms,
          }),
        );
      }
    },
  } as unknown as WebContents;

  const bridge = {
    prepareClipboard,
    getFocus: async () => {
      focusQueries += 1;
      return focusNow;
    },
    paste: async (request: { text: string; restoreClipboard: boolean; selfEditable: boolean }) => {
      pasted.push({ text: request.text, restoreClipboard: request.restoreClipboard, selfEditable: request.selfEditable });
      return pasteResult;
    },
  } as unknown as NativeBridge;

  engine = new DictationEngine(
    {
      getSettings: () => settings,
      getPermissions: () => permissions,
      requestMicrophone: () => undefined,
      isLocalModelReady: () => true,
      getRecorder: async () => recorder,
      setStatus: (status) => statuses.push(status),
      broadcastHistory: () => undefined,
      notify,
      notifyHotkey: () => undefined,
      ownTextFieldFocused: async () => ownTextField,
    },
    bridge,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DictationEngine', () => {
  it('opens the microphone on the first press and asks for Opus in cloud mode', async () => {
    engine.handleHotkey({ type: 'down' });
    await flush();
    expect(commands).toEqual([{ type: 'start', sessionId: 1, encodeOpus: true }]);
    expect(statuses.at(-1)?.phase).toBe('listening');
  });

  it('pastes the polished text and restores the clipboard when copying is off', async () => {
    await hold(1_200);
    await waitFor(() => pasted.length === 1);

    expect(commands.map((command) => command.type)).toEqual(['start', 'stop']);
    expect(prepareClipboard).toHaveBeenCalledTimes(1);
    expect(pasted).toEqual([{ text: 'hallo welt!', restoreClipboard: true, selfEditable: false }]);
    expect(clipboard.readText()).toBe('previous clipboard');
    await waitFor(() => statuses.at(-1)?.phase === 'done');
    expect(statuses.at(-1)?.title).toBe('Pasted');
  });

  it('leaves the text on the clipboard when copying is on', async () => {
    settings = { ...settings, copyToClipboard: true };
    await hold(1_200);
    await waitFor(() => pasted.length === 1);

    expect(prepareClipboard).not.toHaveBeenCalled();
    expect(pasted[0].restoreClipboard).toBe(false);
  });

  it('only copies when pasting is off and copying is on', async () => {
    settings = { ...settings, autoPaste: false, copyToClipboard: true };
    await hold(1_200);
    await waitFor(() => statuses.at(-1)?.phase === 'done');

    expect(pasted).toHaveLength(0);
    expect(clipboard.readText()).toBe('hallo welt!');
  });

  it('touches neither paste nor clipboard when both are off', async () => {
    settings = { ...settings, autoPaste: false, copyToClipboard: false };
    await hold(1_200);
    await waitFor(() => statuses.at(-1)?.phase === 'done');

    expect(pasted).toHaveLength(0);
    expect(clipboard.readText()).toBe('previous clipboard');
    expect(statuses.at(-1)?.title).toBe('Saved');
  });

  it('copies instead when Accessibility blocks the paste', async () => {
    pasteResult = { ok: false, reason: 'accessibility' };
    await hold(1_200);
    await waitFor(() => statuses.at(-1)?.phase === 'done');

    expect(clipboard.readText()).toBe('hallo welt!');
    expect(statuses.at(-1)?.title).toBe('Copied instead');
  });

  it('pastes in speaking order even when the second result is ready first', async () => {
    let releaseFirst!: () => void;
    pipeline.transcribe
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve({ text: 'erster', source: 'cloud', uploadBytes: 1 });
          }),
      )
      .mockImplementationOnce(async () => ({ text: 'zweiter', source: 'cloud', uploadBytes: 1 }));

    await hold(1_200);
    await waitFor(() => pipeline.transcribe.mock.calls.length === 1);
    now += 5_000;
    await hold(1_200);
    await waitFor(() => pipeline.transcribe.mock.calls.length === 2);
    await flush();
    expect(pasted).toHaveLength(0);

    releaseFirst();
    await waitFor(() => pasted.length === 2);
    expect(pasted.map((entry) => entry.text)).toEqual(['erster!', 'zweiter!']);
  });

  it('skips silent recordings without calling Groq', async () => {
    peakRms = 0.001;
    await hold(1_200);
    await waitFor(() => statuses.at(-1)?.phase === 'error');

    expect(pipeline.transcribe).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.title).toBe('Nothing heard');
    expect(pasted).toHaveLength(0);
  });

  it('drops a Whisper hallucination on a quiet recording', async () => {
    peakRms = 0.01;
    pipeline.transcribe.mockResolvedValueOnce({ text: 'Untertitel im Auftrag des ZDF, 2017', source: 'cloud', uploadBytes: 1 });
    await hold(1_200);
    await waitFor(() => statuses.at(-1)?.phase === 'error');

    expect(statuses.at(-1)?.title).toBe('Nothing heard');
    expect(pasted).toHaveLength(0);
  });

  it('cancels a single accidental tap', async () => {
    await hold(60);
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(commands.map((command) => command.type)).toEqual(['start', 'cancel']);
    expect(pipeline.transcribe).not.toHaveBeenCalled();
  });

  it('drops the recording when fn is used as a modifier', async () => {
    engine.handleHotkey({ type: 'down' });
    await flush();
    now += 400;
    engine.handleHotkey({ type: 'chord' });
    await flush();
    engine.handleHotkey({ type: 'up' });
    await flush();

    expect(commands.map((command) => command.type)).toEqual(['start', 'cancel']);
    expect(pipeline.transcribe).not.toHaveBeenCalled();
  });

  it('does not start when the Groq key is missing and notifies instead of opening the window', async () => {
    keyState.set = false;
    engine.handleHotkey({ type: 'down' });
    await flush();

    expect(commands).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith('Groq key missing', expect.any(String));
    expect(statuses.at(-1)?.title).toBe('Groq key missing');
  });

  it('asks where the focus is when the key is released, not when it is pressed', async () => {
    engine.handleHotkey({ type: 'down' });
    await flush();
    expect(focusQueries).toBe(0);

    focusNow = SLACK;
    now += 1_200;
    engine.handleHotkey({ type: 'up' });
    await waitFor(() => pasted.length === 1);

    expect(focusQueries).toBe(1);
    await waitFor(() => historyState.entries[0]?.appName === 'Slack');
  });

  it('started in one app and released in another: the second app gets text and style', async () => {
    rulesState.rules = [
      { appIdentifier: NOTES.bundleIdentifier!, label: 'Notes', styleMode: 'conversation', enhancementLevel: 'soft' },
      { appIdentifier: SLACK.bundleIdentifier!, label: 'Slack', styleMode: 'vibe-coding', enhancementLevel: 'high' },
    ];
    focusNow = NOTES;
    engine.handleHotkey({ type: 'down' });
    await flush();
    focusNow = SLACK;
    now += 1_500;
    engine.handleHotkey({ type: 'up' });
    await waitFor(() => pasted.length === 1);

    expect(pipeline.polish).toHaveBeenCalledWith(expect.objectContaining({ styleMode: 'vibe-coding', enhancementLevel: 'high' }));
    expect(historyState.entries[0]).toMatchObject({ appName: 'Slack' });
  });

  it('leaves the text unpolished in an app whose rule says Off, and records the rule', async () => {
    rulesState.rules = [{ appIdentifier: SLACK.bundleIdentifier!, label: 'Slack', styleMode: 'conversation', enhancementLevel: 'off' }];
    focusNow = SLACK;
    await hold(1_200);
    await waitFor(() => pasted.length === 1);

    expect(pipeline.polish).not.toHaveBeenCalled();
    expect(pasted[0].text).toBe('hallo welt');
    await waitFor(() => (historyState.entries[0] as { appRule?: string })?.appRule === 'Slack');
  });

  it('records which app rule styled a dictation', async () => {
    rulesState.rules = [{ appIdentifier: SLACK.bundleIdentifier!, label: 'Slack', styleMode: 'vibe-coding', enhancementLevel: 'high' }];
    focusNow = SLACK;
    await hold(1_200);
    await waitFor(() => pasted.length === 1);

    expect(pipeline.polish).toHaveBeenCalledWith(expect.objectContaining({ styleMode: 'vibe-coding', enhancementLevel: 'high' }));
    await waitFor(() => (historyState.entries[0] as { appRule?: string })?.appRule === 'Slack');
  });

  it('takes the focus at the stop press in hands-free mode', async () => {
    focusNow = NOTES;
    engine.handleHotkey({ type: 'down' });
    engine.handleHotkey({ type: 'up' });
    engine.handleHotkey({ type: 'down' });
    engine.handleHotkey({ type: 'up' });
    await flush();
    expect(statuses.at(-1)?.handsfree).toBe(true);

    focusNow = SLACK;
    now += 10_000;
    engine.handleHotkey({ type: 'down' });
    await waitFor(() => pasted.length === 1);
    await waitFor(() => historyState.entries[0]?.appName === 'Slack');
  });

  it('copies instead of pasting when Yap is in front without a text field', async () => {
    ownTextField = false;
    await hold(1_200);
    await waitFor(() => statuses.at(-1)?.phase === 'done');

    expect(pasted).toHaveLength(0);
    expect(clipboard.readText()).toBe('hallo welt!');
    expect(statuses.at(-1)).toMatchObject({ title: 'Copied', detail: expect.stringContaining('No text field was focused') });
  });

  it('pastes into a focused text field in Yap itself', async () => {
    ownTextField = true;
    await hold(1_200);
    await waitFor(() => pasted.length === 1);

    expect(pasted[0]).toMatchObject({ text: 'hallo welt!', selfEditable: true });
  });

  it('copies when the helper finds Yap in front without a text field', async () => {
    pasteResult = { ok: false, reason: 'no-target' };
    await hold(1_200);
    await waitFor(() => statuses.at(-1)?.phase === 'done');

    expect(clipboard.readText()).toBe('hallo welt!');
    expect(statuses.at(-1)?.title).toBe('Copied');
  });

  it('does not wait for a focus query that never answers', async () => {
    const bridge = (engine as unknown as { bridge: NativeBridge }).bridge as unknown as { getFocus: () => Promise<FocusInfo | null> };
    bridge.getFocus = () => new Promise(() => undefined);
    await hold(1_200);
    await waitFor(() => pasted.length === 1, 2_000);
  });

  it('copies the newest dictation with text when the copy-last shortcut is pressed', async () => {
    historyState.entries = [
      { id: 'running', status: 'audio-only', finalText: '' },
      { id: 'failed', status: 'transcription-failed', finalText: '' },
      { id: 'last', status: 'success', finalText: 'Das letzte Diktat.' },
      { id: 'older', status: 'success', finalText: 'Ein älteres.' },
    ];

    await engine.copyLastDictation();
    expect(clipboard.readText()).toBe('Das letzte Diktat.');
    expect(statuses.at(-1)).toMatchObject({ phase: 'done', title: 'Copied', delivery: 'copied', preview: 'Das letzte Diktat.' });
  });

  it('says so when there is nothing to copy yet', async () => {
    historyState.entries = [];
    await engine.copyLastDictation();
    expect(clipboard.readText()).toBe('previous clipboard');
    expect(statuses.at(-1)).toMatchObject({ phase: 'error', title: 'Nothing to copy' });
  });

  it('marks where the text went, so the pill can word it', async () => {
    await hold(1_200);
    await waitFor(() => statuses.at(-1)?.phase === 'done');
    expect(statuses.at(-1)).toMatchObject({ delivery: 'pasted' });
  });

  it('speaks German when the UI is German', async () => {
    setLocale('de');
    try {
      // The default key differs per platform (Fn on macOS, Right Alt elsewhere).
      settings = { ...settings, hotkey: { keyCode: 63, modifiers: 0, label: 'Fn' } };
      engine.refreshStatus();
      expect(statuses.at(-1)).toMatchObject({ phase: 'idle', title: 'Bereit', detail: 'Halte Fn gedrückt, um zu diktieren.' });

      settings = { ...settings, hotkey: { keyCode: 61, modifiers: 0, label: 'Right Option (⌥)' } };
      engine.handleHotkey({ type: 'down' });
      await flush();
      expect(statuses.at(-1)).toMatchObject({ title: 'Hört zu', detail: 'Lass Rechte Wahltaste (⌥) los, um zu beenden.' });
      now += 1_200;
      engine.handleHotkey({ type: 'up' });
      await waitFor(() => statuses.at(-1)?.phase === 'done');
      expect(statuses.at(-1)).toMatchObject({ title: 'Eingefügt', detail: expect.stringMatching(/^Fertig in \d+,\d\d\u00a0s\.$/) });
    } finally {
      setLocale('en');
    }
  });

  it('reports a microphone failure and resets for the next press', async () => {
    engine.handleHotkey({ type: 'down' });
    await flush();
    engine.handleRecorderEvent({ type: 'failed', sessionId: 1, message: 'No microphone was found.' });
    expect(statuses.at(-1)).toMatchObject({ phase: 'error', title: 'Microphone error' });

    engine.handleHotkey({ type: 'up' });
    engine.handleHotkey({ type: 'down' });
    await flush();
    expect(commands.filter((command) => command.type === 'start')).toHaveLength(2);
  });
});
