import { en } from './i18n/en';
import type { Messages } from './i18n/en';
import type { HotkeyConfig } from './types';

export const MODIFIER_FLAGS = {
  command: 0x100000,
  option: 0x80000,
  shift: 0x20000,
  control: 0x40000,
} as const;

export const MODIFIER_LABELS: Record<string, string> = {
  command: '\u2318',
  option: '\u2325',
  shift: '\u21E7',
  control: '\u2303',
};

type KeyName = Exclude<keyof Messages['keys'], 'other' | 'pcLeftMeta' | 'pcRightMeta' | 'mouseOther'>;

/** Physical keys by KeyboardEvent.code, as macOS key codes (what settings store). */
export const DOM_TO_MAC: Record<string, number> = {
  MetaLeft: 55, MetaRight: 54,
  AltLeft: 58, AltRight: 61,
  ShiftLeft: 56, ShiftRight: 60,
  ControlLeft: 59, ControlRight: 62,
  Space: 49, Enter: 36, Tab: 48, Backspace: 51, Escape: 53,
  KeyA: 0, KeyB: 11, KeyC: 8, KeyD: 2, KeyE: 14, KeyF: 3,
  KeyG: 5, KeyH: 4, KeyI: 34, KeyJ: 38, KeyK: 40, KeyL: 37,
  KeyM: 46, KeyN: 45, KeyO: 31, KeyP: 35, KeyQ: 12, KeyR: 15,
  KeyS: 1, KeyT: 17, KeyU: 32, KeyV: 9, KeyW: 13, KeyX: 7,
  KeyY: 16, KeyZ: 6,
  Digit0: 29, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21,
  Digit5: 23, Digit6: 22, Digit7: 26, Digit8: 28, Digit9: 25,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97,
  F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
  F13: 105, F14: 107, F15: 113,
};

/**
 * Mouse buttons as dictation keys (Linux only): stored as this base plus the
 * X11 button number, so they can never collide with a macOS key code.
 */
export const MOUSE_BUTTON_BASE = 1000;

/** X11 button numbers by MouseEvent.button. */
export const DOM_BUTTON_TO_X: Record<number, number> = { 0: 1, 1: 2, 2: 3, 3: 8, 4: 9 };

/** Left and right click only work with a modifier, so plain clicks stay clicks. */
export function mouseButtonNeedsModifier(xButton: number): boolean {
  return xButton === 1 || xButton === 3;
}

export function isMouseHotkey(keyCode: number): boolean {
  return keyCode > MOUSE_BUTTON_BASE && keyCode < MOUSE_BUTTON_BASE + 64;
}

function mouseButtonName(keyCode: number, names: Messages['keys']): string {
  const button = keyCode - MOUSE_BUTTON_BASE;
  if (button === 1) return names.mouseLeft;
  if (button === 3) return names.mouseRight;
  if (button === 2) return names.mouseMiddle;
  if (button === 8) return names.mouseBack;
  if (button === 9) return names.mouseForward;
  return names.mouseOther(button);
}

export const MAC_TO_DOM: Record<number, string> = Object.fromEntries(
  Object.entries(DOM_TO_MAC).map(([code, mac]) => [mac, code]),
);

/**
 * How dictation keys are named. macOS uses its symbols (⌘⌥⇧⌃); Windows and
 * Linux use PC names (Strg, Alt, AltGr) and the letters of the user's layout,
 * so the key at the US "Y" position reads "Z" on a German QWERTZ keyboard.
 */
export interface HotkeyLabelStyle {
  mac: boolean;
  /** The Windows/Super key's name on a PC. */
  superKey: string;
  /** What the active layout prints on a key, by macOS key code. */
  printed?: (macKeyCode: number) => string | undefined;
}

let labelStyle: HotkeyLabelStyle = { mac: true, superKey: 'Win' };

/** Set once per process at startup (main and renderer each have their own). */
export function setHotkeyLabelStyle(next: Partial<HotkeyLabelStyle>): void {
  labelStyle = { ...labelStyle, ...next };
}

/** PC names of modifier keys and the keys macOS names differently. */
const PC_NAMED_KEYS: Record<number, KeyName> = {
  58: 'pcLeftAlt',
  61: 'pcRightAlt',
  59: 'pcLeftCtrl',
  62: 'pcRightCtrl',
  56: 'pcLeftShift',
  60: 'pcRightShift',
  36: 'pcReturn',
  51: 'pcDelete',
  48: 'tab',
  49: 'space',
  53: 'escape',
};

function printedKey(keyCode: number): string | undefined {
  const printed = labelStyle.printed?.(keyCode)?.trim();
  if (!printed) return undefined;
  // Keycaps show capitals, but ß would turn into SS.
  const upper = printed.toUpperCase();
  return upper.length === printed.length ? upper : printed;
}

