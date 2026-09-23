// @ts-check
/**
 * 스트리밍 CSV 파서(Step 7, D-09). Worker에서 실행되며 DOM에 닿지 않는다.
 *
 * - `detectEncoding(headBytes)`: BOM → BOM 없는 UTF-16(NUL 바이트 분포) → UTF-8 `fatal` 디코딩 → EUC-KR 추정.
 * - `detectDelimiter(headText)`: 후보마다 앞 몇 행을 파싱해 행 간 필드 수 분산이 가장 작은 것.
 * - `createParser({ delimiter })`: 필드 안/따옴표 안/따옴표 뒤 상태를 조각 사이에 유지하는 상태 기계.
 *   조각 경계에 걸친 레코드는 다음 조각으로 이월되고, `\r\n`이 경계에서 갈라져도 한 줄로 읽는다.
 * - `parse(blob, options)`: `blob.stream()` → `TextDecoderStream` → 상태 기계. 소비자가 일찍 멈추면 스트림을 취소한다.
 */
import { KB } from '../util/bytes.js';
import { AppError } from '../util/errors.js';

/** @typedef {'utf-8' | 'utf-16le' | 'utf-16be' | 'euc-kr'} CsvEncoding */

/**
 * 파일 안의 레코드 하나. `rowIndex`는 레코드 순번(1부터, 헤더 포함, 빈 줄 제외)이다.
 * @typedef {object} CsvRecord
 * @property {number} rowIndex
 * @property {string[]} cells
 */

/** 지원하는 인코딩. UI 선택지와 감지 결과가 같은 목록을 쓴다. */
export const CSV_ENCODINGS = Object.freeze(
  /** @type {const} */ (['utf-8', 'utf-16le', 'utf-16be', 'euc-kr']),
);

/** 구분자 후보. 감지와 UI 선택지가 같은 목록을 쓴다. */
export const DELIMITER_CANDIDATES = Object.freeze([',', '\t', ';', '|']);

/** 인코딩·구분자 감지에 읽는 파일 머리 크기. */
export const DETECT_HEAD_BYTES = 64 * KB;

/** 구분자 감지에 보는 레코드 수. */
export const DETECT_ROWS = 20;

/** 이 비율보다 깨진 문자(U+FFFD)가 많으면 인코딩 오판으로 경고한다(Step 7 예외 처리). */
export const REPLACEMENT_WARN_RATIO = 0.01;

/**
 * @param {unknown} value
 * @returns {value is CsvEncoding}
 */
export function isCsvEncoding(value) {
  return (
    typeof value === 'string' && /** @type {readonly string[]} */ (CSV_ENCODINGS).includes(value)
  );
}

/**
 * 파일 머리의 바이트로 인코딩을 추정한다. 사용자가 미리보기에서 바꿀 수 있으므로 추정이면 충분하다.
 * @param {Uint8Array} headBytes
 * @returns {CsvEncoding}
 */
export function detectEncoding(headBytes) {
  const n = headBytes.length;
  if (n >= 3 && headBytes[0] === 0xef && headBytes[1] === 0xbb && headBytes[2] === 0xbf) {
    return 'utf-8';
  }
  if (n >= 2 && headBytes[0] === 0xff && headBytes[1] === 0xfe) return 'utf-16le';
  if (n >= 2 && headBytes[0] === 0xfe && headBytes[1] === 0xff) return 'utf-16be';
  // BOM 없는 UTF-16: 라틴 문자가 주된 텍스트는 NUL이 한쪽 위치(LE는 홀수, BE는 짝수)에 몰린다.
  if (n >= 4) {
    let even = 0;
    let odd = 0;
    for (let i = 0; i < n; i += 1) {
      if (headBytes[i] === 0) {
        if (i % 2 === 0) even += 1;
        else odd += 1;
      }
    }
    const half = n / 2;
    if (odd > half * 0.3 && even < half * 0.05) return 'utf-16le';
    if (even > half * 0.3 && odd < half * 0.05) return 'utf-16be';
  }
  try {
    // `stream: true`라 머리 끝에서 잘린 다중 바이트 문자는 오류가 아니다. 잘못된 바이트열만 던진다.
    new TextDecoder('utf-8', { fatal: true }).decode(headBytes, { stream: true });
    return 'utf-8';
  } catch {
    return 'euc-kr';
  }
}

