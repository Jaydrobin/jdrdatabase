// @ts-check
/**
 * 가져오기 대화상자(Step 7·8). 한 창에서 파싱 옵션 → 미리보기·열 설정 → 대상 → 진행률·취소 → 보고서.
 *
 * - 옵션(인코딩·구분자·헤더 / 시트·헤더 행)을 바꾸면 `store.importPreview`를 다시 부른다.
 * - "가져오기"는 `openDialog`의 비동기 `validate`로 실행한다. 끝나면 닫히고, 실패하면 문구를 남기고 열어 둔다.
 *   실행 중의 취소(버튼·Esc)는 `beforeCancel`이 가로채 `AbortController`를 당긴다. 모달이라 그리드 편집이 막힌다.
 * - 사용자 데이터(파일 이름, 헤더, 셀 값, 테이블 이름)는 textContent·value로만 넣는다(CLAUDE.md 5.5).
 * - 상한 숫자는 두지 않는다. 메모리 경고는 `store.capabilities()`의 값으로 계산한다.
 * - 파이프라인·XLSX 모듈을 직접 가져오지 않는다(메인은 Worker RPC로만 가져오기에 닿는다). 필요한 값은 미리보기
 *   결과와 `import/csv.js`의 상수뿐이다.
 */
import { LOGICAL_TYPES } from '../../db/values.js';
import { hasMessage, t } from '../../i18n/index.js';
import { CSV_ENCODINGS, DELIMITER_CANDIDATES } from '../../import/csv.js';
import { formatBytes } from '../../util/bytes.js';
import { toAppError } from '../../util/errors.js';
import { formatInteger } from '../../util/format.js';
import { typeLabel } from './column.js';
import { openDialog } from './dialog.js';
import { nameValidator } from './table.js';

/** @typedef {import('../../app/store.js').Store} Store */
/** @typedef {import('../../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../../db/values.js').LogicalType} LogicalType */
/** @typedef {import('../../i18n/index.js').MessageKey} MessageKey */
/** @typedef {import('../../import/pipeline.js').ImportOptions} ImportOptions */
/** @typedef {import('../../import/pipeline.js').ImportPolicy} ImportPolicy */
/** @typedef {import('../../import/pipeline.js').ImportReport} ImportReport */
/** @typedef {import('../../import/pipeline.js').PreviewResult} PreviewResult */
/** @typedef {import('../../import/pipeline.js').MappingColumn} MappingColumn */
/** @typedef {import('../../import/pipeline.js').ImportFormat} ImportFormat */
/** @typedef {import('../toast.js').Toasts} Toasts */

/** 가져오기 버튼이 여는 숨은 파일 입력의 클래스. E2E가 파일 선택기 대신 이 요소에 파일을 넣는다. */
export const IMPORT_INPUT_CLASS = 'jdr-import-input';
/** 파일 입력의 accept. */
export const IMPORT_ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm';
/** 예상 결과 크기 = 파일 크기 × 이 값(Step 7 예외 처리의 메모리 경고). */
export const RESULT_SIZE_FACTOR = 1.2;
/** 미리보기 셀에 보여 주는 최대 글자 수. */
const CELL_PREVIEW_CHARS = 80;

/** 새 테이블에 고를 수 있는 타입. `select`는 항목을 미리 알 수 없어 뺀다(기존 select 열에는 자동 추가된다). */
const NEW_TABLE_TYPES = LOGICAL_TYPES.filter((type) => type !== 'select');

/** @type {ReadonlyArray<{ value: string, key: MessageKey }>} */
const DELIMITER_LABELS = [
  { value: ',', key: 'import.delimiter.comma' },
  { value: '\t', key: 'import.delimiter.tab' },
  { value: ';', key: 'import.delimiter.semicolon' },
  { value: '|', key: 'import.delimiter.pipe' },
];

/** @type {ReadonlyArray<{ value: ImportPolicy, key: MessageKey }>} */
const POLICY_LABELS = [
  { value: 'null', key: 'import.policy.null' },
  { value: 'text', key: 'import.policy.text' },
  { value: 'abort', key: 'import.policy.abort' },
];

