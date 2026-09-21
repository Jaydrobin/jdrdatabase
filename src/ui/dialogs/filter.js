// @ts-check
/**
 * 정렬·필터 대화상자(Step 6)와 뷰 이름 입력. 머리글 클릭이 못 하는 것(키보드로 다중 정렬 편집, 조건 편집)을
 * 여기서 한다. 필터 값은 열 타입으로 검증해 맞지 않으면 닫지 않고 사유를 보인다(Step 6 예외 처리).
 * 사용자 데이터(열 이름·값)는 textContent·value로만 넣는다.
 */
import { FILTER_OPS, isUnaryOp } from '../../db/query.js';
import { validate } from '../../db/values.js';
import { t } from '../../i18n/index.js';
import { confirmDialog, openDialog, promptText } from './dialog.js';
import { nameValidator } from './table.js';

/** @typedef {import('../../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../../db/query.js').SortSpec} SortSpec */
/** @typedef {import('../../db/query.js').FilterSpec} FilterSpec */
/** @typedef {import('../../db/query.js').FilterCondition} FilterCondition */
/** @typedef {import('../../db/query.js').FilterOp} FilterOp */
/** @typedef {import('../../i18n/index.js').MessageKey} MessageKey */

/**
 * @param {FilterOp} op
 * @returns {string}
 */
export function opLabel(op) {
  return t(/** @type {MessageKey} */ (`filter.op.${op}`));
}

/**
 * @param {ColumnInfo[]} columns
 * @param {string} selected
 * @returns {HTMLSelectElement}
 */
function columnSelect(columns, selected) {
  const select = document.createElement('select');
  select.className = 'jdr-dialog__input jdr-dialog__input--inline';
  select.setAttribute('aria-label', t('filter.columnLabel'));
  for (const column of columns) {
    const option = document.createElement('option');
    option.value = column.id;
    option.textContent = column.name;
    option.selected = column.id === selected;
    select.append(option);
  }
  return select;
}

/**
 * @param {string} label
 * @param {string} action
 * @returns {HTMLButtonElement}
 */
function button(label, action) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'jdr-dialog__button jdr-dialog__button--small';
  el.dataset.action = action;
  el.textContent = label;
  return el;
}

/**
 * 정렬 대화상자. 취소하면 null, 아니면 정렬 목록(빈 목록이면 정렬 없음).
 * @param {{ columns: ColumnInfo[], sort: SortSpec[] }} options 살아 있는 열과 지금 정렬
 * @returns {Promise<SortSpec[] | null>}
 */
export async function promptSort(options) {
  const { columns } = options;
  /** @type {HTMLElement | null} */
  let list = null;

  /** @param {SortSpec} entry */
  function addRow(entry) {
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'jdr-dialog__row';
    const column = columnSelect(columns, entry.colId);
    const dir = document.createElement('select');
    dir.className = 'jdr-dialog__input jdr-dialog__input--inline';
    dir.setAttribute('aria-label', t('sort.dirLabel'));
    for (const [value, key] of /** @type {const} */ ([
      ['asc', 'sort.asc'],
      ['desc', 'sort.desc'],
    ])) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = t(key);
      option.selected = value === entry.dir;
      dir.append(option);
    }
    row.append(column, dir, button(t('sort.remove'), 'remove'));
    list.append(row);
  }

  /** @param {Event} ev */
  const onListClick = (ev) => {
    const target = /** @type {HTMLElement | null} */ (ev.target);
    const el = target?.closest('button[data-action="remove"]');
    if (el instanceof HTMLElement) el.parentElement?.remove();
  };

  const value = await openDialog({
    title: t('sort.title'),
    body: (body) => {
      list = document.createElement('div');
      list.className = 'jdr-dialog__rows';
      list.addEventListener('click', onListClick);
      for (const entry of options.sort) {
        if (columns.some((c) => c.id === entry.colId)) addRow(entry);
      }
      const add = button(t('sort.add'), 'add');
      add.addEventListener('click', () => {
        const first = columns[0];
        if (first) addRow({ colId: first.id, dir: 'asc' });
      });
      body.append(list, add);
    },
    buttons: [
      { label: t('dialog.cancel'), value: 'cancel' },
      { label: t('filter.apply'), value: 'ok', primary: true },
    ],
    cancelValue: 'cancel',
  });
  if (value !== 'ok' || !list) return null;
  /** @type {SortSpec[]} */
  const out = [];
  for (const row of /** @type {HTMLElement} */ (list).querySelectorAll('.jdr-dialog__row')) {
    const selects = row.querySelectorAll('select');
    const colId = /** @type {HTMLSelectElement | undefined} */ (selects[0])?.value ?? '';
    const dir =
      /** @type {HTMLSelectElement | undefined} */ (selects[1])?.value === 'desc' ? 'desc' : 'asc';
    if (colId && !out.some((s) => s.colId === colId)) out.push({ colId, dir });
  }
  return out;
}

