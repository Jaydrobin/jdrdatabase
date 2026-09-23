// @ts-check
/**
 * 내보내기 대화상자(Step 9). 형식(CSV/XLSX), CSV 옵션(인코딩·구분자·수식 주입 방지), 현재 뷰 적용, 행 수와
 * XLSX 경고, 진행률·취소.
 *
 * - "내보내기"는 `openDialog`의 비동기 `validate`로 실행한다. 저장 위치 선택기는 사용자 동작의 활성화가 살아 있는
 *   동안 불러야 하므로 `store.exportTable`이 다른 await 없이 먼저 연다.
 * - 실행 중의 취소(버튼·Esc)는 `beforeCancel`이 가로채 `AbortController`를 당긴다. 싱크는 스토어가 버린다.
 * - 사용자 데이터(테이블 이름)는 textContent로만 넣는다(CLAUDE.md 5.5). 상한 숫자는 `export/xlsx.js`의 상수를 쓴다.
 */
import { CSV_EXPORT_ENCODINGS } from '../../export/csv.js';
import { XLSX_MAX_ROWS, XLSX_WARN_ROWS } from '../../export/xlsx.js';
import { hasMessage, t } from '../../i18n/index.js';
import { DELIMITER_CANDIDATES } from '../../import/csv.js';
import { toAppError } from '../../util/errors.js';
import { formatInteger } from '../../util/format.js';
import { openDialog } from './dialog.js';

/** @typedef {import('../../app/store.js').Store} Store */
/** @typedef {import('../../app/store.js').ExportOutcome} ExportOutcome */
/** @typedef {import('../../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../../db/query.js').NormalizedViewSpec} NormalizedViewSpec */
/** @typedef {import('../../export/csv.js').CsvExportEncoding} CsvExportEncoding */
/** @typedef {import('../../i18n/index.js').MessageKey} MessageKey */
/** @typedef {import('../toast.js').Toasts} Toasts */

/** @type {ReadonlyArray<{ value: string, key: MessageKey }>} */
const DELIMITER_LABELS = [
  { value: ',', key: 'import.delimiter.comma' },
  { value: '\t', key: 'import.delimiter.tab' },
  { value: ';', key: 'import.delimiter.semicolon' },
  { value: '|', key: 'import.delimiter.pipe' },
];

/**
 * 파일 이름에 쓸 수 없는 문자를 뺀 제안 이름.
 * @param {string} tableName
 * @param {'csv' | 'xlsx'} format
 * @returns {string}
 */
