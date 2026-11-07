import { useState } from 'react';

import { LOCALE_NAMES, LOCALES, type UiLanguage } from '../../shared/i18n';
import type { AppState, ThemePreference, UpdateSettingsInput } from '../../shared/types';
import { HotkeySettings } from '../components/HotkeyRecorder';
import { PermissionList } from '../components/PermissionList';
import { CopyLastShortcut } from '../components/ShortcutRecorder';
import { themeOptions } from '../components/ThemeToggle';
import { Button, Card, Notice, Segmented, ToggleRow } from '../components/ui';
import { rich, useT } from '../lib/i18n';
import { useAction } from '../lib/store';

export function SettingsPage({ state, onState }: { state: AppState; onState: (next: AppState) => void }) {
  const t = useT();
  const { settings } = state;
  const { busy, error, run } = useAction();
  const [confirmingSetup, setConfirmingSetup] = useState(false);
  const updater = state.updater;
  const canRestart = ['idle', 'done', 'error'].includes(state.status.phase);
  const updateText = updater.kind === 'downloading' ? t.updater.downloading(updater.version, updater.percent)
    : updater.kind === 'available' ? t.updater.available(updater.version)
    : updater.kind === 'downloaded' ? t.updater.downloaded(updater.version) : t.updater[updater.kind];
  const update = (patch: UpdateSettingsInput) => run('settings', async () => onState(await window.yap.updateSettings(patch)));

  return (
    <>
      <header className="page-header">
        <h1>{t.settings.title}</h1>
      </header>
      {error && <Notice tone="danger">{error}</Notice>}

      <Card title={t.settings.appearance}>
        <div className="row">
          <div className="row-text">
            <strong>{t.settings.theme}</strong>
            <span>{t.settings.themeHint}</span>
          </div>
          <Segmented<ThemePreference>
            label={t.settings.theme}
            value={settings.theme}
            options={themeOptions(t)}
            onChange={(theme) => void update({ theme })}
          />
        </div>
        <div className="row">
          <div className="row-text">
            <strong>{t.settings.language}</strong>
            <span>{t.settings.languageHint}</span>
          </div>
          <Segmented<UiLanguage>
            label={t.settings.language}
            value={settings.uiLanguage}
            options={[
              { value: 'system', label: t.settings.languageSystem },
              ...LOCALES.map((locale) => ({ value: locale, label: <span lang={locale}>{LOCALE_NAMES[locale]}</span> })),
            ]}
            onChange={(uiLanguage) => void update({ uiLanguage })}
          />
        </div>
      </Card>

      <Card title={t.settings.shortcut}>
        <HotkeySettings state={state} onSave={(hotkey) => void update({ hotkey })} />
        <CopyLastShortcut state={state} onSave={(copyLastShortcut) => void update({ copyLastShortcut })} />
      </Card>

      <Card title={t.settings.afterDictating}>
        <ToggleRow
          title={t.settings.autoPaste}
          description={t.settings.autoPasteHint}
          checked={settings.autoPaste}
          onChange={(autoPaste) => void update({ autoPaste })}
        />
        <ToggleRow
          title={t.settings.keepOnClipboard}
          description={
            settings.autoPaste
              ? settings.copyToClipboard
                ? t.settings.keepOnClipboardOn
                : t.settings.keepOnClipboardOff
              : t.settings.copyOnly
          }
          checked={settings.copyToClipboard}
          onChange={(copyToClipboard) => void update({ copyToClipboard })}
        />
        <ToggleRow
          title={t.settings.showPill}
          description={t.settings.showPillHint}
          checked={settings.showOverlay}
          onChange={(showOverlay) => void update({ showOverlay })}
        />
        <ToggleRow
          title={t.settings.openAtLogin}
          description={state.isPackaged || state.platform === 'linux' ? t.settings.openAtLoginHint : t.settings.installedOnly}
          checked={settings.launchAtLogin}
          // Linux writes an autostart entry, which works for a source checkout as well.
          disabled={!state.isPackaged && state.platform !== 'linux'}
          onChange={(launchAtLogin) => void update({ launchAtLogin })}
        />
      </Card>

      <Card
        title={t.settings.permissions}
        action={
          <Button size="sm" variant="ghost" icon="refresh" busy={busy === 'refresh'} onClick={() => void run('refresh', async () => onState(await window.yap.refreshPermissions()))}>
            {t.settings.checkAgain}
          </Button>
        }
      >
        <PermissionList state={state} onState={onState} />
      </Card>

      <Card
        title={t.settings.storage}
        description={t.settings.storageHint}
        action={
          <div className="button-row">
            <Button size="sm" variant="ghost" icon="folder" onClick={() => void window.yap.revealStorage()}>
              {t.common.open}
            </Button>
            <Button size="sm" variant="ghost" busy={busy === 'storage'} onClick={() => void run('storage', async () => onState(await window.yap.chooseStorage()))}>
              {t.common.change}
            </Button>
          </div>
        }
      >
        <code className="path">{settings.storageDirectory}</code>
      </Card>

      <Card title={t.settings.troubleshooting}>
        <div className="row">
          <div className="row-text">
            <strong>{t.settings.runSetupAgain}</strong>
            <span>{t.settings.runSetupHint}</span>
          </div>
          {confirmingSetup ? (
            <div className="confirm">
              <Button size="sm" variant="ghost" onClick={() => setConfirmingSetup(false)}>
                {t.common.cancel}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void update({ setupComplete: false, setupStep: 'welcome' })}>
                {t.settings.runSetup}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setConfirmingSetup(true)}>
              {t.settings.runSetupAgain}
            </Button>
          )}
        </div>
      </Card>

      <Card title={t.updater.title}>
        <p>{t.updater.hint}</p>
        <div className="row">
          <div className="row-text">
            <strong role="status">{updateText}</strong>
            {updater.kind === 'downloaded' && !canRestart && <span>{t.updater.finishDictation}</span>}
          </div>
          {updater.kind === 'downloaded' ? (
            <Button size="sm" variant="primary" disabled={!canRestart || !!busy}
              onClick={() => void run('updater', async () => { await window.yap.installUpdate(); })}>
              {t.updater.restart}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" disabled={!state.isPackaged || !!busy || ['checking', 'available', 'downloading'].includes(updater.kind)}
              onClick={() => void run('updater', async () => { await window.yap.checkForUpdates(); })}>
              {t.updater.check}
            </Button>
          )}
        </div>
      </Card>

      <Card title={t.settings.about}>
        <div className="about">
          <span>
            {rich(t.settings.aboutText(state.version), {
              author: (
                <button type="button" className="inline-link" onClick={() => void window.yap.openExternal('https://github.com/nicremo/yap/graphs/contributors')}>
                  Yap contributors
                </button>
              ),
            })}
          </span>
          <Button size="sm" variant="ghost" icon="external" onClick={() => void window.yap.openExternal('https://github.com/nicremo/yap')}>
            GitHub
          </Button>
        </div>
      </Card>
    </>
  );
}