/**
 * 조건 행의 값 입력 요소. 타입에 맞는 컨트롤(참/거짓·선택 항목은 select, 나머지는 텍스트)을 만든다.
 * `in`은 쉼표로 구분한 목록을 텍스트로 받는다.
 * @param {ColumnInfo} column
 * @param {FilterOp} op
 * @param {string} current
 * @returns {HTMLInputElement | HTMLSelectElement}
 */
function valueControl(column, op, current) {
  if (op !== 'in' && (column.type === 'boolean' || column.type === 'select')) {
    const select = document.createElement('select');
    select.className = 'jdr-dialog__input jdr-dialog__input--inline';
    select.setAttribute('aria-label', t('filter.valueLabel'));
    const choices =
      column.type === 'boolean'
        ? [
            ['true', t('cell.true')],
            ['false', t('cell.false')],
          ]
        : (column.options?.choices ?? []).map((c) => [c, c]);
    for (const [value, label] of choices) {
      const option = document.createElement('option');
      option.value = value ?? '';
      option.textContent = label ?? '';
      option.selected = value === current;
      select.append(option);
    }
    return select;
  }
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'jdr-dialog__input jdr-dialog__input--inline';
  input.setAttribute('aria-label', t('filter.valueLabel'));
  input.placeholder = op === 'in' ? t('filter.valuesHint') : '';
  input.value = current;
  return input;
}

/**
 * 필터 대화상자. 취소하면 null, 적용이면 필터(조건이 없으면 `null`이 아니라 빈 조건 목록으로, 호출자가
 * "필터 없음"으로 바꾼다).
 * @param {{ columns: ColumnInfo[], filter: FilterSpec | null }} options 살아 있는 열과 지금 필터
 * @returns {Promise<FilterSpec | null>}
 */
