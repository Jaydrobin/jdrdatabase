// @ts-check
/**
 * 테이블 대화상자(Step 3): 이름 입력(만들기·이름 바꾸기), 삭제 확인(되돌리기 불가).
 */
import { MAX_NAME_LENGTH } from '../../db/tables.js';
import { t } from '../../i18n/index.js';
import { confirmDialog, promptText } from './dialog.js';

/**
 * 표시 이름의 UI 측 사전 검사. 최종 판정은 Worker(`E_NAME_INVALID`)가 한다.
 * @param {Iterable<string>} taken
 * @returns {(value: string) => string | null}
 */
export function nameValidator(taken) {
  const names = new Set(taken);
  return (value) => {
    const name = value.trim();
    if (!name) return t('validate.nameEmpty');
    if (name.length > MAX_NAME_LENGTH) return t('validate.nameTooLong', { limit: MAX_NAME_LENGTH });
    if (names.has(name)) return t('validate.nameDuplicate');
    return null;
  };
}

/**
 * @param {{ mode: 'create' | 'rename', value?: string, taken: Iterable<string> }} options
 * @returns {Promise<string | null>} 정리된 이름. 취소하면 null
 */
export async function promptTableName(options) {
  const value = await promptText({
    title: t(options.mode === 'create' ? 'table.create.title' : 'table.rename.title'),
    label: t('table.nameLabel'),
    value: options.value ?? '',
    okLabel: t(options.mode === 'create' ? 'table.create.ok' : 'dialog.ok'),
    validate: nameValidator(options.taken),
  });
  return value === null ? null : value.trim();
}

/**
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export function confirmDropTable(name) {
  return confirmDialog({
    title: t('table.drop.title'),
    message: t('table.drop.message', { name }),
    okLabel: t('table.drop.ok'),
    danger: true,
  });
}