/**
 * 파일 이름으로 형식을 고른다. 확장자가 없거나 모르면 CSV.
 * @param {string} name
 * @returns {ImportFormat}
 */
export function formatOf(name) {
  return /\.xls[xm]$/i.test(name) ? 'xlsx' : 'csv';
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
 * @param {ReadonlyArray<{ value: string, label: string }>} items
 * @param {string} selected
 * @returns {HTMLSelectElement}
 */
function makeSelect(items, selected) {
  const select = document.createElement('select');
  select.className = 'jdr-dialog__input';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    option.selected = item.value === selected;
    select.append(option);
  }
  return select;
}

/**
 * @param {string} text
 * @returns {HTMLTableCellElement}
 */
function th(text) {
  const cell = document.createElement('th');
  cell.textContent = text;
  return cell;
}

/**
 * @param {unknown} value
 * @returns {HTMLTableCellElement}
 */
function previewCell(value) {
  const cell = document.createElement('td');
  cell.className = 'jdr-import__cell';
  if (value === null || value === undefined || value === '') {
    cell.classList.add('jdr-import__cell--empty');
    cell.textContent = '';
    return cell;
  }
  const text = String(value);
  cell.textContent =
    text.length > CELL_PREVIEW_CHARS ? `${text.slice(0, CELL_PREVIEW_CHARS)}…` : text;
  cell.title = text.length > CELL_PREVIEW_CHARS ? `${text.slice(0, 500)}` : '';
  return cell;
}

/**
 * 열 하나의 설정(사용자가 고친 값).
 * @typedef {object} ColumnConfig
 * @property {number} source
 * @property {string} header 원본 열 이름(정리된 것)
 * @property {boolean} include
 * @property {string} name 새 테이블의 열 이름
 * @property {LogicalType} type 새 테이블의 열 타입
 * @property {string} columnId 기존 테이블의 대상 열. 비면 건너뜀
 * @property {ImportPolicy} policy
 */

/**
 * 오류를 대화상자 문구로 바꾼다. 데이터 유실 가능 경로이므로 "가져오기 전 상태 그대로"를 함께 알린다.
 * @param {import('../../util/errors.js').AppError} err
 * @returns {string}
 */
export function errorText(err) {
  const detail =
    typeof err.detail === 'object' && err.detail !== null
      ? /** @type {Record<string, unknown>} */ (err.detail)
      : {};
  if (err.code === 'E_IMPORT_CANCELLED') return t('import.cancelled');
  if (err.code === 'E_VALUE_INVALID' && detail.reason === 'too_many_choices') {
    return t('import.tooManyChoices', { max: formatInteger(Number(detail.max)) });
  }
  if (err.code === 'E_VALUE_INVALID' && typeof detail.rowIndex === 'number') {
    return t('import.invalidAt', {
      row: formatInteger(detail.rowIndex),
      column: String(detail.column ?? ''),
    });
  }
  if (err.code === 'E_FILE_TOO_LARGE' && detail.format === 'xlsx') {
    return t('import.xlsxTooLarge', { limit: formatBytes(Number(detail.limit)) });
  }
  const key = `error.${err.code}`;
  const message = hasMessage(key) ? t(key) : err.message;
  return t('import.failed', { message: `${message} (${err.code})` });
}

/**
 * 보고서 대화상자의 본문 줄들.
 * @param {ImportReport} report
 * @returns {string[]}
 */
