// @ts-check
/**
 * 데이터베이스 정리 대화상자(D-17, Step 13): 테이블별 삭제된 열 목록(모두 체크), DB 크기와 줄일 수 있는 빈 공간,
 * 되돌릴 수 없음과 남는 사본 안내, 실행 중 진행률·취소.
 *
 * 실행은 v1 내보내기 대화상자처럼 확인 버튼의 비동기 `validate`로 돌린다. 실패하면 원인별 문구를 보이고 열어 두며,
 * 요청한 열이 그사이 복원되었으면 계획을 다시 읽는다. 사용자 데이터(테이블·열 이름)는 textContent로만 넣는다(CLAUDE.md 5.5).
 */
import { hasMessage, t } from '../../i18n/index.js';
import { formatBytes } from '../../util/bytes.js';
import { toAppError } from '../../util/errors.js';
import { formatInteger } from '../../util/format.js';
import { typeLabel } from './column.js';
import { openDialog } from './dialog.js';
import { formatBackupTime } from './settings.js';

/** @typedef {import('../../app/store.js').Store} Store */
/** @typedef {import('../../db/cleanup.js').CleanupPlan} CleanupPlan */
/** @typedef {import('../../db/cleanup.js').CleanupResult} CleanupResult */
/** @typedef {import('../../db/cleanup.js').SchemaBlocker} SchemaBlocker */
/** @typedef {import('../../util/errors.js').AppError} AppError */
/** @typedef {import('../toast.js').Toasts} Toasts */

/** 정리할 수 없는 테이블(`blocked`)의 이유 문구(Step 13 예외 처리). */
const BLOCKED_KEYS = /** @type {const} */ ({
  foreign_key: 'cleanup.blocked.foreign_key',
  index: 'cleanup.blocked.index',
  trigger: 'cleanup.blocked.trigger',
  view: 'cleanup.blocked.view',
  columns: 'cleanup.blocked.columns',
});

/**
 * 정리할 수 없는 테이블의 문구. `object`는 다른 도구가 만든 객체 이름(사용자 데이터)이라 textContent로만 넣는다.
 * @param {SchemaBlocker} blocked
 * @returns {string}
 */
export function blockedText(blocked) {
  return t(BLOCKED_KEYS[blocked.reason], { object: blocked.object });
}

/**
 * 오류 코드의 문구(뒤에 코드). 정리 문구의 `{message}` 자리에 들어간다.
 * @param {{ code: string, message: string }} err
 * @returns {string}
 */
export function cleanupErrorMessage(err) {
  const key = `error.${err.code}`;
  return `${hasMessage(key) ? t(key) : err.message} (${err.code})`;
}

/**
 * 실패 문구. 취소·그사이 바뀐 목록은 따로, 나머지는 "정리 전 상태 그대로이며 원본 파일도 바뀌지 않았다"를 붙인다(CLAUDE.md 5.6).
 * @param {AppError} err
 * @returns {string}
 */
export function cleanupErrorText(err) {
  if (err.code === 'E_IMPORT_CANCELLED') return t('cleanup.cancelled');
  const detail =
    typeof err.detail === 'object' && err.detail !== null
      ? /** @type {Record<string, unknown>} */ (err.detail)
      : {};
  if (
    err.code === 'E_DB_QUERY' &&
    (detail.reason === 'not_deleted' || detail.reason === 'column_not_found')
  ) {
    return t('cleanup.stale');
  }
  return t('cleanup.failed', { message: cleanupErrorMessage(err) });
}

/**
 * 정리 대화상자를 연다. 정리했으면 결과, 취소·실패로 닫았으면 null.
 * @param {{ store: Store, toasts: Toasts }} deps
 * @returns {Promise<CleanupResult | null>}
 */