export async function promptFilter(options) {
  const { columns } = options;
  /** @type {HTMLElement | null} */
  let list = null;
  /** @type {HTMLSelectElement | null} */
  let logic = null;

  /**
   * @param {HTMLElement} row
   * @returns {{ column: ColumnInfo, op: FilterOp, raw: string } | null}
   */
  function readRow(row) {
    const column = columns.find((c) => c.id === row.dataset.colId);
    const op = /** @type {FilterOp} */ (row.dataset.op ?? '=');
    const control = row.querySelector('[data-role="value"]');
    const raw =
      control instanceof HTMLInputElement || control instanceof HTMLSelectElement
        ? control.value
        : '';
    return column ? { column, op, raw } : null;
  }

  /**
   * 조건 행을 (다시) 그린다. 열이나 연산자가 바뀌면 값 컨트롤을 타입에 맞게 바꿔 끼운다.
   * @param {HTMLElement} row
   * @param {FilterCondition} cond
   */
  function fillRow(row, cond) {
    row.textContent = '';
    row.dataset.colId = cond.colId;
    row.dataset.op = cond.op;
    const column = columns.find((c) => c.id === cond.colId) ?? columns[0];
    if (!column) return;
    const colSelect = columnSelect(columns, column.id);
    const opSelect = document.createElement('select');
    opSelect.className = 'jdr-dialog__input jdr-dialog__input--inline';
    opSelect.setAttribute('aria-label', t('filter.opLabel'));
    for (const op of FILTER_OPS) {
      const option = document.createElement('option');
      option.value = op;
      option.textContent = opLabel(op);
      option.selected = op === cond.op;
      opSelect.append(option);
    }
    const current = cond.op === 'in' ? (cond.values ?? []).join(', ') : (cond.value ?? '');
    const control = valueControl(column, cond.op, current);
    control.dataset.role = 'value';
    control.hidden = isUnaryOp(cond.op);
    const onChange = () => {
      const read = readRow(row);
      const nextOp = /** @type {FilterOp} */ (opSelect.value);
      fillRow(row, {
        colId: colSelect.value,
        op: nextOp,
        ...(nextOp === 'in'
          ? { values: (read?.raw ?? '').split(',').map((v) => v.trim()) }
          : { value: read?.raw ?? '' }),
      });
    };
    colSelect.addEventListener('change', onChange);
    opSelect.addEventListener('change', onChange);
    row.append(colSelect, opSelect, control, button(t('filter.remove'), 'remove'));
  }

  /** @param {FilterCondition} cond */
  function addRow(cond) {
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'jdr-dialog__row';
    fillRow(row, cond);
    list.append(row);
  }

  /** @param {Event} ev */
  const onListClick = (ev) => {
    const target = /** @type {HTMLElement | null} */ (ev.target);
    const el = target?.closest('button[data-action="remove"]');
    if (el instanceof HTMLElement) el.parentElement?.remove();
  };

  /** @returns {FilterCondition[]} */
  function readAll() {
    /** @type {FilterCondition[]} */
    const out = [];
    for (const row of /** @type {HTMLElement} */ (list).querySelectorAll('.jdr-dialog__row')) {
      const read = readRow(/** @type {HTMLElement} */ (row));
      if (!read) continue;
      if (read.op === 'in') {
        out.push({
          colId: read.column.id,
          op: 'in',
          values: read.raw
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v !== ''),
        });
      } else if (isUnaryOp(read.op)) {
        out.push({ colId: read.column.id, op: read.op });
      } else {
        out.push({ colId: read.column.id, op: read.op, value: read.raw });
      }
    }
    return out;
  }

  const value = await openDialog({
    title: t('filter.title'),
    body: (body) => {
      const logicLabel = document.createElement('label');
      logicLabel.className = 'jdr-dialog__label';
      const span = document.createElement('span');
      span.textContent = t('filter.logicLabel');
      logic = document.createElement('select');
      logic.className = 'jdr-dialog__input';
      for (const [v, key] of /** @type {const} */ ([
        ['and', 'filter.logic.and'],
        ['or', 'filter.logic.or'],
      ])) {
        const option = document.createElement('option');
        option.value = v;
        option.textContent = t(key);
        option.selected = (options.filter?.logic ?? 'and') === v;
        logic.append(option);
      }
      logicLabel.append(span, logic);
      list = document.createElement('div');
      list.className = 'jdr-dialog__rows';
      list.addEventListener('click', onListClick);
      for (const cond of options.filter?.conditions ?? []) {
        if (columns.some((c) => c.id === cond.colId)) addRow(cond);
      }
      const add = button(t('filter.add'), 'add');
      add.addEventListener('click', () => {
        const first = columns[0];
        if (first) addRow({ colId: first.id, op: '=', value: '' });
      });
      body.append(logicLabel, list, add);
    },
    buttons: [
      { label: t('dialog.cancel'), value: 'cancel' },
      { label: t('filter.clear'), value: 'clear' },
      { label: t('filter.apply'), value: 'ok', primary: true },
    ],
    cancelValue: 'cancel',
    validate: () => {
      // 값이 열 타입에 맞지 않으면 닫지 않는다(Step 6 예외 처리). Worker의 빌더와 같은 검증이다.
      for (const cond of readAll()) {
        const column = columns.find((c) => c.id === cond.colId);
        if (!column || isUnaryOp(cond.op)) continue;
        if (cond.op === 'contains' || cond.op === 'starts') continue;
        const raws = cond.op === 'in' ? (cond.values ?? []) : [cond.value ?? ''];
        if (cond.op === 'in' && raws.length === 0) {
          return t('filter.invalidValue', {
            column: column.name,
            reason: t('validate.empty_list'),
          });
        }
        for (const raw of raws) {
          const result = validate(column.type, raw, column.options ?? undefined);
          if (!result.ok) {
            return t('filter.invalidValue', {
              column: column.name,
              reason: t(/** @type {MessageKey} */ (`validate.${result.reason}`)),
            });
          }
        }
      }
      return null;
    },
  });
  if (value === 'clear') return { logic: 'and', conditions: [] };
  if (value !== 'ok' || !list || !logic) return null;
  return {
    logic: /** @type {HTMLSelectElement} */ (logic).value === 'or' ? 'or' : 'and',
    conditions: readAll(),
  };
}

/**
 * 뷰 이름 입력. 같은 이름의 뷰가 있으면 덮어쓰기이므로 중복을 막지 않는다. 취소하면 null.
 * @param {{ value?: string }} options
 * @returns {Promise<string | null>}
 */
export async function promptViewName(options) {
  const value = await promptText({
    title: t('view.save.title'),
    label: t('view.nameLabel'),
    value: options.value ?? '',
    okLabel: t('view.save.ok'),
    validate: nameValidator([]),
  });
  return value === null ? null : value.trim();
}

/**
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export function confirmDeleteView(name) {
  return confirmDialog({
    title: t('view.delete.title'),
    message: t('view.delete.message', { name }),
    okLabel: t('view.delete.ok'),
    danger: true,
  });
}