export function suggestedFileName(tableName, format) {
  // 경로 구분자·와일드카드·따옴표와 제어 문자(코드 포인트 32 미만)를 뺀다.
  const base =
    [...tableName]
      .map((ch) => ((ch.codePointAt(0) ?? 0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
      .join('')
      .trim() || 'export';
  return `${base}.${format}`;
}

/**
 * 오류를 대화상자 문구로 바꾼다. 파일이 만들어지지 않았음을 함께 알린다.
 * @param {import('../../util/errors.js').AppError} err
 * @returns {string}
 */
export function errorText(err) {
  const detail =
    typeof err.detail === 'object' && err.detail !== null
      ? /** @type {Record<string, unknown>} */ (err.detail)
      : {};
  if (err.code === 'E_IMPORT_CANCELLED') return t('export.cancelled');
  if (err.code === 'E_FILE_TOO_LARGE' && detail.format === 'xlsx') {
    return t('export.xlsxTooManyRows', { limit: formatInteger(Number(detail.limit)) });
  }
  const key = `error.${err.code}`;
  const message = hasMessage(key) ? t(key) : err.message;
  return t('export.failed', { message: `${message} (${err.code})` });
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
 * @param {string} field
 * @returns {HTMLSelectElement}
 */
function makeSelect(items, selected, field) {
  const select = document.createElement('select');
  select.className = 'jdr-dialog__input';
  select.dataset.field = field;
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
 * @param {string} field
 * @param {boolean} checked
 * @returns {{ label: HTMLLabelElement, box: HTMLInputElement }}
 */
function makeCheck(text, field, checked) {
  const label = document.createElement('label');
  label.className = 'jdr-import__check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.dataset.field = field;
  box.checked = checked;
  const span = document.createElement('span');
  span.textContent = text;
  label.append(box, span);
  return { label, box };
}

/**
 * @typedef {object} ExportDialogDeps
 * @property {Store} store
 * @property {Toasts} toasts
 * @property {TableInfo} table
 */

/**
 * 내보내기 대화상자를 연다. 성공하면 결과를 돌려주고, 취소하면 null.
 * @param {ExportDialogDeps} deps
 * @returns {Promise<ExportOutcome | null>}
 */
export async function openExportDialog(deps) {
  const { store, toasts, table } = deps;
  /** @type {'csv' | 'xlsx'} */
  let format = 'csv';
  /** @type {CsvExportEncoding} */
  let encoding = 'utf-8-bom';
  let delimiter = ',';
  let formulaGuard = true;
  let applyView = true;
  /** @type {number | null} 뷰 조건을 포함한 행 수. 아직 모르면 null */
  let count = null;
  let countSerial = 0;
  /** @type {AbortController | null} */
  let controller = null;
  const outcome = { result: /** @type {ExportOutcome | null} */ (null) };

  const fullView = store.viewSpecOf(table.id);
  /** @returns {NormalizedViewSpec} */
  const viewSpec = () =>
    applyView ? fullView : { hidden: [], sort: [], filter: null, search: '' };
  const columnCount = () =>
    table.columns.filter((c) => c.deletedAt === null && !new Set(viewSpec().hidden).has(c.id))
      .length;

  // ---- DOM ----
  const csvBox = document.createElement('div');
  csvBox.className = 'jdr-import__options';
  const info = document.createElement('p');
  info.className = 'jdr-import__muted';
  info.setAttribute('role', 'status');
  info.dataset.role = 'export-count';
  const warning = document.createElement('p');
  warning.className = 'jdr-import__warning';
  warning.hidden = true;
  const progressBox = document.createElement('div');
  progressBox.className = 'jdr-import__progress';
  progressBox.hidden = true;
  const progressBar = document.createElement('progress');
  const progressText = document.createElement('span');
  progressText.setAttribute('role', 'status');
  progressBox.append(progressBar, progressText);

  function renderInfo() {
    if (count === null) {
      info.textContent = t('export.counting');
    } else {
      info.textContent = t('export.rowCount', {
        count: formatInteger(count),
        cols: formatInteger(columnCount()),
      });
    }
    const rows = count ?? 0;
    if (format === 'xlsx' && rows > XLSX_MAX_ROWS) {
      warning.textContent = t('export.xlsxTooManyRows', { limit: formatInteger(XLSX_MAX_ROWS) });
      warning.hidden = false;
    } else if (format === 'xlsx' && rows > XLSX_WARN_ROWS) {
      warning.textContent = t('export.xlsxWarn', {
        count: formatInteger(rows),
        warn: formatInteger(XLSX_WARN_ROWS),
      });
      warning.hidden = false;
    } else if (columnCount() === 0) {
      warning.textContent = t('export.noColumns');
      warning.hidden = false;
    } else {
      warning.hidden = true;
    }
    csvBox.hidden = format !== 'csv';
  }

  async function loadCount() {
    countSerial += 1;
    const serial = countSerial;
    count = null;
    renderInfo();
    const n = await store.countRows(table.id, viewSpec());
    if (serial !== countSerial) return;
    count = n;
    renderInfo();
  }

  /**
   * @param {{ done: number, total: number }} p
   */
  function showProgress(p) {
    progressBox.hidden = false;
    if (p.total > 0) {
      progressBar.max = p.total;
      progressBar.value = Math.min(p.done, p.total);
    } else {
      progressBar.removeAttribute('value');
    }
    progressText.textContent = t('export.progress', {
      done: formatInteger(p.done),
      total: formatInteger(Math.max(p.total, p.done)),
    });
  }

  /**
   * 실행. 성공하면 null(닫힘), 실패하면 문구(열어 둠).
   * @returns {Promise<string | null>}
   */
  async function runExport() {
    if (columnCount() === 0) return t('export.noColumns');
    if (format === 'xlsx' && (count ?? 0) > XLSX_MAX_ROWS) {
      return t('export.xlsxTooManyRows', { limit: formatInteger(XLSX_MAX_ROWS) });
    }
    controller = new AbortController();
    try {
      // 저장 위치 선택기가 먼저 열린다(사용자 동작의 활성화 안). 그 뒤 조각이 흐른다.
      const result = await store.exportTable(
        {
          tableId: table.id,
          viewSpec: viewSpec(),
          format,
          ...(format === 'csv' ? { options: { encoding, delimiter, formulaGuard } } : {}),
          suggestedName: suggestedFileName(table.name, format),
        },
        {
          signal: controller.signal,
          onProgress: (p) => {
            if (p.phase === 'export') showProgress(p);
          },
        },
      );
      if (!result) return t('export.cancelled');
      outcome.result = result;
      return null;
    } catch (err) {
      return errorText(toAppError(err));
    } finally {
      controller = null;
      progressBox.hidden = true;
    }
  }

  const value = await openDialog({
    title: t('export.title', { table: table.name }),
    body: (body) => {
      const formatSelect = makeSelect(
        [
          { value: 'csv', label: t('export.format.csv') },
          { value: 'xlsx', label: t('export.format.xlsx') },
        ],
        format,
        'format',
      );
      formatSelect.addEventListener('change', () => {
        format = formatSelect.value === 'xlsx' ? 'xlsx' : 'csv';
        renderInfo();
      });
      const encodingSelect = makeSelect(
        CSV_EXPORT_ENCODINGS.map((e) => ({
          value: e,
          label: t(/** @type {MessageKey} */ (`export.encoding.${e}`)),
        })),
        encoding,
        'encoding',
      );
      encodingSelect.addEventListener('change', () => {
        encoding = encodingSelect.value === 'utf-8' ? 'utf-8' : 'utf-8-bom';
      });
      const delimiterSelect = makeSelect(
        DELIMITER_LABELS.filter((d) => DELIMITER_CANDIDATES.includes(d.value)).map((d) => ({
          value: d.value,
          label: t(d.key),
        })),
        delimiter,
        'delimiter',
      );
      delimiterSelect.addEventListener('change', () => {
        delimiter = delimiterSelect.value;
      });
      const guard = makeCheck(t('export.formulaGuard'), 'formulaGuard', formulaGuard);
      guard.box.addEventListener('change', () => {
        formulaGuard = guard.box.checked;
      });
      csvBox.append(
        labeled(t('export.encodingLabel'), encodingSelect),
        labeled(t('export.delimiterLabel'), delimiterSelect),
        guard.label,
      );
      const view = makeCheck(t('export.applyView'), 'applyView', applyView);
      view.box.addEventListener('change', () => {
        applyView = view.box.checked;
        void loadCount();
      });
      body.append(
        labeled(t('export.formatLabel'), formatSelect),
        csvBox,
        view.label,
        info,
        warning,
        progressBox,
      );
      renderInfo();
      void loadCount();
    },
    buttons: [
      { label: t('dialog.cancel'), value: 'cancel' },
      { label: t('export.run'), value: 'ok', primary: true },
    ],
    cancelValue: 'cancel',
    validate: () => runExport(),
    beforeCancel: () => {
      if (!controller) return true;
      // 실행 중: 취소 신호만 당긴다. 스토어가 싱크를 버리면 runExport가 문구로 돌아와 열린 채로 남는다.
      controller.abort();
      progressText.textContent = t('export.cancelling');
      return false;
    },
  });
  countSerial += 1;
  const result = outcome.result;
  if (value !== 'ok' || !result) return null;
  toasts.info('export.done', { rows: formatInteger(result.rows), name: result.name });
  if (result.blobCells > 0) {
    toasts.info('export.blobCells', { count: formatInteger(result.blobCells) });
  }
  return result;
}
