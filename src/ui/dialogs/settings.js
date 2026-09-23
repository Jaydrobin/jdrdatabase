// @ts-check
/**
 * 설정 대화상자(Step 9): 기기 이름, 자동 저장 간격, 압축 저장, 직전 저장본 내보내기.
 * 값을 돌려주기만 하고 저장·적용은 호출자(main.js)가 한다. 직전 저장본 내보내기는 그 자리에서 스토어를 부른다
 * (저장 위치 선택기가 버튼 클릭의 활성화 안에서 열려야 한다).
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
 * 설정 대화상자를 연다. 저장을 누르면 새 값, 취소하면 null.
 * @param {SettingsDialogDeps} deps
 * @returns {Promise<Settings | null>}
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

  const value = await openDialog({
    title: t('settings.title'),
    body: (body) => {
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
      /** @param {HTMLElement} row */
      const removeRow = (row) => {
        row.remove();
        if (workcopyList.childElementCount > 0) return;
        workcopyTitle.hidden = true;
        workcopyList.hidden = true;
      };
      void store.listWorkcopies().then((entries) => {
        if (entries.length === 0) return;
        workcopyTitle.hidden = false;
        workcopyList.hidden = false;
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
          drop.textContent = t('settings.workcopyDiscard');
          drop.addEventListener('click', () => {
            drop.disabled = true;
            void store.discardWorkcopy(entry.key).then((ok) => {
              if (ok) removeRow(row);
              else drop.disabled = false;
            });
          });
          row.append(label, ' ', open, ' ', drop);
          workcopyList.append(row);
        }
      });

      body.append(
        nameLabel,
        intervalLabel,
        intervalHint,
        gzipLabel,
        backupTitle,
        backupInfo,
        backupHint,
        restoreButton,
        workcopyTitle,
        workcopyList,
      );
    },
    buttons: [
      { label: t('dialog.cancel'), value: 'cancel' },
      { label: t('settings.save'), value: 'ok', primary: true },
    ],
    cancelValue: 'cancel',
    validate: () =>
      nameInput && normalizeDeviceName(nameInput.value) ? null : t('settings.deviceNameEmpty'),
  });
  // 클로저 안에서 채우므로 타입 좁히기가 지역 변수를 null로 고정한다. 다시 읽는다.
  const name = /** @type {HTMLInputElement | null} */ (nameInput);
  const interval = /** @type {HTMLSelectElement | null} */ (intervalSelect);
  const gz = /** @type {HTMLInputElement | null} */ (gzipBox);
  if (value !== 'ok' || !name || !interval || !gz) return null;
  return {
    deviceName: normalizeDeviceName(name.value) ?? settings.deviceName,
    autosaveSeconds: Number(interval.value),
    saveGzip: gz.checked,
  };
}
