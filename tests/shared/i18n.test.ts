import { describe, expect, it } from 'vitest';

import { buildHotkeyLabel, hotkeyLabel, RIGHT_ALT_HOTKEY, setHotkeyLabelStyle } from '../../src/shared/hotkeys';
import { formatMegabytes, formatSeconds, MESSAGES, resolveLocale, type Locale } from '../../src/shared/i18n';
import { CLOUD_MODELS, LOCAL_MODELS, REWRITE_MODELS } from '../../src/shared/models';

/** Every text of a language, with functions called on sample values. */
function texts(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') {
    const sample = (value as (...args: unknown[]) => unknown)('X', 'Y', 'Z');
    const counted = (value as (...args: unknown[]) => unknown)(2, 3, 'Z');
    return [...texts(sample, `${path}()`), ...texts(counted, `${path}(2)`)];
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => texts(item, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => texts(item, path ? `${path}.${key}` : key));
  }
  return [];
}

/** The same keys at every level, so no German text is silently missing. */
function shape(value: unknown): unknown {
  if (typeof value === 'function') return 'function';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)]).sort());
  }
  return typeof value;
}

const placeholders = (text: string) => new Set(text.match(/\{\w+\}/g) ?? []);

describe('resolveLocale', () => {
  it('follows the first preferred system language Yap speaks', () => {
    expect(resolveLocale('system', ['de-DE', 'en-US'])).toBe('de');
    expect(resolveLocale('system', ['fr-FR', 'de-AT', 'en-US'])).toBe('de');
    expect(resolveLocale('system', ['en-GB', 'de-DE'])).toBe('en');
    expect(resolveLocale('system', ['de_CH'])).toBe('de');
  });

  it('falls back to English for languages Yap does not speak', () => {
    expect(resolveLocale('system', ['fr-FR', 'ja-JP'])).toBe('en');
    expect(resolveLocale('system', [])).toBe('en');
  });

  it('uses an explicit choice whatever the system says', () => {
    expect(resolveLocale('en', ['de-DE'])).toBe('en');
    expect(resolveLocale('de', ['en-US'])).toBe('de');
  });
});

describe('the dictionaries', () => {
  it('have the same texts in every language', () => {
    expect(shape(MESSAGES.de)).toEqual(shape(MESSAGES.en));
  });

  it.each(['en', 'de'] as Locale[])('%s uses no dashes as punctuation', (locale) => {
    const offenders = texts(MESSAGES[locale]).filter(([, text]) => /[\u2013\u2014]| - /.test(text));
    expect(offenders).toEqual([]);
  });

  it('keep the placeholders the UI fills in', () => {
    const en = new Map(texts(MESSAGES.en));
    for (const [path, german] of texts(MESSAGES.de)) {
      const english = en.get(path) ?? '';
      for (const name of placeholders(german)) {
        expect(placeholders(english), `${path} has ${name} only in German`).toContain(name);
      }
    }
    // These sentences carry an element the user needs to see.
    for (const [path, name] of [
      ['home.holdHint', '{key}'],
      ['tryIt.hint', '{key}'],
      ['setup.groqStepOpen', '{link}'],
      ['hotkey.fnNotice', '{fn}'],
      ['hotkey.fnNotice', '{action}'],
    ]) {
      expect(placeholders(new Map(texts(MESSAGES.de)).get(path) ?? ''), path).toContain(name);
    }
    expect(MESSAGES.de.settings.aboutText('1.0')).toContain('{author}');
  });

  it('describe every model Yap offers', () => {
    const ids = [...CLOUD_MODELS, ...LOCAL_MODELS, ...REWRITE_MODELS].map((model) => model.id);
    for (const locale of ['en', 'de'] as Locale[]) {
      for (const id of ids) {
        expect(MESSAGES[locale].modelNotes[id], `${locale} note for ${id}`).toBeTruthy();
      }
    }
  });
});

describe('formatting', () => {
  it('writes latencies the way each language writes decimals', () => {
    expect(formatSeconds(420, 'en')).toBe('0.42 s');
    expect(formatSeconds(420, 'de')).toBe('0,42 s');
    expect(formatSeconds(12_340, 'de')).toBe('12,3 s');
  });

  it('writes megabytes with a decimal only below ten', () => {
    expect(formatMegabytes(4_250_000, 'de')).toBe('4,3');
    expect(formatMegabytes(140_000_000, 'en')).toBe('140');
  });
});

describe('hotkey labels', () => {
  it('names keys in the language of the UI', () => {
    expect(hotkeyLabel(RIGHT_ALT_HOTKEY, MESSAGES.de.keys)).toBe('Rechte Wahltaste (⌥)');
    expect(hotkeyLabel(RIGHT_ALT_HOTKEY, MESSAGES.en.keys)).toBe('Right Option (⌥)');
    expect(buildHotkeyLabel(49, 0x100000, MESSAGES.de.keys)).toBe('⌘Leertaste');
  });

  it('stores English labels', () => {
    expect(buildHotkeyLabel(61, 0)).toBe('Right Option (⌥)');
    expect(buildHotkeyLabel(999, 0)).toBe('Key 999');
  });

  it('uses PC names and the active layout on Windows and Linux', () => {
    const qwertz: Record<number, string> = { 16: 'z', 6: 'y', 0: 'a' };
    setHotkeyLabelStyle({ mac: false, superKey: 'Super', printed: (code) => qwertz[code] });
    try {
      expect(hotkeyLabel(RIGHT_ALT_HOTKEY, MESSAGES.de.keys)).toBe('AltGr');
      expect(buildHotkeyLabel(62, 0, MESSAGES.de.keys)).toBe('Rechte Strg-Taste');
      expect(buildHotkeyLabel(55, 0, MESSAGES.de.keys)).toBe('Linke Super-Taste');
      // The US "Y" position is Z on a German keyboard.
      expect(buildHotkeyLabel(16, 0x40000 | 0x20000, MESSAGES.de.keys)).toBe('Strg+Umschalt+Z');
      expect(buildHotkeyLabel(49, 0x40000, MESSAGES.de.keys)).toBe('Strg+Leertaste');
      expect(buildHotkeyLabel(61, 0x40000, MESSAGES.de.keys)).toBe('Strg+AltGr');
      expect(buildHotkeyLabel(122, 0, MESSAGES.de.keys)).toBe('F1');
      expect(buildHotkeyLabel(62, 0)).toBe('Right Ctrl');
      expect(buildHotkeyLabel(1008, 0, MESSAGES.de.keys)).toBe('Maustaste Zurück');
      expect(buildHotkeyLabel(1002, 0x40000, MESSAGES.de.keys)).toBe('Strg+Mittlere Maustaste');
      expect(buildHotkeyLabel(1009, 0)).toBe('Mouse forward button');
    } finally {
      setHotkeyLabelStyle({ mac: true, superKey: 'Win', printed: undefined });
    }
  });
});
