// @ts-check
/**
 * 설정 대화상자(Step 9·13): 기기 이름, 자동 저장 간격, 압축 저장, 데이터베이스 정리로 가는 버튼(D-17), 직전 저장본
 * 내보내기·모두 지우기, 복구를 기다리는 작업 사본의 열기·버리기·모두 버리기(D-18).
 * 값을 돌려주기만 하고 저장·적용은 호출자(main.js)가 한다. 직전 저장본 내보내기는 그 자리에서 스토어를 부른다
 * (저장 위치 선택기가 버튼 클릭의 활성화 안에서 열려야 한다).
 * 대화상자는 한 번에 하나만 열리므로(`dialog.js`) 모두 지우기·모두 버리기의 확인은 이 대화상자 안의 확인 줄로 받고,
 * 정리 버튼은 설정을 저장하는 것과 같이 닫은 뒤 호출자가 정리 대화상자를 열게 한다(`openCleanup`).
 * 사용자 데이터(파일 이름)는 textContent로만 넣는다(CLAUDE.md 5.5).
 */
import { DEVICE_NAME_MAX, normalizeDeviceName } from '../../app/settings.js';
import { t } from '../../i18n/index.js';
import { AUTOSAVE_INTERVALS_SECONDS } from '../../io/autosave.js';
import { formatBytes } from '../../util/bytes.js';
import { baseName } from '../../io/filesystem.js';
import { toAppError } from '../../util/errors.js';
import { openDialog } from './dialog.js';

/** @typedef {import('../../app/settings.js').Settings} Settings */
/** @typedef {import('../../app/store.js').Store} Store */
/** @typedef {import('../../i18n/index.js').MessageKey} MessageKey */
/** @typedef {import('../toast.js').Toasts} Toasts */

/**
 * @typedef {object} SettingsDialogDeps
 * @property {Store} store
 * @property {Toasts} toasts
 * @property {Settings} settings 지금 값
 * @property {boolean} gzipSupported 압축 저장 선택지를 보일지
 */

/**
 * 설정 대화상자의 결과. `openCleanup`이면 호출자가 설정을 적용한 뒤 정리 대화상자를 연다.
 * @typedef {object} SettingsDialogResult
 * @property {Settings} settings
 * @property {boolean} openCleanup
 */

/**
 * 이 사이트의 저장 공간 사용량(`navigator.storage.estimate`). 없거나 실패하면 null(표시하지 않는다, D-18).
 * @returns {Promise<{ usage: number, quota: number } | null>}
 */
async function storageEstimate() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate && typeof estimate.usage === 'number' && typeof estimate.quota === 'number') {
      return { usage: estimate.usage, quota: estimate.quota };
    }
  } catch {
    // 기능 감지 실패는 오류가 아니라 폴백이다(CLAUDE.md 5.6). 사용량 줄을 빼고 확인을 받는다.
  }
  return null;
}

/**
 * 설정 대화상자 안의 확인 줄: 문구, 취소, 확인(위험). 열면 취소 버튼에 포커스를 둔다(Enter 한 번에 지워지지 않게).
 * @param {{ role: string, okLabel: string, onConfirm: () => Promise<void> }} options
 * @returns {{ el: HTMLElement, show: (lines: string[]) => void, hide: () => void }}
 */
function confirmRow(options) {
  const el = document.createElement('div');
  el.className = 'jdr-settings__confirm';
  el.dataset.role = options.role;
  el.hidden = true;
  const text = document.createElement('div');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'jdr-dialog__button jdr-dialog__button--small';
  cancel.textContent = t('dialog.cancel');
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'jdr-dialog__button jdr-dialog__button--small jdr-dialog__button--danger';
  ok.dataset.action = `${options.role}-ok`;
  ok.dataset.hint = `hint.${options.role}-ok`;
  ok.textContent = options.okLabel;
  const hide = () => {
    el.hidden = true;
  };
  cancel.addEventListener('click', hide);
  ok.addEventListener('click', () => {
    ok.disabled = true;
    cancel.disabled = true;
    void options.onConfirm().finally(() => {
      ok.disabled = false;
      cancel.disabled = false;
      hide();
    });
  });
  el.append(text, cancel, ' ', ok);
  return {
    el,
    show(lines) {
      text.replaceChildren(
        ...lines.map((line) => {
          const p = document.createElement('p');
          p.textContent = line;
          return p;
        }),
      );
      el.hidden = false;
      cancel.focus();
    },
    hide,
  };
}

/**
 * 백업 시각 표시. 로케일 문구가 아니라 ISO 형식의 로컬 시각이다.
 * @param {number} at epoch ms
 * @returns {string}
 */
