// @ts-check
/**
 * 가져오기 파이프라인(Step 7·8, D-09): 파서 → 추론 → 매핑 → 삽입. Worker에서 실행된다.
 *
 * - `openSource(file, options)`가 CSV·XLSX의 차이를 흡수해 `{ header, rows, total }`을 준다.
 * - `preview()`는 앞 1,000행 표본으로 열 이름·타입을 추론하고 미리보기 20행과 경고를 돌려준다.
 * - `run()`은 트랜잭션 하나 안에서 (새 테이블이면 만들고) 1,000행 또는 32 MB마다 `runBatch`로 넣는다.
 *   취소·오류·`abort` 정책은 롤백이라 DB는 시작 전과 같다. 가져오기는 커맨드가 아니다(D-08 예외, Step 7).
 * - 이 모듈은 `Engine` 인터페이스만 호출하고, 식별자는 `quoteIdent()`, 값은 파라미터 바인딩으로만 넣는다.
 */
import { yieldToEventLoop } from '../db/command.js';
import { nowIso, quoteIdent } from '../db/schema.js';
import { addColumn, create, requireStrict, requireTable } from '../db/tables.js';
import { isEmpty, isLogicalType, validate } from '../db/values.js';
import { estimateCloneBytes, MB } from '../util/bytes.js';
import { AppError } from '../util/errors.js';
import {
  decodeHead,
  detectDelimiter,
  detectEncoding,
  DETECT_HEAD_BYTES,
  isCsvEncoding,
  parse as parseCsv,
  replacementRatio,
  REPLACEMENT_WARN_RATIO,
} from './csv.js';
import { column as inferColumn, columnName, sample, SAMPLE_ROWS } from './infer.js';
import { openXlsx } from './xlsx.js';

/** @typedef {import('../db/engine.js').Engine} Engine */
/** @typedef {import('../db/engine.js').SqlValue} SqlValue */
/** @typedef {import('../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../db/values.js').LogicalType} LogicalType */
/** @typedef {import('../db/values.js').ColumnOptions} ColumnOptions */
/** @typedef {import('./csv.js').CsvEncoding} CsvEncoding */
/** @typedef {import('./infer.js').SourceValue} SourceValue */
/** @typedef {import('./infer.js').Row} Row */
/** @typedef {import('./infer.js').Inferred} Inferred */

/** @typedef {'csv' | 'xlsx'} ImportFormat */
/** @typedef {'null' | 'text' | 'abort'} ImportPolicy 변환 실패 값 정책(열 단위) */

/**
 * 파싱 옵션. 빠진 값은 Worker가 감지한다(`resolved`로 돌려준다).
 * @typedef {object} ImportOptions
 * @property {ImportFormat} format
 * @property {CsvEncoding} [encoding] CSV
 * @property {string} [delimiter] CSV. 한 글자
 * @property {boolean} [hasHeader] CSV. 기본 true
 * @property {string} [sheet] XLSX. 기본 첫 시트
 * @property {number} [headerRow] XLSX. 1부터. 기본 1. 0이면 헤더 없음
 */

/**
 * 감지·기본값이 채워진 옵션.
 * @typedef {object} ResolvedOptions
 * @property {ImportFormat} format
 * @property {CsvEncoding} encoding
 * @property {string} delimiter
 * @property {boolean} hasHeader
 * @property {string | null} sheet
 * @property {number} headerRow
 */

/** @typedef {'encoding' | 'ragged' | 'unterminated_quote' | 'merged' | 'error_cells' | 'empty_headers'} WarningKind */
/** @typedef {{ kind: WarningKind, count?: number, ratio?: number }} ImportWarning */

/** @typedef {{ name: string, rows: number, cols: number }} SheetInfo */

/**
 * `openSource`의 결과.
 * @typedef {object} Source
 * @property {(SourceValue | undefined)[] | null} header 헤더 행의 원본 값. 없으면 null
 * @property {AsyncIterable<Row>} rows 데이터 행
 * @property {number | null} total 데이터 행 수를 미리 알 때만
 * @property {ResolvedOptions} resolved
 * @property {ImportWarning[]} warnings 열기 시점까지 모인 경고. 파서가 끝나면 더 늘 수 있다
 * @property {SheetInfo[]} [sheets] XLSX
 */