export function reportLines(report) {
  const lines = [t('import.report.inserted', { count: formatInteger(report.inserted) })];
  if (report.skipped > 0) {
    lines.push(t('import.report.skipped', { count: formatInteger(report.skipped) }));
  }
  if (report.nulled > 0) {
    lines.push(t('import.report.nulled', { count: formatInteger(report.nulled) }));
  }
  if (report.demoted.length > 0) {
    lines.push(t('import.report.demoted', { names: report.demoted.join(', ') }));
  }
  if (report.errorCount > 0) {
    const shown = report.errors.slice(0, 5);
    lines.push(
      t('import.report.errors', {
        count: formatInteger(report.errorCount),
        shown: formatInteger(shown.length),
      }),
    );
    for (const error of shown) {
      const reason = t(/** @type {MessageKey} */ (`import.reason.${error.reason}`));
      lines.push(
        error.column
          ? t('import.report.errorLine', {
              row: formatInteger(error.rowIndex),
              column: error.column,
              reason,
            })
          : t('import.report.errorRowLine', { row: formatInteger(error.rowIndex), reason }),
      );
    }
  }
  lines.push(t('import.report.saveReminder'));
  return lines;
}

/**
 * @param {ImportReport} report
 * @returns {Promise<void>}
 */
export async function showReport(report) {
  await openDialog({
    title: t('import.report.title'),
    message: reportLines(report).join('\n'),
    buttons: [{ label: t('dialog.ok'), value: 'ok', primary: true }],
    cancelValue: 'ok',
  });
}

/**
 * @typedef {object} ImportDialogDeps
 * @property {Store} store
 * @property {Toasts} toasts
 * @property {File} file
 */

/**
 * 가져오기 대화상자를 연다. 성공하면 보고서를 돌려주고, 취소하면 null.
 * @param {ImportDialogDeps} deps
 * @returns {Promise<ImportReport | null>}
 */