export async function openCleanupDialog(deps) {
  const { store, toasts } = deps;
  let plan = await store.planCleanup();
  if (!plan) return null;
  const caps = store.capabilities();
  /** @type {AbortController | null} */
  let controller = null;
  let phase = '';
  /** @type {{ result: CleanupResult | null }} */
  const outcome = { result: null };

  const list = document.createElement('div');
  list.className = 'jdr-cleanup__list';
  list.dataset.role = 'cleanup-list';
  const size = document.createElement('p');
  size.className = 'jdr-import__muted';
  size.dataset.role = 'cleanup-size';
  const memory = document.createElement('p');
  memory.className = 'jdr-import__warning';
  memory.dataset.role = 'cleanup-memory';
  memory.hidden = true;
  const progressBox = document.createElement('div');
  progressBox.className = 'jdr-import__progress';
  progressBox.hidden = true;
  const progressBar = document.createElement('progress');
  const progressText = document.createElement('span');
  progressText.id = `jdr-cleanup-progress-${Date.now().toString(36)}`;
  progressText.setAttribute('role', 'status');
  progressBar.setAttribute('aria-labelledby', progressText.id);
  progressBox.append(progressBar, progressText);
  /** @type {Array<{ box: HTMLInputElement, tableId: string, columnId: string }>} */
  let checks = [];

  /**
   * @param {string} tableId
   * @param {string} columnId
   */
  const checkKey = (tableId, columnId) => `${tableId}\u0000${columnId}`;

  /**
   * 지금 체크를 푼 열. 목록을 다시 그릴 때 넘겨, 복원하려고 남겨 둔 열이 다시 체크되지 않게 한다(다시 체크되면
   * 다음 실행에서 되돌릴 수 없이 지워진다).
   * @returns {Set<string>}
   */
  function uncheckedNow() {
    return new Set(
      checks.filter((c) => !c.box.checked).map((c) => checkKey(c.tableId, c.columnId)),
    );
  }

  /**
   * @param {CleanupPlan} next
   * @param {Set<string>} [unchecked] 체크를 푼 채로 둘 열(`checkKey`)
   */
  function renderPlan(next, unchecked = new Set()) {
    plan = next;
    list.replaceChildren();
    checks = [];
    if (next.tables.length === 0) {
      const none = document.createElement('p');
      none.className = 'jdr-import__muted';
      none.textContent = t('cleanup.noColumns');
      list.append(none);
    }
    for (const table of next.tables) {
      const group = document.createElement('fieldset');
      group.className = 'jdr-cleanup__table';
      const legend = document.createElement('legend');
      legend.textContent = table.name;
      group.append(legend);
      // 재작성이 스키마를 옮길 수 없는 테이블은 고를 수 없다(체크 상자는 꺼진 채 체크하지 않음). 이유를 먼저 보인다.
      const blocked = table.blocked ?? null;
      if (blocked) {
        const note = document.createElement('p');
        note.className = 'jdr-import__warning';
        note.dataset.role = 'cleanup-blocked';
        note.textContent = blockedText(blocked);
        group.append(note);
      }
      for (const column of table.columns) {
        const label = document.createElement('label');
        label.className = 'jdr-import__check';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !blocked && !unchecked.has(checkKey(table.tableId, column.id));
        box.disabled = blocked !== null;
        box.dataset.column = column.id;
        const text = document.createElement('span');
        text.textContent = t('cleanup.column', {
          name: column.name,
          type: typeLabel(column.type),
          at: formatBackupTime(Date.parse(column.deletedAt)),
        });
        label.append(box, text);
        group.append(label);
        if (!blocked) checks.push({ box, tableId: table.tableId, columnId: column.id });
      }
      if (table.ftsEnabled && !blocked) {
        const note = document.createElement('p');
        note.className = 'jdr-import__muted';
        note.textContent = t('cleanup.index');
        group.append(note);
      }
      list.append(group);
    }
    size.textContent = next.compactsOnSave
      ? t('cleanup.sizeNative', { size: formatBytes(next.dbBytes) })
      : t('cleanup.size', { size: formatBytes(next.dbBytes), free: formatBytes(next.freeBytes) });
    // 재작성과 VACUUM은 DB 크기만큼 메모리를 더 쓴다(R10). 실패해도 전체 롤백이라 실행은 허용한다.
    memory.hidden = !(next.dbBytes * 2 > caps.maxFileBytes);
    memory.textContent = t('cleanup.memoryWarn', { need: formatBytes(next.dbBytes * 2) });
  }

  /** @param {{ phase: string, done: number, total: number }} p */
  function showProgress(p) {
    phase = p.phase;
    progressBox.hidden = false;
    if (p.phase === 'vacuum' || p.total <= 0) {
      progressBar.removeAttribute('value');
    } else {
      progressBar.max = p.total;
      progressBar.value = Math.min(p.done, p.total);
    }
    if (p.phase === 'vacuum') progressText.textContent = t('cleanup.progress.vacuum');
    else if (p.phase === 'index') {
      progressText.textContent = t('cleanup.progress.index', {
        done: formatInteger(p.done),
        total: formatInteger(p.total),
      });
    } else {
      progressText.textContent = t('cleanup.progress.purge', {
        done: formatInteger(p.done),
        total: formatInteger(p.total),
      });
    }
  }

  /**
   * 실행. 성공하면 null(닫힘), 실패하면 문구(열어 둠).
   * @returns {Promise<string | null>}
   */
  async function runCleanup() {
    const columns = checks
      .filter((c) => c.box.checked)
      .map((c) => ({ tableId: c.tableId, columnId: c.columnId }));
    // 저장이 빈 공간을 없애는 엔진에서 고른 열이 없으면 할 일이 없다(D-17).
    if (columns.length === 0 && plan?.compactsOnSave) return t('settings.cleanupNothing');
    controller = new AbortController();
    phase = '';
    for (const c of checks) c.box.disabled = true;
    try {
      const result = await store.runCleanup(columns, {
        signal: controller.signal,
        onProgress: (p) => showProgress(p),
      });
      outcome.result = result;
      return null;
    } catch (err) {
      const appErr = toAppError(err);
      if (
        appErr.code === 'E_DB_QUERY' &&
        typeof appErr.detail === 'object' &&
        appErr.detail !== null
      ) {
        // 요청한 열이 그사이 복원되었거나 없어졌다(저널 재생, 다른 경로의 복원). 계획을 다시 읽어 보인다.
        const unchecked = uncheckedNow();
        const next = await store.planCleanup();
        if (next) renderPlan(next, unchecked);
      }
      return cleanupErrorText(appErr);
    } finally {
      controller = null;
      phase = '';
      progressBox.hidden = true;
      for (const c of checks) c.box.disabled = false;
    }
  }

  const value = await openDialog({
    title: t('cleanup.title'),
    body: (body) => {
      const intro = document.createElement('p');
      intro.className = 'jdr-dialog__message';
      intro.textContent = t('cleanup.intro');
      const warnings = document.createElement('div');
      warnings.className = 'jdr-cleanup__notes';
      for (const key of /** @type {const} */ ([
        'cleanup.irreversible',
        caps.persistence === 'snapshot' ? 'cleanup.copies' : 'cleanup.copiesNative',
        'cleanup.saveToShrink',
      ])) {
        const p = document.createElement('p');
        p.className = 'jdr-dialog__message';
        p.textContent = t(key);
        warnings.append(p);
      }
      body.append(intro, list, size, memory, warnings, progressBox);
      if (plan) renderPlan(plan);
    },
    buttons: [
      { label: t('dialog.cancel'), value: 'cancel' },
      { label: t('cleanup.run'), value: 'ok', primary: true, danger: true },
    ],
    cancelValue: 'cancel',
    validate: () => runCleanup(),
    beforeCancel: () => {
      if (!controller) return true;
      // VACUUM은 취소할 수 없다(재작성은 이미 커밋됨). 끝날 때까지 열어 둔다.
      if (phase === 'vacuum') return false;
      controller.abort();
      progressText.textContent = t('cleanup.cancelling');
      return false;
    },
    wide: true,
  });
  const result = outcome.result;
  if (value !== 'ok' || !result) return null;
  const sizes = { before: formatBytes(result.bytesBefore), after: formatBytes(result.bytesAfter) };
  if (result.removedColumns > 0) {
    toasts.info('cleanup.done', { count: formatInteger(result.removedColumns), ...sizes });
  } else if (result.vacuumed) {
    toasts.info('cleanup.doneCompacted', sizes);
  }
  if (result.vacuumError) {
    toasts.warn('cleanup.vacuumFailed', { message: cleanupErrorMessage(result.vacuumError) });
  }
  return result;
}