export function formatBackupTime(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 설정 대화상자를 연다. 저장(또는 정리 버튼)을 누르면 새 값, 취소하면 null.
 * @param {SettingsDialogDeps} deps
 * @returns {Promise<SettingsDialogResult | null>}
 */
export async function openSettingsDialog(deps) {
  const { store, toasts, settings } = deps;
  /** @type {HTMLInputElement | null} */
  let nameInput = null;
  /** @type {HTMLSelectElement | null} */
  let intervalSelect = null;
  /** @type {HTMLInputElement | null} */
  let gzipBox = null;
  let restoring = false;
  /** 정리 버튼으로 닫는다. 기기 이름 검사에 걸리면 다시 거짓이 되어, 이어서 누르는 저장이 정리를 열지 않는다. */
  let wantCleanup = false;
  const snapshotMode = store.capabilities().persistence === 'snapshot';

  const value = await openDialog({
    title: t('settings.title'),
    body: (body, actions) => {
      const nameLabel = document.createElement('label');
      nameLabel.className = 'jdr-dialog__label';
      const nameText = document.createElement('span');
      nameText.textContent = t('settings.deviceName');
      nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'jdr-dialog__input';
      nameInput.dataset.field = 'deviceName';
      nameInput.maxLength = DEVICE_NAME_MAX;
      nameInput.value = settings.deviceName;
      nameLabel.append(nameText, nameInput);

      const intervalLabel = document.createElement('label');
      intervalLabel.className = 'jdr-dialog__label';
      const intervalText = document.createElement('span');
      intervalText.textContent = t('settings.autosave');
      intervalSelect = document.createElement('select');
      intervalSelect.className = 'jdr-dialog__input';
      intervalSelect.dataset.field = 'autosave';
      for (const seconds of AUTOSAVE_INTERVALS_SECONDS) {
        const option = document.createElement('option');
        option.value = String(seconds);
        option.textContent = t(/** @type {MessageKey} */ (`settings.autosave.${seconds}`));
        option.selected = seconds === settings.autosaveSeconds;
        intervalSelect.append(option);
      }
      intervalLabel.append(intervalText, intervalSelect);
      const intervalHint = document.createElement('p');
      intervalHint.className = 'jdr-import__muted';
      intervalHint.textContent = t('settings.autosaveHint');

      const gzipLabel = document.createElement('label');
      gzipLabel.className = 'jdr-import__check';
      gzipBox = document.createElement('input');
      gzipBox.type = 'checkbox';
      gzipBox.dataset.field = 'saveGzip';
      gzipBox.checked = settings.saveGzip && deps.gzipSupported;
      gzipBox.disabled = !deps.gzipSupported;
      const gzipText = document.createElement('span');
      gzipText.textContent = deps.gzipSupported
        ? t('settings.saveGzip')
        : t('settings.saveGzipUnsupported');
      gzipLabel.append(gzipBox, gzipText);

      // 데이터베이스 정리(D-17). 계획이 비었고 저장이 빈 공간을 없애는 엔진이면 할 일이 없다. 읽기 전용이면 꺼진다.
      const databaseTitle = document.createElement('h3');
      databaseTitle.className = 'jdr-import__section';
      databaseTitle.textContent = t('settings.databaseTitle');
      const cleanupHint = document.createElement('p');
      cleanupHint.className = 'jdr-import__muted';
      cleanupHint.dataset.role = 'cleanup-hint';
      cleanupHint.textContent = t('settings.cleanupHint');
      const cleanupButton = document.createElement('button');
      cleanupButton.type = 'button';
      cleanupButton.className = 'jdr-dialog__button jdr-dialog__button--small';
      cleanupButton.dataset.action = 'cleanup-open';
      cleanupButton.dataset.hint = 'hint.cleanup-open';
      cleanupButton.textContent = t('settings.cleanup');
      cleanupButton.disabled = true;
      cleanupButton.addEventListener('click', () => {
        wantCleanup = true;
        actions.submit('ok');
      });
      void store.planCleanup().then((plan) => {
        if (!plan) return;
        // 정리할 수 없는 테이블(`blocked`)만 있으면 고를 열이 없다(Step 13 예외 처리).
        const purgeable = plan.tables.some((table) => !table.blocked);
        const nothing = !purgeable && plan.compactsOnSave;
        cleanupButton.disabled = nothing || store.getState().readOnly !== 'none';
        if (nothing) cleanupHint.textContent = t('settings.cleanupNothing');
      });

      const backupTitle = document.createElement('h3');
      backupTitle.className = 'jdr-import__section';
      backupTitle.textContent = t('settings.backupTitle');
      const backupInfo = document.createElement('p');
      backupInfo.className = 'jdr-import__muted';
      backupInfo.dataset.role = 'backup-info';
      backupInfo.textContent = t('settings.backupNone');
      const backupHint = document.createElement('p');
      backupHint.className = 'jdr-import__muted';
      backupHint.textContent = t('settings.backupHint');
      const restoreButton = document.createElement('button');
      restoreButton.type = 'button';
      restoreButton.className = 'jdr-dialog__button jdr-dialog__button--small';
      restoreButton.dataset.action = 'backup-restore';
      restoreButton.dataset.hint = 'hint.backup-restore';
      restoreButton.textContent = t('settings.backupRestore');
      restoreButton.disabled = true;
      restoreButton.addEventListener('click', () => {
        if (restoring) return;
        restoring = true;
        restoreButton.disabled = true;
        store
          .restoreBackup()
          .catch((/** @type {unknown} */ err) => toasts.error(toAppError(err)))
          .finally(() => {
            restoring = false;
            restoreButton.disabled = false;
          });
      });
      // 이 브라우저의 직전 저장본 모두 지우기(D-18). 브라우저 모드이고 IDB에 하나라도 있을 때만.
      const clearButton = document.createElement('button');
      clearButton.type = 'button';
      clearButton.className = 'jdr-dialog__button jdr-dialog__button--small';
      clearButton.dataset.action = 'backup-clear-all';
      clearButton.dataset.hint = 'hint.backup-clear-all';
      clearButton.textContent = t('settings.backupClearAll');
      clearButton.hidden = true;
      const clearConfirm = confirmRow({
        role: 'backup-clear',
        okLabel: t('settings.backupClearOk'),
        onConfirm: async () => {
          const cleared = await store.clearBackups();
          if (!cleared) return;
          backupInfo.textContent = t('settings.backupNone');
          restoreButton.disabled = true;
          clearButton.hidden = true;
          toasts.info('settings.backupCleared', { count: cleared.removed });
        },
      });
      clearButton.addEventListener('click', () => {
        void Promise.all([store.backupCount(), storageEstimate()]).then(([count, estimate]) => {
          if (count === null) return;
          const lines = [t('settings.backupClearConfirm', { count })];
          if (estimate) {
            lines.push(
              t('settings.storageUsage', {
                usage: formatBytes(estimate.usage),
                quota: formatBytes(estimate.quota),
              }),
            );
          }
          clearConfirm.show(lines);
        });
      });
      if (snapshotMode) {
        void store.backupCount().then((count) => {
          clearButton.hidden = !(count !== null && count > 0);
        });
      }
      void store.backupInfo().then((backup) => {
        if (!backup) return;
        backupInfo.textContent = t('settings.backupInfo', {
          name: backup.name,
          size: formatBytes(backup.bytes),
          at: formatBackupTime(backup.at),
        });
        restoreButton.disabled = false;
      });

      // 데스크톱 모드: 복구를 기다리는 작업 사본. 시작 복구는 저장한 적 없는 사본 하나만 제안하므로
      // 둘 이상 남으면 나머지는 여기서만 닿을 수 있다(그대로 두면 앱 데이터 폴더에 계속 쌓인다).
      const workcopyTitle = document.createElement('h3');
      workcopyTitle.className = 'jdr-import__section';
      workcopyTitle.textContent = t('settings.workcopyTitle');
      workcopyTitle.hidden = true;
      const workcopyList = document.createElement('div');
      workcopyList.dataset.role = 'workcopy-list';
      workcopyList.hidden = true;
      const discardAllButton = document.createElement('button');
      discardAllButton.type = 'button';
      discardAllButton.className = 'jdr-dialog__button jdr-dialog__button--small';
      discardAllButton.dataset.action = 'workcopy-discard-all';
      discardAllButton.dataset.hint = 'hint.workcopy-discard-all';
      discardAllButton.textContent = t('settings.workcopyDiscardAll');
      discardAllButton.hidden = true;
      /** @type {Map<string, HTMLElement>} */
      const rows = new Map();
      /** @param {HTMLElement} row */
      const removeRow = (row) => {
        row.remove();
        for (const [key, value] of rows) if (value === row) rows.delete(key);
        if (workcopyList.childElementCount > 0) return;
        workcopyTitle.hidden = true;
        workcopyList.hidden = true;
        discardAllButton.hidden = true;
      };
      const discardConfirm = confirmRow({
        role: 'workcopy-discard',
        okLabel: t('settings.workcopyDiscardAllOk'),
        onConfirm: async () => {
          const result = await store.discardAllWorkcopies();
          const failed = new Map(result.failed.map((f) => [f.entry.key, f.error]));
          for (const [key, row] of [...rows]) {
            const error = failed.get(key);
            if (!error) {
              removeRow(row);
              continue;
            }
            // 실패한 사본은 목록에 남기고 그 줄에 원인을 적는다. 원본 파일은 이 경로에서 건드리지 않는다.
            const note =
              row.querySelector('[data-role="workcopy-error"]') ?? document.createElement('span');
            if (note instanceof HTMLElement) {
              note.dataset.role = 'workcopy-error';
              note.className = 'jdr-dialog__error';
              note.textContent = t('settings.workcopyDiscardFailed', {
                message: error.message.slice(0, 200),
              });
              row.append(note);
            }
          }
          if (result.removed > 0)
            toasts.info('settings.workcopyDiscarded', { count: result.removed });
        },
      });
      discardAllButton.addEventListener('click', () => {
        discardConfirm.show([t('settings.workcopyDiscardAllConfirm', { count: rows.size })]);
      });
      void store.listWorkcopies().then((entries) => {
        if (entries.length === 0) return;
        workcopyTitle.hidden = false;
        workcopyList.hidden = false;
        discardAllButton.hidden = false;
        for (const entry of entries) {
          const row = document.createElement('p');
          row.className = 'jdr-import__muted';
          const label = document.createElement('span');
          // 원본 경로는 사용자 데이터다. textContent로만 넣는다(CLAUDE.md 5.5).
          const originalPath = entry.meta?.originalPath ?? null;
          label.textContent = t('settings.workcopyItem', {
            name: originalPath === null ? t('settings.workcopyNew') : baseName(originalPath),
            size: formatBytes(entry.size),
            at: formatBackupTime(entry.meta?.openedAt ?? 0),
          });
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'jdr-dialog__button jdr-dialog__button--small';
          open.dataset.action = 'workcopy-open';
          open.dataset.hint = 'hint.workcopy-open';
          open.textContent = t('settings.workcopyOpen');
          // 연 사본은 더 이상 복구를 기다리지 않는다. 행을 남겨 두면 대화상자가 열린 채로 그 사본의 "버리기"가
          // 눌릴 수 있다(스토어가 막지만 누를 수 있는 버튼을 두지 않는다).
          open.addEventListener('click', () => {
            open.disabled = true;
            void store.openWorkcopy(entry.key).then((ok) => {
              if (ok) removeRow(row);
              else open.disabled = false;
            });
          });
          const drop = document.createElement('button');
          drop.type = 'button';
          drop.className = 'jdr-dialog__button jdr-dialog__button--small';
          drop.dataset.action = 'workcopy-discard';
          drop.dataset.hint = 'hint.workcopy-discard';
          drop.textContent = t('settings.workcopyDiscard');
          drop.addEventListener('click', () => {
            drop.disabled = true;
            void store.discardWorkcopy(entry.key).then((ok) => {
              if (ok) removeRow(row);
              else drop.disabled = false;
            });
          });
          row.append(label, ' ', open, ' ', drop);
          rows.set(entry.key, row);
          workcopyList.append(row);
        }
      });

      body.append(
        nameLabel,
        intervalLabel,
        intervalHint,
        gzipLabel,
        databaseTitle,
        cleanupHint,
        cleanupButton,
        backupTitle,
        backupInfo,
        backupHint,
        restoreButton,
        clearButton,
        clearConfirm.el,
        workcopyTitle,
        workcopyList,
        discardAllButton,
        discardConfirm.el,
      );
    },
    buttons: [
      { label: t('dialog.cancel'), value: 'cancel' },
      { label: t('settings.save'), value: 'ok', primary: true },
    ],
    cancelValue: 'cancel',
    validate: () => {
      const problem =
        nameInput && normalizeDeviceName(nameInput.value) ? null : t('settings.deviceNameEmpty');
      if (problem) wantCleanup = false;
      return problem;
    },
  });
  // 클로저 안에서 채우므로 타입 좁히기가 지역 변수를 null로 고정한다. 다시 읽는다.
  const name = /** @type {HTMLInputElement | null} */ (nameInput);
  const interval = /** @type {HTMLSelectElement | null} */ (intervalSelect);
  const gz = /** @type {HTMLInputElement | null} */ (gzipBox);
  if (value !== 'ok' || !name || !interval || !gz) return null;
  return {
    settings: {
      deviceName: normalizeDeviceName(name.value) ?? settings.deviceName,
      autosaveSeconds: Number(interval.value),
      saveGzip: gz.checked,
    },
    openCleanup: wantCleanup,
  };
}
