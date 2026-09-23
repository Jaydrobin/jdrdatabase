// @ts-check
/**
 * 열 대화상자(Step 3): 열 추가(이름·타입·select 항목), 이름 바꾸기, 타입 변경(정책 선택), 소프트 삭제 확인.
 * 사용자 데이터는 textContent·value로만 넣는다.
 */
import { LOGICAL_TYPES } from '../../db/values.js';
import { t } from '../../i18n/index.js';
import { confirmDialog, openDialog, promptText } from './dialog.js';
import { nameValidator } from './table.js';

/** @typedef {import('../../db/values.js').LogicalType} LogicalType */
/** @typedef {import('../../db/values.js').ColumnOptions} ColumnOptions */
/** @typedef {import('../../db/values.js').CoercePolicy} CoercePolicy */
/** @typedef {import('../../i18n/index.js').MessageKey} MessageKey */

/**
 * @param {LogicalType} type
 * @returns {string}
 */
export function typeLabel(type) {
  return t(/** @type {MessageKey} */ (`type.${type}`));
}

/**
 * @param {LogicalType} selected
 * @returns {HTMLSelectElement}
 */
function makeTypeSelect(selected) {
  const select = document.createElement('select');
  select.className = 'jdr-dialog__input';
  for (const type of LOGICAL_TYPES) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = typeLabel(type);
    option.selected = type === selected;
    select.append(option);
  }
  return select;
}

/**
 * @param {string} labelText
 * @param {HTMLElement} control
 * @returns {HTMLLabelElement}
 */
function labeled(labelText, control) {
  const label = document.createElement('label');
  label.className = 'jdr-dialog__label';
  const span = document.createElement('span');
  span.textContent = labelText;
  label.append(span, control);
  return label;
}

/**
 * select 항목 입력(한 줄에 하나). 빈 줄·중복은 Worker가 정리한다.
 * @param {string[]} choices
 * @returns {{ el: HTMLLabelElement, read: () => string[] }}
 */
function choicesField(choices) {
  const textarea = document.createElement('textarea');
  textarea.className = 'jdr-dialog__input jdr-dialog__textarea';
  textarea.rows = 4;
  textarea.value = choices.join('\n');
  const el = labeled(t('column.choicesLabel'), textarea);
  return {
    el,
    read: () =>
      textarea.value
        .split('\n')
        .map((c) => c.trim())
        .filter((c) => c),
  };
}

/**
 * 열 추가 대화상자.
 * @param {{ taken: Iterable<string> }} options 살아 있는 열 이름
 * @returns {Promise<{ name: string, type: LogicalType, options: ColumnOptions | null } | null>}
 */
export async function promptNewColumn(options) {
  /** @type {HTMLInputElement | null} */
  let nameInput = null;
  /** @type {HTMLSelectElement | null} */
  let typeSelect = null;
  /** @type {ReturnType<typeof choicesField> | null} */
  let choices = null;
  const validateName = nameValidator(options.taken);
  const value = await openDialog({
    title: t('column.add.title'),
    body: (body) => {
      nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'jdr-dialog__input';
      body.append(labeled(t('column.nameLabel'), nameInput));
      typeSelect = makeTypeSelect('text');
      body.append(labeled(t('column.typeLabel'), typeSelect));
      choices = choicesField([]);
      choices.el.hidden = true;
      body.append(choices.el);
      const onTypeChange = () => {
        if (choices) choices.el.hidden = typeSelect?.value !== 'select';
      };
      typeSelect.addEventListener('change', onTypeChange);
    },
    buttons: [
      { label: t('dialog.cancel'), value: 'cancel' },
      { label: t('column.add.ok'), value: 'ok', primary: true },
    ],
    cancelValue: 'cancel',
    validate: () => {
      const problem = validateName(nameInput?.value ?? '');
      if (problem) return problem;
      if (typeSelect?.value === 'select' && (choices?.read().length ?? 0) === 0) {
        return t('validate.choicesEmpty');
      }
      return null;
    },
  });
  if (value !== 'ok' || !nameInput || !typeSelect) return null;
  const type = /** @type {LogicalType} */ (/** @type {HTMLSelectElement} */ (typeSelect).value);
  const list = choices ? /** @type {ReturnType<typeof choicesField>} */ (choices).read() : [];
  return {
    name: /** @type {HTMLInputElement} */ (nameInput).value.trim(),
    type,
    options: type === 'select' ? { choices: list } : null,
  };
}

/**
 * @param {{ value: string, taken: Iterable<string> }} options
 * @returns {Promise<string | null>}
 */
export async function promptColumnName(options) {
  const value = await promptText({
    title: t('column.rename.title'),
    label: t('column.nameLabel'),
    value: options.value,
    validate: nameValidator(options.taken),
  });
  return value === null ? null : value.trim();
}

/**
 * 타입 변경 대화상자: 새 타입, 변환 실패 정책(NULL 처리 / 중단), select 항목.
 * @param {{ name: string, current: LogicalType, choices?: string[] }} options
 * @returns {Promise<{ type: LogicalType, policy: CoercePolicy, options: ColumnOptions | null } | null>}
 */
export async function promptChangeType(options) {
  /** @type {HTMLSelectElement | null} */
  let typeSelect = null;
  /** @type {HTMLSelectElement | null} */
  let policySelect = null;
  /** @type {ReturnType<typeof choicesField> | null} */
  let choices = null;
  const value = await openDialog({
    title: t('column.changeType.title', { name: options.name }),
    message: t('column.changeType.message', { current: typeLabel(options.current) }),
    body: (body) => {
      typeSelect = makeTypeSelect(options.current);
      body.append(labeled(t('column.typeLabel'), typeSelect));
      policySelect = document.createElement('select');
      policySelect.className = 'jdr-dialog__input';
      for (const [policy, key] of /** @type {const} */ ([
        ['null', 'column.policy.null'],
        ['abort', 'column.policy.abort'],
      ])) {
        const option = document.createElement('option');
        option.value = policy;
        option.textContent = t(key);
        policySelect.append(option);
      }
      body.append(labeled(t('column.policyLabel'), policySelect));
      choices = choicesField(options.choices ?? []);
      choices.el.hidden = options.current !== 'select';
      body.append(choices.el);
      const onTypeChange = () => {
        if (choices) choices.el.hidden = typeSelect?.value !== 'select';
      };
      typeSelect.addEventListener('change', onTypeChange);
    },
    buttons: [
      { label: t('dialog.cancel'), value: 'cancel' },
      { label: t('column.changeType.ok'), value: 'ok', primary: true },
    ],
    cancelValue: 'cancel',
    validate: () => {
      if (typeSelect?.value === 'select' && (choices?.read().length ?? 0) === 0) {
        return t('validate.choicesEmpty');
      }
      return null;
    },
  });
  if (value !== 'ok' || !typeSelect || !policySelect) return null;
  const type = /** @type {LogicalType} */ (/** @type {HTMLSelectElement} */ (typeSelect).value);
  const policy = /** @type {CoercePolicy} */ (
    /** @type {HTMLSelectElement} */ (policySelect).value === 'abort' ? 'abort' : 'null'
  );
  const list = choices ? /** @type {ReturnType<typeof choicesField>} */ (choices).read() : [];
  return { type, policy, options: type === 'select' ? { choices: list } : null };
}

/**
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export function confirmDeleteColumn(name) {
  return confirmDialog({
    title: t('column.delete.title'),
    message: t('column.delete.message', { name }),
    okLabel: t('column.delete.ok'),
    danger: true,
  });
}