export async function openImportDialog(deps) {
  const { store, toasts, file } = deps;
  const format = formatOf(file.name);
  /** @type {ImportOptions} */
  const options = { format };
  /** @type {PreviewResult | null} */
  let preview = null;
  /** @type {string | null} 미리보기 실패 문구 */
  let previewError = null;
  let previewSerial = 0;
  let previewing = false;
  /** @type {ColumnConfig[]} */
  let columns = [];
  /** @type {'new' | 'existing'} */
  let targetKind = 'new';
  let tableName = file.name.replace(/\.[^.]+$/, '') || t('file.untitled');
  /** @type {string} */
  let existingTableId = '';
  /** @type {AbortController | null} */
  let controller = null;
  /** 실행 결과. 클로저 안에서 채우므로 객체에 담는다(타입 좁히기가 지역 변수를 null로 고정하지 않게). */
  const outcome = { report: /** @type {ImportReport | null} */ (null) };

  const state = store.getState();
  /** 추가할 수 있는 테이블: STRICT이고 살아 있는 열이 있는 것. */
  const existingTables = state.tables.filter(
    (tb) => tb.strict && tb.columns.some((c) => c.deletedAt === null),
  );
  const takenTableNames = state.tables.map((tb) => tb.name);
  const validateTableName = nameValidator(takenTableNames);
  if (validateTableName(tableName)) tableName = '';
  existingTableId = existingTables[0]?.id ?? '';

  // ---- DOM ----
  const optionsBox = document.createElement('div');
  optionsBox.className = 'jdr-import__options';
  const warningsBox = document.createElement('div');
  const targetBox = document.createElement('div');
  targetBox.className = 'jdr-import__target';
  const columnsWrap = document.createElement('div');
  columnsWrap.className = 'jdr-import__table-wrap';
  const previewTitle = document.createElement('h3');
  previewTitle.className = 'jdr-import__section';
  const previewWrap = document.createElement('div');
  previewWrap.className = 'jdr-import__table-wrap';
  const progressBox = document.createElement('div');
  progressBox.className = 'jdr-import__progress';
  progressBox.hidden = true;
  const progressBar = document.createElement('progress');
  const progressText = document.createElement('span');
  progressText.setAttribute('role', 'status');
  progressBox.append(progressBar, progressText);

  /** @returns {TableInfo | null} */
  function existingTable() {
    return existingTables.find((tb) => tb.id === existingTableId) ?? null;
  }

  /**
   * 미리보기 결과로 열 설정을 다시 만든다. 이름·타입은 추론값, 기존 테이블 대상이면 같은 이름의 열에 잇는다.
   */
  function resetColumns() {
    if (!preview) {
      columns = [];
      return;
    }
    columns = preview.headers.map((header, i) => ({
      source: i,
      header,
      include: true,
      name: header,
      type:
        preview?.inferred[i]?.type === 'select' ? 'text' : (preview?.inferred[i]?.type ?? 'text'),
      columnId: '',
      policy: 'null',
    }));
    autoMatch();
  }

  /** 기존 테이블의 열에 헤더 이름으로 잇는다(같은 이름, 살아 있는 열, 한 번씩). */
  function autoMatch() {
    const table = existingTable();
    const used = new Set();
    for (const col of columns) {
      col.columnId = '';
      if (!table) continue;
      const match = table.columns.find(
        (c) => c.deletedAt === null && c.name === col.header && !used.has(c.id),
      );
      if (match) {
        col.columnId = match.id;
        used.add(match.id);
      }
    }
  }

  /**
   * 옵션 컨트롤은 한 번만 만들고, 미리보기가 올 때마다 값만 맞춘다. 요소를 갈아 끼우면 사용자가 입력 중인
   * 값과 포커스를 잃고, 자동화 도구가 잡은 요소가 떨어져 나간다.
   * @type {{ encoding: HTMLSelectElement | null, delimiter: HTMLSelectElement | null, hasHeader: HTMLInputElement | null, sheet: HTMLSelectElement | null, headerRow: HTMLInputElement | null }}
   */
  const controls = {
    encoding: null,
    delimiter: null,
    hasHeader: null,
    sheet: null,
    headerRow: null,
  };

  function buildOptions() {
    if (format === 'csv') {
      const encoding = makeSelect(
        CSV_ENCODINGS.map((e) => ({ value: e, label: e })),
        'utf-8',
      );
      encoding.dataset.field = 'encoding';
      encoding.addEventListener('change', onOptionChange);
      optionsBox.append(labeled(t('import.encodingLabel'), encoding));
      const delimiter = makeSelect(
        DELIMITER_LABELS.filter((d) => DELIMITER_CANDIDATES.includes(d.value)).map((d) => ({
          value: d.value,
          label: t(d.key),
        })),
        ',',
      );
      delimiter.dataset.field = 'delimiter';
      delimiter.addEventListener('change', onOptionChange);
      optionsBox.append(labeled(t('import.delimiterLabel'), delimiter));
      const check = document.createElement('label');
      check.className = 'jdr-import__check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.field = 'hasHeader';
      box.checked = true;
      box.addEventListener('change', onOptionChange);
      const text = document.createElement('span');
      text.textContent = t('import.hasHeader');
      check.append(box, text);
      optionsBox.append(check);
      controls.encoding = encoding;
      controls.delimiter = delimiter;
      controls.hasHeader = box;
      return;
    }
    const sheet = makeSelect([], '');
    sheet.dataset.field = 'sheet';
    sheet.disabled = true;
    sheet.addEventListener('change', onOptionChange);
    optionsBox.append(labeled(t('import.sheetLabel'), sheet));
    const headerRow = document.createElement('input');
    headerRow.type = 'number';
    headerRow.min = '0';
    headerRow.step = '1';
    headerRow.className = 'jdr-dialog__input';
    headerRow.dataset.field = 'headerRow';
    headerRow.value = '1';
    headerRow.addEventListener('change', onOptionChange);
    optionsBox.append(labeled(t('import.headerRowLabel'), headerRow));
    controls.sheet = sheet;
    controls.headerRow = headerRow;
  }

  /**
   * 미리보기(감지 결과)와 사용자가 고른 값으로 컨트롤의 값을 맞춘다. 사용자가 고른 값은 `options`에 있어
   * 그대로 다시 들어가므로 입력 중인 값이 덮이지 않는다.
   */
  function syncOptions() {
    if (controls.encoding) {
      controls.encoding.value = options.encoding ?? preview?.encoding ?? 'utf-8';
    }
    if (controls.delimiter) {
      controls.delimiter.value = options.delimiter ?? preview?.delimiter ?? ',';
    }
    if (controls.hasHeader) {
      controls.hasHeader.checked = options.hasHeader ?? preview?.hasHeader ?? true;
    }
    if (controls.sheet) {
      const sheets = preview?.sheets ?? [];
      const selected = options.sheet ?? preview?.sheet ?? sheets[0]?.name ?? '';
      const current = [...controls.sheet.options].map((o) => o.value);
      if (current.join('\u0000') !== sheets.map((s2) => s2.name).join('\u0000')) {
        controls.sheet.textContent = '';
        for (const s2 of sheets) {
          const option = document.createElement('option');
          option.value = s2.name;
          option.textContent = t('import.sheetOption', {
            name: s2.name,
            rows: formatInteger(s2.rows),
            cols: formatInteger(s2.cols),
          });
          controls.sheet.append(option);
        }
      }
      controls.sheet.disabled = sheets.length === 0;
      controls.sheet.value = selected;
    }
    if (controls.headerRow) {
      controls.headerRow.value = String(options.headerRow ?? preview?.headerRow ?? 1);
    }
  }

  /** @param {Event} ev */
  function onOptionChange(ev) {
    const el = /** @type {HTMLInputElement | HTMLSelectElement} */ (ev.currentTarget);
    switch (el.dataset.field) {
      case 'encoding':
        options.encoding = /** @type {import('../../import/csv.js').CsvEncoding} */ (el.value);
        break;
      case 'delimiter':
        options.delimiter = el.value;
        break;
      case 'hasHeader':
        options.hasHeader = /** @type {HTMLInputElement} */ (el).checked;
        break;
      case 'sheet':
        options.sheet = el.value;
        break;
      case 'headerRow': {
        const n = Number.parseInt(el.value, 10);
        options.headerRow = Number.isFinite(n) && n >= 0 ? n : 1;
        break;
      }
      default:
        return;
    }
    void loadPreview();
  }

  function renderWarnings() {
    warningsBox.textContent = '';
    /** @type {string[]} */
    const lines = [];
    if (previewError) lines.push(previewError);
    for (const w of preview?.warnings ?? []) {
      const params = {
        count: formatInteger(w.count ?? 0),
        ratio: `${((w.ratio ?? 0) * 100).toFixed(1)}%`,
      };
      lines.push(t(/** @type {MessageKey} */ (`import.warning.${w.kind}`), params));
    }
    const caps = store.capabilities();
    if (Number.isFinite(caps.warnFileBytes)) {
      const estimate = file.size * RESULT_SIZE_FACTOR;
      const remaining = Math.max(0, caps.warnFileBytes - store.getState().file.size);
      if (estimate > remaining) {
        lines.push(
          t('import.memoryWarning', {
            estimate: formatBytes(estimate),
            remaining: formatBytes(remaining),
          }),
        );
      }
    }
    for (const line of lines) {
      const p = document.createElement('p');
      p.className = 'jdr-import__warning';
      p.setAttribute('role', 'alert');
      p.textContent = line;
      warningsBox.append(p);
    }
  }

  function renderTarget() {
    targetBox.textContent = '';
    for (const [kind, key] of /** @type {const} */ ([
      ['new', 'import.target.new'],
      ['existing', 'import.target.existing'],
    ])) {
      const label = document.createElement('label');
      label.className = 'jdr-import__radio';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'jdr-import-target';
      radio.value = kind;
      radio.checked = targetKind === kind;
      radio.disabled = kind === 'existing' && existingTables.length === 0;
      radio.addEventListener('change', onTargetKindChange);
      const text = document.createElement('span');
      text.textContent = t(key);
      label.append(radio, text);
      targetBox.append(label);
    }
    if (targetKind === 'new') {
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'jdr-dialog__input';
      nameInput.dataset.field = 'tableName';
      nameInput.value = tableName;
      nameInput.addEventListener('input', () => {
        tableName = nameInput.value;
      });
      targetBox.append(labeled(t('import.tableNameLabel'), nameInput));
      return;
    }
    const select = makeSelect(
      existingTables.map((tb) => ({ value: tb.id, label: tb.name })),
      existingTableId,
    );
    select.dataset.field = 'existingTable';
    select.addEventListener('change', () => {
      existingTableId = select.value;
      autoMatch();
      renderColumns();
    });
    if (existingTables.length === 0) {
      const none = document.createElement('span');
      none.className = 'jdr-import__muted';
      none.textContent = t('import.noExistingTables');
      targetBox.append(none);
      return;
    }
    targetBox.append(labeled(t('import.existingLabel'), select));
  }

  /** @param {Event} ev */
  function onTargetKindChange(ev) {
    const radio = /** @type {HTMLInputElement} */ (ev.currentTarget);
    if (!radio.checked) return;
    targetKind = radio.value === 'existing' ? 'existing' : 'new';
    if (targetKind === 'existing') autoMatch();
    renderTarget();
    renderColumns();
  }

  function renderColumns() {
    columnsWrap.textContent = '';
    if (!preview) return;
    const table = document.createElement('table');
    table.className = 'jdr-import__table';
    table.dataset.role = 'columns';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.append(
      th(t('import.col.source')),
      th(targetKind === 'new' ? t('import.col.name') : t('import.col.target')),
      th(t('import.col.type')),
      th(t('import.col.policy')),
      th(t('import.col.examples')),
    );
    head.append(headRow);
    table.append(head);
    const body = document.createElement('tbody');
    const existing = targetKind === 'existing' ? existingTable() : null;
    for (const col of columns) {
      const tr = document.createElement('tr');
      tr.dataset.source = String(col.source);
      const sourceCell = document.createElement('td');
      const include = document.createElement('input');
      include.type = 'checkbox';
      include.checked = col.include;
      include.setAttribute('aria-label', col.header);
      include.addEventListener('change', () => {
        col.include = include.checked;
      });
      const sourceName = document.createElement('span');
      sourceName.textContent = ` ${col.header}`;
      sourceCell.append(include, sourceName);
      tr.append(sourceCell);

      const mapCell = document.createElement('td');
      const typeCell = document.createElement('td');
      if (targetKind === 'new') {
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'jdr-dialog__input';
        nameInput.dataset.field = 'name';
        nameInput.setAttribute('aria-label', `${col.header}: ${t('import.col.name')}`);
        nameInput.value = col.name;
        nameInput.addEventListener('input', () => {
          col.name = nameInput.value;
        });
        mapCell.append(nameInput);
        const typeSelect = makeSelect(
          NEW_TABLE_TYPES.map((type) => ({ value: type, label: typeLabel(type) })),
          col.type,
        );
        typeSelect.dataset.field = 'type';
        typeSelect.setAttribute('aria-label', `${col.header}: ${t('import.col.type')}`);
        typeSelect.addEventListener('change', () => {
          col.type = /** @type {LogicalType} */ (typeSelect.value);
        });
        typeCell.append(typeSelect);
      } else {
        const live = existing ? existing.columns.filter((c) => c.deletedAt === null) : [];
        const targetSelect = makeSelect(
          [
            { value: '', label: t('import.skip') },
            ...live.map((c) => ({ value: c.id, label: c.name })),
          ],
          col.columnId,
        );
        targetSelect.dataset.field = 'target';
        targetSelect.setAttribute('aria-label', `${col.header}: ${t('import.col.target')}`);
        targetSelect.addEventListener('change', () => {
          col.columnId = targetSelect.value;
          const chosen = live.find((c) => c.id === col.columnId);
          typeCell.textContent = chosen ? typeLabel(chosen.type) : '';
        });
        mapCell.append(targetSelect);
        const chosen = live.find((c) => c.id === col.columnId);
        typeCell.textContent = chosen ? typeLabel(chosen.type) : '';
      }
      tr.append(mapCell, typeCell);

      const policyCell = document.createElement('td');
      const policySelect = makeSelect(
        POLICY_LABELS.filter((p) => targetKind === 'new' || p.value !== 'text').map((p) => ({
          value: p.value,
          label: t(p.key),
        })),
        col.policy === 'text' && targetKind === 'existing' ? 'null' : col.policy,
      );
      policySelect.dataset.field = 'policy';
      policySelect.setAttribute('aria-label', `${col.header}: ${t('import.col.policy')}`);
      policySelect.addEventListener('change', () => {
        col.policy = /** @type {ImportPolicy} */ (policySelect.value);
      });
      policyCell.append(policySelect);
      tr.append(policyCell);

      const examples = document.createElement('td');
      examples.className = 'jdr-import__examples';
      examples.textContent = (preview.inferred[col.source]?.examples ?? []).join(' · ');
      tr.append(examples);
      body.append(tr);
    }
    table.append(body);
    columnsWrap.append(table);
  }

  function renderPreview() {
    previewWrap.textContent = '';
    if (previewing) {
      previewTitle.textContent = t('import.previewLoading');
      return;
    }
    if (!preview) {
      previewTitle.textContent = t('import.previewEmpty');
      return;
    }
    previewTitle.textContent = t('import.previewTitle', {
      count: formatInteger(preview.sampleRows),
      shown: formatInteger(preview.sample.length),
    });
    if (preview.sample.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'jdr-import__muted';
      empty.textContent = t('import.previewEmpty');
      previewWrap.append(empty);
      return;
    }
    const table = document.createElement('table');
    table.className = 'jdr-import__table';
    table.dataset.role = 'preview';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const header of preview.headers) headRow.append(th(header));
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const row of preview.sample) {
      const tr = document.createElement('tr');
      for (const value of row) tr.append(previewCell(value));
      body.append(tr);
    }
    table.append(head, body);
    previewWrap.append(table);
  }

  async function loadPreview() {
    previewSerial += 1;
    const serial = previewSerial;
    previewing = true;
    previewError = null;
    renderPreview();
    /** @type {PreviewResult | null} */
    let next = null;
    try {
      next = await store.importPreview(file, options);
    } catch (err) {
      if (serial !== previewSerial) return;
      previewError = errorText(toAppError(err));
    }
    if (serial !== previewSerial) return;
    previewing = false;
    preview = next;
    resetColumns();
    syncOptions();
    renderWarnings();
    renderColumns();
    renderPreview();
  }

  /**
   * 실행 전 검사. 문제가 있으면 문구.
   * @returns {string | null}
   */
  function validateForm() {
    if (previewing) return t('import.validate.previewPending');
    if (!preview) return previewError ?? t('import.previewEmpty');
    const included = columns.filter((c) => c.include);
    if (targetKind === 'new') {
      const problem = validateTableName(tableName);
      if (problem) return problem;
      const seen = new Set();
      for (const col of included) {
        const name = col.name.trim();
        if (!name) return t('validate.nameEmpty');
        if (seen.has(name)) return t('import.validate.duplicateName', { name });
        seen.add(name);
      }
      if (included.length === 0) return t('import.validate.noColumns');
      return null;
    }
    const table = existingTable();
    if (!table) return t('import.validate.noTarget');
    const mapped = included.filter((c) => c.columnId);
    if (mapped.length === 0) return t('import.validate.noColumns');
    const seen = new Set();
    for (const col of mapped) {
      if (seen.has(col.columnId)) {
        const name = table.columns.find((c) => c.id === col.columnId)?.name ?? col.columnId;
        return t('import.validate.duplicateTarget', { name });
      }
      seen.add(col.columnId);
    }
    return null;
  }

  /** @returns {MappingColumn[]} */
  function mappingColumns() {
    if (targetKind === 'new') {
      return columns
        .filter((c) => c.include)
        .map((c) => ({ source: c.source, name: c.name.trim(), type: c.type, policy: c.policy }));
    }
    return columns
      .filter((c) => c.include && c.columnId)
      .map((c) => ({
        source: c.source,
        columnId: c.columnId,
        policy: c.policy === 'text' ? 'null' : c.policy,
      }));
  }

  /**
   * @param {{ done: number, total: number }} p
   */
  function showProgress(p) {
    progressBox.hidden = false;
    if (p.total > 0) {
      progressBar.max = p.total;
      progressBar.value = Math.min(p.done, p.total);
      progressText.textContent = t('import.progressOf', {
        done: formatInteger(p.done),
        total: formatInteger(p.total),
      });
    } else {
      progressBar.removeAttribute('value');
      progressText.textContent = t('import.progress', { done: formatInteger(p.done) });
    }
  }

  /**
   * 실행. 성공하면 null(닫힘), 실패하면 문구(열어 둠).
   * @returns {Promise<string | null>}
   */
  async function runImport() {
    const problem = validateForm();
    if (problem) return problem;
    controller = new AbortController();
    showProgress({ done: 0, total: 0 });
    try {
      const report = await store.importRun(
        {
          file,
          options: {
            ...options,
            ...(preview
              ? {
                  encoding: preview.encoding,
                  delimiter: preview.delimiter,
                  hasHeader: preview.hasHeader,
                }
              : {}),
            ...pickXlsxOptions(),
          },
          mapping: { columns: mappingColumns() },
          target:
            targetKind === 'new'
              ? { kind: 'new', name: tableName.trim() }
              : { kind: 'existing', tableId: existingTableId },
          policy: 'null',
        },
        { signal: controller.signal, onProgress: showProgress },
      );
      if (!report) return t('file.readOnlyBlocked');
      outcome.report = report;
      return null;
    } catch (err) {
      return errorText(toAppError(err));
    } finally {
      controller = null;
      progressBox.hidden = true;
    }
  }

  /** XLSX 옵션은 미리보기가 감지한 시트·헤더 행을 그대로 넘긴다. */
  function pickXlsxOptions() {
    if (format !== 'xlsx' || !preview) return {};
    return {
      sheet: options.sheet ?? preview.sheet ?? undefined,
      headerRow: options.headerRow ?? preview.headerRow ?? 1,
    };
  }

  const value = await openDialog({
    title: t('import.title'),
    wide: true,
    body: (body) => {
      const fileLine = document.createElement('p');
      fileLine.className = 'jdr-import__file';
      fileLine.textContent = t('import.file', { name: file.name, size: formatBytes(file.size) });
      const targetTitle = document.createElement('h3');
      targetTitle.className = 'jdr-import__section';
      targetTitle.textContent = t('import.targetLabel');
      const columnsTitle = document.createElement('h3');
      columnsTitle.className = 'jdr-import__section';
      columnsTitle.textContent = t('import.columnsTitle');
      body.append(
        fileLine,
        optionsBox,
        warningsBox,
        targetTitle,
        targetBox,
        columnsTitle,
        columnsWrap,
        previewTitle,
        previewWrap,
        progressBox,
      );
      buildOptions();
      renderTarget();
      renderPreview();
      void loadPreview();
    },
    buttons: [
      { label: t('dialog.cancel'), value: 'cancel' },
      { label: t('import.run'), value: 'ok', primary: true },
    ],
    cancelValue: 'cancel',
    validate: () => runImport(),
    beforeCancel: () => {
      if (!controller) return true;
      // 실행 중: 취소 신호만 당긴다. Worker가 롤백을 마치면 runImport가 문구로 돌아와 열린 채로 남는다.
      controller.abort();
      progressText.textContent = t('import.cancelling');
      return false;
    },
  });
  // 미리보기가 아직 오는 중이면 그 응답은 버린다.
  previewSerial += 1;
  const report = outcome.report;
  if (value !== 'ok' || !report) return null;
  const table = store.getState().tables.find((tb) => tb.id === report.tableId);
  toasts.info('import.done', {
    count: formatInteger(report.inserted),
    table: table?.name ?? '',
  });
  await showReport(report);
  return report;
}