/**
 * `import.preview`의 결과.
 * @typedef {object} PreviewResult
 * @property {ImportFormat} format
 * @property {CsvEncoding} encoding
 * @property {string} delimiter
 * @property {boolean} hasHeader
 * @property {SheetInfo[]} [sheets]
 * @property {string | null} [sheet]
 * @property {number} [headerRow]
 * @property {string[]} headers 정리된 열 이름(비어 있으면 자동, 겹치면 접미사)
 * @property {SourceValue[][]} sample 앞 `PREVIEW_ROWS`행(열 수에 맞춰 잘리거나 null로 채움)
 * @property {number} sampleRows 추론에 쓴 표본 행 수
 * @property {boolean} exhausted 표본이 파일 전체인가
 * @property {Inferred[]} inferred
 * @property {ImportWarning[]} warnings
 */

/**
 * 원본 열 하나의 매핑. 새 테이블이면 `name`·`type`, 기존 테이블이면 `columnId`.
 * @typedef {object} MappingColumn
 * @property {number} source 원본 열 순번(0부터)
 * @property {string} [name]
 * @property {LogicalType} [type]
 * @property {string} [columnId]
 * @property {ImportPolicy} [policy] 없으면 op의 기본 정책
 */
/** @typedef {{ columns: MappingColumn[] }} ImportMapping */
/** @typedef {{ kind: 'new', name: string } | { kind: 'existing', tableId: string }} ImportTarget */

/** @typedef {'invalid' | 'too_long' | 'extra_fields' | 'error_cell'} ReportReason */
/**
 * @typedef {object} ReportError
 * @property {number} rowIndex 파일 안의 레코드 순번(헤더 포함)
 * @property {string} [column] 열 이름
 * @property {ReportReason} reason
 */

/**
 * @typedef {object} ImportReport
 * @property {string} tableId
 * @property {number} inserted
 * @property {number} skipped 모든 값이 빈 행(넣지 않음)
 * @property {number} nulled 변환할 수 없어 NULL로 넣은 값의 수
 * @property {ReportError[]} errors 앞 `MAX_REPORT_ERRORS`건
 * @property {number} errorCount 기록하지 않은 것까지 센 문제 수
 * @property {string[]} demoted `text` 정책으로 강등한 열 이름
 */

/**
 * @typedef {object} RunArgs
 * @property {Engine} engine
 * @property {Blob} file
 * @property {ImportOptions} options
 * @property {ImportMapping} mapping
 * @property {ImportTarget} target
 * @property {ImportPolicy} [policy] 열에 정책이 없을 때의 기본. 기본 `null`
 * @property {AbortSignal} [signal]
 * @property {(progress: { phase: string, done: number, total: number }) => void} [progress]
 */

/** 미리보기로 보여 주는 행 수. */
export const PREVIEW_ROWS = 20;
/** `runBatch` 한 번에 넣는 행 수. */
export const BATCH_ROWS = 1000;
/** 배치 하나의 직렬화 예산. `runBatch` 상한(64 MB)의 절반에서 잘라 추정 오차를 흡수한다. */
export const BATCH_BYTES = 32 * MB;
/** 셀 값 크기 상한(Step 7 예외 처리). 넘으면 NULL로 넣고 보고서에 남긴다. */
export const MAX_CELL_BYTES = 10 * MB;
/** 보고서에 남기는 문제 수 상한. 그 뒤는 세기만 한다. */
export const MAX_REPORT_ERRORS = 100;
/** 표본에서 헤더보다 필드가 많은 행이 이 비율을 넘으면 구분자 재감지를 제안한다. */
export const RAGGED_WARN_RATIO = 0.1;

/**
 * @param {unknown} value
 * @returns {value is ImportPolicy}
 */
export function isImportPolicy(value) {
  return value === 'null' || value === 'text' || value === 'abort';
}

/**
 * Worker 경계를 넘어온 옵션의 형태를 정리한다.
 * @param {unknown} raw
 * @returns {ImportOptions}
 */