function pcKeyName(keyCode: number, names: Messages['keys']): string {
  if (isMouseHotkey(keyCode)) return mouseButtonName(keyCode, names);
  if (keyCode === 55) return names.pcLeftMeta(labelStyle.superKey);
  if (keyCode === 54) return names.pcRightMeta(labelStyle.superKey);
  const named = PC_NAMED_KEYS[keyCode];
  if (named) return names[named];
  const literal = LITERAL_KEYS[keyCode];
  // Letters and digits as printed on the user's keyboard; F-keys and Fn read the same everywhere.
  if (literal && literal.length === 1) return printedKey(keyCode) ?? literal;
  return literal ?? names.other(keyCode);
}

/** Keys whose name depends on the language. */
const NAMED_KEYS: Record<number, KeyName> = {
  // Modifier-only keys (right-side variants)
  54: 'rightCommand',
  61: 'rightOption',
  60: 'rightShift',
  62: 'rightControl',
  // Modifier-only keys (left-side variants)
  55: 'leftCommand',
  58: 'leftOption',
  56: 'leftShift',
  59: 'leftControl',
  // Common keys
  36: 'return',
  48: 'tab',
  49: 'space',
  51: 'delete',
  53: 'escape',
};

/** Keys that read the same in every language. */
const LITERAL_KEYS: Record<number, string> = {
  63: 'Fn',
  122: 'F1',
  120: 'F2',
  99: 'F3',
  118: 'F4',
  96: 'F5',
  97: 'F6',
  98: 'F7',
  100: 'F8',
  101: 'F9',
  109: 'F10',
  103: 'F11',
  111: 'F12',
  105: 'F13',
  107: 'F14',
  113: 'F15',
  // Letters (a-z)
  0: 'A', 11: 'B', 8: 'C', 2: 'D', 14: 'E', 3: 'F', 5: 'G', 4: 'H',
  34: 'I', 38: 'J', 40: 'K', 37: 'L', 46: 'M', 45: 'N', 31: 'O',
  35: 'P', 12: 'Q', 15: 'R', 1: 'S', 17: 'T', 32: 'U', 9: 'V',
  13: 'W', 7: 'X', 16: 'Y', 6: 'Z',
  // Numbers
  29: '0', 18: '1', 19: '2', 20: '3', 21: '4',
  23: '5', 22: '6', 26: '7', 28: '8', 25: '9',
};

function keyName(keyCode: number, names: Messages['keys']): string {
  if (isMouseHotkey(keyCode)) return mouseButtonName(keyCode, names);
  const named = NAMED_KEYS[keyCode];
  if (named) return names[named];
  return LITERAL_KEYS[keyCode] ?? names.other(keyCode);
}

export const MODIFIER_ONLY_KEYCODES = new Set([54, 55, 56, 58, 59, 60, 61, 62, 63]);

/** The key's name in a language. English is what settings.json stores. */
export function buildHotkeyLabel(keyCode: number, modifiers: number, names: Messages['keys'] = en.keys): string {
  const parts: string[] = [];

  if (!labelStyle.mac) {
    if (modifiers & MODIFIER_FLAGS.control) parts.push(names.ctrl);
    if (modifiers & MODIFIER_FLAGS.option) parts.push(names.alt);
    if (modifiers & MODIFIER_FLAGS.shift) parts.push(names.shift);
    if (modifiers & MODIFIER_FLAGS.command) parts.push(labelStyle.superKey);
    // Without symbols, a modifier key held with others still needs its own name: Strg+AltGr.
    parts.push(pcKeyName(keyCode, names));
    return parts.join('+');
  }

  if (modifiers & MODIFIER_FLAGS.control) parts.push(MODIFIER_LABELS.control);
  if (modifiers & MODIFIER_FLAGS.option) parts.push(MODIFIER_LABELS.option);
  if (modifiers & MODIFIER_FLAGS.shift) parts.push(MODIFIER_LABELS.shift);
  if (modifiers & MODIFIER_FLAGS.command) parts.push(MODIFIER_LABELS.command);

  if (!MODIFIER_ONLY_KEYCODES.has(keyCode) || parts.length === 0) {
    parts.push(keyName(keyCode, names));
  }

  return parts.join('');
}

/** The dictation key as the UI shows it, in the current language. */
export function hotkeyLabel(config: Pick<HotkeyConfig, 'keyCode' | 'modifiers'>, names: Messages['keys']): string {
  return buildHotkeyLabel(config.keyCode, config.modifiers, names);
}

export const FN_KEY_CODE = 63;
export const FN_KEY_FLAG = 0x800000;

export const FN_HOTKEY: HotkeyConfig = {
  keyCode: FN_KEY_CODE,
  modifiers: 0,
  label: 'Fn',
};

export const RIGHT_ALT_HOTKEY: HotkeyConfig = {
  keyCode: 61,
  modifiers: 0,
  label: 'Right Option (\u2325)',
};

export const DEFAULT_HOTKEY: HotkeyConfig = FN_HOTKEY;
export const DEFAULT_HOTKEY_WINDOWS: HotkeyConfig = RIGHT_ALT_HOTKEY;
