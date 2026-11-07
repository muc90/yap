import { useEffect, useRef, useState } from 'react';

import type { AppState, HotkeyConfig } from '../../shared/types';
import {
  buildHotkeyLabel,
  DOM_BUTTON_TO_X,
  DOM_TO_MAC,
  FN_HOTKEY,
  FN_KEY_CODE,
  hotkeyLabel,
  MODIFIER_FLAGS,
  MOUSE_BUTTON_BASE,
  mouseButtonNeedsModifier,
  MODIFIER_ONLY_KEYCODES,
  RIGHT_ALT_HOTKEY,
} from '../../shared/hotkeys';
import { rich, useT } from '../lib/i18n';
import { Button, KeyCap, Notice, ToggleRow } from './ui';

function modifierFlagForKeyCode(keyCode: number): number {
  switch (keyCode) {
    case 54:
    case 55:
      return MODIFIER_FLAGS.command;
    case 58:
    case 61:
      return MODIFIER_FLAGS.option;
    case 56:
    case 60:
      return MODIFIER_FLAGS.shift;
    case 59:
    case 62:
      return MODIFIER_FLAGS.control;
    default:
      return 0;
  }
}

function HotkeyCapture({ current, onSave, mouse }: { current: HotkeyConfig; onSave: (config: HotkeyConfig) => void; mouse: boolean }) {
  const t = useT();
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const pending = useRef<{ keyCode: number; modifiers: number } | null>(null);

  useEffect(() => {
    if (!recording) return;

    const finish = (config: { keyCode: number; modifiers: number }) => {
      onSave({ ...config, label: buildHotkeyLabel(config.keyCode, config.modifiers) });
      setRecording(false);
      setPreview(null);
      pending.current = null;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === 'Escape') {
        setRecording(false);
        setPreview(null);
        pending.current = null;
        return;
      }

      let modifiers = 0;
      if (event.metaKey) modifiers |= MODIFIER_FLAGS.command;
      if (event.altKey) modifiers |= MODIFIER_FLAGS.option;
      if (event.shiftKey) modifiers |= MODIFIER_FLAGS.shift;
      if (event.ctrlKey) modifiers |= MODIFIER_FLAGS.control;

      const keyCode = DOM_TO_MAC[event.code];
      if (keyCode === undefined) return;

      if (MODIFIER_ONLY_KEYCODES.has(keyCode)) {
        // A modifier on its own is decided on release, so combos stay possible.
        pending.current = { keyCode, modifiers: modifiers & ~modifierFlagForKeyCode(keyCode) };
        setPreview(buildHotkeyLabel(keyCode, pending.current.modifiers, t.keys));
        return;
      }

      finish({ keyCode, modifiers });
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (pending.current) finish(pending.current);
    };

    // Mouse buttons (Linux helper only). Left and right only with a modifier, so a plain click stays a click.
    const handleMouseDown = (event: MouseEvent) => {
      const button = DOM_BUTTON_TO_X[event.button];
      if (!button) return;
      let modifiers = 0;
      if (event.metaKey) modifiers |= MODIFIER_FLAGS.command;
      if (event.altKey) modifiers |= MODIFIER_FLAGS.option;
      if (event.shiftKey) modifiers |= MODIFIER_FLAGS.shift;
      if (event.ctrlKey) modifiers |= MODIFIER_FLAGS.control;
      if (mouseButtonNeedsModifier(button) && modifiers === 0) return;
      event.preventDefault();
      event.stopPropagation();
      pending.current = null;
      finish({ keyCode: MOUSE_BUTTON_BASE + button, modifiers });
    };
    const swallow = (event: MouseEvent) => {
      const button = DOM_BUTTON_TO_X[event.button];
      if (button && (!mouseButtonNeedsModifier(button) || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey)) {
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    if (mouse) {
      window.addEventListener('mousedown', handleMouseDown, true);
      window.addEventListener('mouseup', swallow, true);
      window.addEventListener('auxclick', swallow, true);
      window.addEventListener('contextmenu', swallow, true);
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('mouseup', swallow, true);
      window.removeEventListener('auxclick', swallow, true);
      window.removeEventListener('contextmenu', swallow, true);
    };
  }, [recording, onSave, t, mouse]);

  return (
    <div className="hotkey-capture">
      <div className="row">
        <div className="row-text">
          <strong>{t.hotkey.dictationKey}</strong>
          <span>{recording ? (mouse ? t.hotkey.recordingHintMouse : t.hotkey.recordingHint) : t.hotkey.idleHint}</span>
        </div>
        <button
          type="button"
          className={`hotkey-button${recording ? ' hotkey-button-recording' : ''}`}
          onClick={() => {
            setRecording((value) => !value);
            setPreview(null);
            pending.current = null;
          }}
        >
          {recording ? preview ?? t.hotkey.pressKey : hotkeyLabel(current, t.keys)}
        </button>
      </div>
    </div>
  );
}

export function FnKeyNotice({ state }: { state: AppState }) {
  const t = useT();
  const usesFn = state.settings.hotkey.keyCode === FN_KEY_CODE && state.settings.hotkey.modifiers === 0;
  if (!usesFn || !state.fnKeyAction || state.fnKeyAction === 'nothing' || state.fnKeyAction === 'unknown') {
    return null;
  }

  return (
    <Notice
      tone="warning"
      action={
        <Button size="sm" onClick={() => void window.yap.openKeyboardSettings()}>
          {t.hotkey.keyboardSettings}
        </Button>
      }
    >
      {rich(t.hotkey.fnNotice, {
        fn: <KeyCap>fn</KeyCap>,
        action: t.hotkey.fnActions[state.fnKeyAction],
        setting: <em>{t.hotkey.fnSetting}</em>,
        value: <em>{t.hotkey.fnValue}</em>,
      })}
    </Notice>
  );
}

export function HotkeySettings({ state, onSave }: { state: AppState; onSave: (config: HotkeyConfig) => void }) {
  const t = useT();
  const hotkey = state.settings.hotkey;
  const isFn = hotkey.keyCode === FN_KEY_CODE && hotkey.modifiers === 0;
  const isMac = state.platform === 'darwin';

  return (
    <div className="hotkey-settings">
      {isMac && (
        <ToggleRow
          title={t.hotkey.useFn}
          description={t.hotkey.useFnHint}
          checked={isFn}
          onChange={(value) => onSave(value ? FN_HOTKEY : RIGHT_ALT_HOTKEY)}
        />
      )}
      {(!isMac || !isFn) && <HotkeyCapture current={hotkey} onSave={onSave} mouse={state.platform === 'linux'} />}
      {isMac && <FnKeyNotice state={state} />}
    </div>
  );
}