export function normalizeOptions(raw) {
  const o =
    typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
  if (o.format !== 'csv' && o.format !== 'xlsx') {
    throw new AppError('E_DB_QUERY', 'import options need format csv or xlsx', {
      detail: { format: String(o.format).slice(0, 20) },
    });
  }
  /** @type {ImportOptions} */
  const out = { format: o.format };
  if (isCsvEncoding(o.encoding)) out.encoding = o.encoding;
  if (typeof o.delimiter === 'string' && o.delimiter.length === 1) out.delimiter = o.delimiter;
  if (typeof o.hasHeader === 'boolean') out.hasHeader = o.hasHeader;
  if (typeof o.sheet === 'string') out.sheet = o.sheet;
  if (typeof o.headerRow === 'number' && Number.isInteger(o.headerRow) && o.headerRow >= 0) {
    out.headerRow = o.headerRow;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {value is Blob}
 */
function isBlob(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (/** @type {Blob} */ (value).stream) === 'function' &&
    typeof (/** @type {Blob} */ (value).arrayBuffer) === 'function' &&
    typeof (/** @type {Blob} */ (value).size) === 'number'
  );
}

/**
 * @param {unknown} file
 * @returns {Blob}
 */
export function requireBlob(file) {
  if (!isBlob(file)) {
    throw new AppError('E_DB_QUERY', 'import file must be a Blob', {
      detail: { type: typeof file },
    });
  }
  return file;
}

/**
 * CSV를 연다. 인코딩·구분자를 감지하고, 헤더가 있으면 첫 레코드를 먼저 읽는다.
 * @param {Blob} file
 * @param {ImportOptions} options
 * @returns {Promise<Source>}
 */
async function openCsv(file, options) {
  const head = new Uint8Array(await file.slice(0, DETECT_HEAD_BYTES).arrayBuffer());
  const encoding = options.encoding ?? detectEncoding(head);
  const headText = decodeHead(head, encoding);
  const delimiter = options.delimiter ?? detectDelimiter(headText);
  const hasHeader = options.hasHeader ?? true;
  /** @type {ImportWarning[]} */
  const warnings = [];
  const ratio = replacementRatio(headText);
  if (ratio > REPLACEMENT_WARN_RATIO) warnings.push({ kind: 'encoding', ratio });
  const records = parseCsv(file, {
    encoding,
    delimiter,
    onEnd: ({ unterminatedQuote }) => {
      if (unterminatedQuote) warnings.push({ kind: 'unterminated_quote' });
    },
  });
  /** @type {(SourceValue | undefined)[] | null} */
  let header = null;
  if (hasHeader) {
    const first = await records.next();
    header = first.done ? [] : first.value.cells;
  }
  return {
    header,
    rows: records,
    total: null,
    resolved: { format: 'csv', encoding, delimiter, hasHeader, sheet: null, headerRow: 0 },
    warnings,
  };
}

/**
 * 형식에 맞는 파서를 골라 원본을 연다(D-09: 두 형식이 같은 행 이터레이터를 준다).
 * @param {Blob} file
 * @param {ImportOptions} options
 * @returns {Promise<Source>}
 */
export async function openSource(file, options) {
  if (options.format === 'xlsx') return openXlsx(file, options);
  return openCsv(file, options);
}

/**
 * 헤더 값에서 열 이름 목록을 만든다. 비어 있거나 겹치는 것의 수를 함께 돌려준다.
 * @param {(SourceValue | undefined)[]} header
 * @returns {{ names: string[], fixed: number }}
 */
export function headerNames(header) {
  const taken = new Set();
  let fixed = 0;
  const names = header.map((raw, index) => {
    const name = columnName(raw, index, taken);
    const original = raw === null || raw === undefined ? '' : String(raw).trim();
    if (name !== original) fixed += 1;
    return name;
  });
  return { names, fixed };
}

/**
 * 미리보기·추론(`import.preview`).
 * @param {Blob} file
 * @param {ImportOptions} options
 * @param {{ signal?: AbortSignal }} [ctx]
 * @returns {Promise<PreviewResult>}
 */
export async function preview(file, options, ctx = {}) {
  const source = await openSource(file, options);
  const sampled = await sample(source.rows, SAMPLE_ROWS);
  if (ctx.signal?.aborted) {
    throw new AppError('E_IMPORT_CANCELLED', 'preview cancelled');
  }
  const rows = sampled.rows;
  let width = source.header ? source.header.length : 0;
  if (!source.header) for (const row of rows) width = Math.max(width, row.cells.length);
  const header = source.header ?? new Array(width).fill(null);
  const { names, fixed } = headerNames(header);
  const warnings = [...source.warnings];
  if (fixed > 0) warnings.push({ kind: 'empty_headers', count: fixed });
  let ragged = 0;
  for (const row of rows) if (row.cells.length > width) ragged += 1;
  if (rows.length > 0 && ragged / rows.length > RAGGED_WARN_RATIO) {
    warnings.push({ kind: 'ragged', count: ragged });
  }
  /** @type {Inferred[]} */
  const inferred = [];
  for (let i = 0; i < width; i += 1) {
    inferred.push(inferColumn(rows.map((row) => row.cells[i] ?? null)));
  }
  const previewRows = rows.slice(0, PREVIEW_ROWS).map((row) => {
    /** @type {SourceValue[]} */
    const cells = [];
    for (let i = 0; i < width; i += 1) cells.push(row.cells[i] ?? null);
    return cells;
  });
  /** @type {PreviewResult} */
  const out = {
    format: source.resolved.format,
    encoding: source.resolved.encoding,
    delimiter: source.resolved.delimiter,
    hasHeader: source.resolved.hasHeader,
    headers: names,
    sample: previewRows,
    sampleRows: rows.length,
    exhausted: sampled.exhausted,
    inferred,
    warnings,
  };
  if (source.sheets) {
    out.sheets = source.sheets;
    out.sheet = source.resolved.sheet;
    out.headerRow = source.resolved.headerRow;
  }
  return out;
}

/**
 * 한 번의 시도에 쓰는 열 계획. `text` 정책으로 강등하면 타입만 바뀐 계획으로 다시 시도한다.
 * @typedef {object} PlannedColumn
 * @property {number} source
 * @property {string} name 표시 이름(보고서용)
 * @property {LogicalType} type
 * @property {ColumnOptions | null} options
 * @property {ImportPolicy} policy
 * @property {string | null} columnId 기존 테이블이면 물리 열. 새 테이블이면 만들 때 채운다
 */

/**
 * 매핑을 검증해 계획으로 바꾼다.
 * @param {Engine} engine
 * @param {ImportMapping} mapping
 * @param {ImportTarget} target
 * @param {ImportPolicy} defaultPolicy
 * @returns {PlannedColumn[]}
 */
function plan(engine, mapping, target, defaultPolicy) {
  const columns = Array.isArray(mapping?.columns) ? mapping.columns : [];
  if (columns.length === 0) {
    throw new AppError('E_DB_QUERY', 'mapping has no columns', {
      detail: { reason: 'no_columns' },
    });
  }
  /** @type {TableInfo | null} */
  let table = null;
  if (target.kind === 'existing') {
    table = requireTable(engine, target.tableId);
    requireStrict(table);
  }
  const seenSources = new Set();
  const seenTargets = new Set();
  return columns.map((m) => {
    if (typeof m.source !== 'number' || !Number.isInteger(m.source) || m.source < 0) {
      throw new AppError('E_DB_QUERY', 'mapping source must be a non-negative integer', {
        detail: { source: m.source },
      });
    }
    if (seenSources.has(m.source)) {
      throw new AppError('E_DB_QUERY', 'source column mapped twice', {
        detail: { source: m.source },
      });
    }
    seenSources.add(m.source);
    const policy = m.policy === undefined ? defaultPolicy : m.policy;
    if (!isImportPolicy(policy)) {
      throw new AppError('E_DB_QUERY', 'unknown import policy', { detail: { policy } });
    }
    if (table) {
      const live = table.columns.find((c) => c.id === m.columnId && c.deletedAt === null);
      if (!live) {
        throw new AppError('E_DB_QUERY', 'target column not found', {
          detail: { tableId: table.id, columnId: m.columnId },
        });
      }
      if (seenTargets.has(live.id)) {
        throw new AppError('E_DB_QUERY', 'target column mapped twice', {
          detail: { columnId: live.id },
        });
      }
      seenTargets.add(live.id);
      if (policy === 'text') {
        throw new AppError('E_DB_QUERY', 'policy text is only for new tables', {
          detail: { reason: 'policy_text_existing', columnId: live.id },
        });
      }
      return {
        source: m.source,
        name: live.name,
        type: live.type,
        options: live.options ? { ...live.options } : null,
        policy,
        columnId: live.id,
      };
    }
    if (!isLogicalType(m.type)) {
      throw new AppError('E_VALUE_INVALID', `unknown column type ${String(m.type)}`, {
        detail: { type: m.type },
      });
    }
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    if (!name) {
      throw new AppError('E_NAME_INVALID', 'column name is empty', {
        detail: { reason: 'empty', source: m.source },
      });
    }
    return { source: m.source, name, type: m.type, options: null, policy, columnId: null };
  });
}

/**
 * Worker 경계를 넘어온 대상의 형태를 확인한다.
 * @param {unknown} target
 * @returns {ImportTarget}
 */
export function requireTarget(target) {
  const o =
    typeof target === 'object' && target !== null
      ? /** @type {Record<string, unknown>} */ (target)
      : {};
  if (o.kind === 'new' && typeof o.name === 'string') return { kind: 'new', name: o.name };
  if (o.kind === 'existing' && typeof o.tableId === 'string') {
    return { kind: 'existing', tableId: o.tableId };
  }
  throw new AppError(
    'E_DB_QUERY',
    'import target must be { kind: new, name } or { kind: existing, tableId }',
    {
      detail: { kind: String(o.kind).slice(0, 20) },
    },
  );
}

/**
 * `select` 열의 문자열 값. `validate`의 `toText`와 같은 규칙(불리언은 true/false).
 * @param {SourceValue} raw
 * @returns {string}
 */
function selectText(raw) {
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return String(raw);
}

/**
 * 가져오기 실행(`import.run`). 트랜잭션 하나이며 실패·취소는 롤백이다.
 * @param {RunArgs} args
 * @returns {Promise<{ report: ImportReport }>}
 */
export async function run(args) {
  const { engine, mapping, target } = args;
  const defaultPolicy = args.policy ?? 'null';
  const planned = plan(engine, mapping, requireTarget(target), defaultPolicy);
  /** @type {string[]} */
  const demoted = [];
  for (;;) {
    try {
      const report = await engine.transaction(() => attempt(args, planned, demoted));
      return { report };
    } catch (err) {
      const demote =
        err instanceof AppError && typeof err.detail === 'object' && err.detail !== null
          ? /** @type {{ demoteSource?: number }} */ (err.detail).demoteSource
          : undefined;
      if (demote === undefined) throw err;
      // `text` 정책: 그 열을 text로 바꿔 처음부터 다시(롤백은 transaction()이 했다).
      const col = planned.find((p) => p.source === demote);
      if (!col) throw err;
      col.type = 'text';
      col.options = null;
      col.policy = 'null';
      demoted.push(col.name);
    }
  }
}

/**
 * 트랜잭션 안의 시도 하나. `text` 정책이 걸리면 `demoteSource`를 담은 오류를 던져 바깥이 다시 시도한다.
 * @param {RunArgs} args
 * @param {PlannedColumn[]} planned
 * @param {string[]} demoted
 * @returns {Promise<ImportReport>}
 */
async function attempt(args, planned, demoted) {
  const { engine, file, options, target, signal, progress } = args;
  /** @type {string} */
  let tableId;
  if (target.kind === 'new') {
    tableId = (await create(engine, { name: target.name })).tableId;
    for (const col of planned) {
      const added = await addColumn(engine, tableId, {
        name: col.name,
        type: col.type,
        options: col.options,
      });
      col.columnId = added.columnId;
    }
  } else {
    tableId = target.tableId;
  }
  const columnIds = planned.map((c) => /** @type {string} */ (c.columnId));
  const idents = [...columnIds.map(quoteIdent), quoteIdent('_created_at')].join(', ');
  const marks = planned.map(() => '?').join(', ');
  const insert = engine.prepareCached(
    `INSERT INTO ${quoteIdent(tableId)} (${idents}) VALUES (${marks}, ?)`,
  );
  const createdAt = nowIso();

  const source = await openSource(file, options);
  const width = source.header
    ? source.header.length
    : planned.reduce((max, c) => Math.max(max, c.source + 1), 0);
  const total = source.total ?? 0;

  /** @type {ImportReport} */
  const report = {
    tableId,
    inserted: 0,
    skipped: 0,
    nulled: 0,
    errors: [],
    errorCount: 0,
    demoted: [...demoted],
  };
  /** @param {ReportError} error */
  const record = (error) => {
    report.errorCount += 1;
    if (report.errors.length < MAX_REPORT_ERRORS) report.errors.push(error);
  };
  /** `select` 열에 새로 더한 항목. 끝에서 메타를 갱신한다. */
  /** @type {Map<string, string[]>} */
  const grownChoices = new Map();

  /** @type {SqlValue[][]} */
  let batch = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    if (signal?.aborted) {
      throw new AppError('E_IMPORT_CANCELLED', 'import cancelled', {
        detail: { done: report.inserted, total },
      });
    }
    const pending = batch;
    batch = [];
    batchBytes = 0;
    await engine.runBatch(insert, pending);
    report.inserted += pending.length;
    progress?.({ phase: 'insert', done: report.inserted, total });
    // 취소 메시지와 진행률 표시가 배치 사이에 끼어들 수 있게 태스크 큐로 한 번 돌아간다.
    await yieldToEventLoop();
  };

  progress?.({ phase: 'insert', done: 0, total });
  for await (const row of source.rows) {
    if (row.cells.length > width) record({ rowIndex: row.rowIndex, reason: 'extra_fields' });
    if (row.errorCells) {
      for (const col of planned) {
        if (row.errorCells.includes(col.source)) {
          record({ rowIndex: row.rowIndex, column: col.name, reason: 'error_cell' });
        }
      }
    }
    /** @type {SqlValue[]} */
    const params = [];
    let allEmpty = true;
    for (const col of planned) {
      const raw = row.cells[col.source] ?? null;
      if (isEmpty(raw)) {
        params.push(null);
        continue;
      }
      allEmpty = false;
      if (typeof raw === 'string' && raw.length * 2 > MAX_CELL_BYTES) {
        params.push(null);
        report.nulled += 1;
        record({ rowIndex: row.rowIndex, column: col.name, reason: 'too_long' });
        continue;
      }
      if (col.type === 'select') {
        // 4.2: 가져오기에서 선택 항목에 없는 값은 자동으로 더한다.
        const text = selectText(raw);
        const choices = col.options?.choices ?? [];
        if (!choices.includes(text)) {
          choices.push(text);
          col.options = { ...(col.options ?? {}), choices };
          grownChoices.set(/** @type {string} */ (col.columnId), choices);
        }
        params.push(text);
        continue;
      }
      const result = validate(col.type, raw, col.options ?? undefined);
      if (result.ok) {
        params.push(result.value);
        continue;
      }
      if (col.policy === 'abort') {
        throw new AppError('E_VALUE_INVALID', `cannot convert value to ${col.type}`, {
          detail: {
            type: col.type,
            reason: result.reason,
            rowIndex: row.rowIndex,
            column: col.name,
            preview: String(raw).slice(0, 80),
          },
        });
      }
      if (col.policy === 'text') {
        throw new AppError('E_VALUE_INVALID', `demote column to text`, {
          detail: { demoteSource: col.source, rowIndex: row.rowIndex, column: col.name },
        });
      }
      params.push(null);
      report.nulled += 1;
      record({ rowIndex: row.rowIndex, column: col.name, reason: 'invalid' });
    }
    if (allEmpty) {
      report.skipped += 1;
      continue;
    }
    params.push(createdAt);
    const bytes = estimateCloneBytes(params);
    if (batch.length > 0 && (batch.length >= BATCH_ROWS || batchBytes + bytes > BATCH_BYTES)) {
      await flush();
    }
    batch.push(params);
    batchBytes += bytes;
  }
  await flush();
  if (signal?.aborted) {
    throw new AppError('E_IMPORT_CANCELLED', 'import cancelled', {
      detail: { done: report.inserted, total },
    });
  }
  for (const [columnId, choices] of grownChoices) {
    const col = planned.find((c) => c.columnId === columnId);
    const merged = { ...(col?.options ?? {}), choices };
    engine.run('UPDATE _jdr_columns SET options = ? WHERE table_id = ? AND id = ?', [
      JSON.stringify(merged),
      tableId,
      columnId,
    ]);
  }
  progress?.({ phase: 'insert', done: report.inserted, total: total || report.inserted });
  return report;
}