/**
 * 파일 머리를 디코딩한다(감지·미리보기용). 끝에서 잘린 문자는 버린다.
 * @param {Uint8Array} headBytes
 * @param {CsvEncoding} encoding
 * @returns {string}
 */
export function decodeHead(headBytes, encoding) {
  try {
    return new TextDecoder(encoding).decode(headBytes, { stream: true });
  } catch (err) {
    throw new AppError('E_IMPORT_ENCODING', `cannot decode as ${encoding}`, {
      cause: err,
      detail: { encoding },
    });
  }
}

/**
 * 텍스트 안의 깨진 문자(U+FFFD) 비율.
 * @param {string} text
 * @returns {number}
 */
export function replacementRatio(text) {
  if (text.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) count += 1;
  }
  return count / text.length;
}

/** @typedef {{ push: (text: string) => CsvRecord[], end: () => { records: CsvRecord[], unterminatedQuote: boolean } }} CsvParser */

const QUOTE = 34;
const CR = 13;
const LF = 10;

/** 상태: 필드 시작 / 따옴표 없는 필드 안 / 따옴표 안 / 닫는 따옴표 뒤. */
const AT_FIELD_START = 0;
const IN_FIELD = 1;
const IN_QUOTES = 2;
const AFTER_QUOTE = 3;

/**
 * 조각을 차례로 받아 완성된 레코드를 돌려주는 상태 기계. 마지막 레코드는 `end()`가 마무리한다.
 * @param {{ delimiter: string }} options 구분자는 한 글자
 * @returns {CsvParser}
 */
export function createParser(options) {
  if (typeof options.delimiter !== 'string' || options.delimiter.length !== 1) {
    throw new AppError('E_DB_QUERY', 'delimiter must be a single character', {
      detail: { delimiter: String(options.delimiter).slice(0, 8) },
    });
  }
  const delim = options.delimiter.charCodeAt(0);
  /** @type {string[]} */
  let cells = [];
  let field = '';
  let state = AT_FIELD_START;
  let rowIndex = 0;
  /** 직전 조각이 `\r`로 끝났다. 다음 조각의 첫 `\n`은 같은 줄바꿈이다. */
  let pendingLf = false;
  /** 이 레코드에 구분자·문자·따옴표가 하나라도 있었다. 없으면 빈 줄이라 레코드가 아니다. */
  let rowHasContent = false;

  /** @param {CsvRecord[]} out */
  function endRecord(out) {
    if (!rowHasContent) {
      cells = [];
      field = '';
      return;
    }
    cells.push(field);
    field = '';
    rowIndex += 1;
    out.push({ rowIndex, cells });
    cells = [];
    rowHasContent = false;
  }

  return {
    push(text) {
      /** @type {CsvRecord[]} */
      const out = [];
      const n = text.length;
      let i = 0;
      if (pendingLf) {
        pendingLf = false;
        if (n > 0 && text.charCodeAt(0) === LF) i = 1;
      }
      while (i < n) {
        if (state === IN_QUOTES) {
          const q = text.indexOf('"', i);
          if (q === -1) {
            field += text.slice(i);
            i = n;
            break;
          }
          field += text.slice(i, q);
          i = q + 1;
          state = AFTER_QUOTE;
          continue;
        }
        const c = text.charCodeAt(i);
        if (state === AFTER_QUOTE) {
          if (c === QUOTE) {
            field += '"';
            state = IN_QUOTES;
            i += 1;
            continue;
          }
          // 닫는 따옴표 뒤에 구분자·줄바꿈이 아닌 문자가 오면(비표준) 그대로 이어 붙인다.
          state = IN_FIELD;
          continue;
        }
        if (c === QUOTE && state === AT_FIELD_START) {
          state = IN_QUOTES;
          rowHasContent = true;
          i += 1;
          continue;
        }
        if (c === delim) {
          cells.push(field);
          field = '';
          state = AT_FIELD_START;
          rowHasContent = true;
          i += 1;
          continue;
        }
        if (c === CR || c === LF) {
          endRecord(out);
          state = AT_FIELD_START;
          if (c === CR) {
            if (i + 1 < n) {
              if (text.charCodeAt(i + 1) === LF) i += 1;
            } else {
              pendingLf = true;
            }
          }
          i += 1;
          continue;
        }
        // 따옴표 없는 필드의 문자열: 다음 구분자·줄바꿈까지 한 번에 자른다(글자마다 이어 붙이지 않는다).
        let j = i + 1;
        while (j < n) {
          const d = text.charCodeAt(j);
          if (d === delim || d === CR || d === LF) break;
          j += 1;
        }
        field += text.slice(i, j);
        state = IN_FIELD;
        rowHasContent = true;
        i = j;
      }
      return out;
    },

    end() {
      const unterminatedQuote = state === IN_QUOTES;
      /** @type {CsvRecord[]} */
      const out = [];
      pendingLf = false;
      // 파일이 줄바꿈 없이 끝났거나 따옴표가 닫히지 않은 채 끝났으면 남은 텍스트가 마지막 레코드다.
      if (state !== AT_FIELD_START || cells.length > 0 || rowHasContent) endRecord(out);
      state = AT_FIELD_START;
      return { records: out, unterminatedQuote };
    },
  };
}

/**
 * 후보 구분자마다 앞 몇 행을 파싱해 행 간 필드 수의 분산이 가장 작은 것을 고른다. 동률이면 필드가 많은 쪽.
 * 모든 후보가 필드 1개뿐이면 쉼표.
 * @param {string} headText
 * @param {{ candidates?: readonly string[], rows?: number }} [options]
 * @returns {string}
 */
export function detectDelimiter(headText, options = {}) {
  const candidates = options.candidates ?? DELIMITER_CANDIDATES;
  const limit = options.rows ?? DETECT_ROWS;
  /** @type {{ delimiter: string, variance: number, mean: number } | null} */
  let best = null;
  for (const delimiter of candidates) {
    // 마지막 레코드는 머리에서 잘렸을 수 있으므로 `end()`의 결과는 세지 않는다.
    const records = createParser({ delimiter }).push(headText).slice(0, limit);
    if (records.length === 0) continue;
    const counts = records.map((r) => r.cells.length);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    if (!best || variance < best.variance || (variance === best.variance && mean > best.mean)) {
      best = { delimiter, variance, mean };
    }
  }
  if (!best || best.mean <= 1) return ',';
  return best.delimiter;
}

/**
 * @typedef {object} ParseOptions
 * @property {CsvEncoding} encoding
 * @property {string} delimiter
 * @property {(info: { unterminatedQuote: boolean }) => void} [onEnd] 파일 끝에 닿았을 때(일찍 멈추면 부르지 않는다)
 */

/**
 * Blob(File)을 스트리밍으로 파싱한다. BOM은 디코더가 뗀다.
 * 소비자가 `return()`으로 일찍 멈추면 스트림을 취소한다(미리보기는 앞부분만 읽는다).
 * @param {Blob} blob
 * @param {ParseOptions} options
 * @returns {AsyncGenerator<CsvRecord, void, undefined>}
 */
export async function* parse(blob, options) {
  const parser = createParser({ delimiter: options.delimiter });
  /** @type {ReadableStreamDefaultReader<string>} */
  let reader;
  try {
    reader = blob.stream().pipeThrough(new TextDecoderStream(options.encoding)).getReader();
  } catch (err) {
    throw new AppError('E_IMPORT_ENCODING', `cannot decode as ${options.encoding}`, {
      cause: err,
      detail: { encoding: options.encoding },
    });
  }
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const records = parser.push(value);
      for (const record of records) yield record;
    }
    finished = true;
    const tail = parser.end();
    options.onEnd?.({ unterminatedQuote: tail.unterminatedQuote });
    for (const record of tail.records) yield record;
  } finally {
    if (!finished) {
      // 일찍 멈춘 경우. 취소 실패는 읽기를 이미 그만둔 뒤라 결과에 영향이 없다.
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
