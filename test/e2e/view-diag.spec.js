// @ts-check
/**
 * 임시 진단 스펙(세션 F 점검 후속). `view.spec.js:415`의 `편집 중 머리글 클릭(정렬)`이 CI에서만
 * 간헐적으로 실패하는 원인을 가르기 위한 것이며, 원인을 찾으면 통째로 지운다.
 *
 * 단언하지 않는다. 같은 시나리오를 여러 번 돌면서 실패를 가를 증거만 로그로 남긴다.
 * 증거는 전부 페이지 안에서 이벤트로 모으므로(`__jdrDiag`) 경합 구간에 왕복이 끼어들지 않는다.
 *
 * 가르려는 것:
 * - H1 경합(확정은 됐는데 질의가 빨랐다): `later`가 뒤늦게 기대값이면 H1.
 * - H2 되돌림(`applyCellEdit`이 false): `edit.reverted` 토스트가 있으면 H2.
 * - H3 입력 되돌아감(`inline.open`이 한 번 더 열어 입력이 옛 값): `blur` 시점 값이 옛 값이면 H3.
 * - H4 blur 미발생: `blur` 기록이 없으면 H4.
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE_URL = pathToFileURL(path.resolve('dist/test/jdrdatabase.html')).href;
const ROWS = 200;
const TYPED = '머리글클릭확정';

/** @typedef {{ state: () => Promise<{ tables: Array<{ id: string, columns: Array<{ id: string }> }> } | null>, apply: (cmd: unknown) => Promise<unknown>, query: (sql: string) => Promise<{ rows: unknown[][] }> }} TestHook */

/** @param {import('@playwright/test').Page} page */
function hook(page) {
  return {
    state: () =>
      page.evaluate(() =>
        /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.state(),
      ),
    /** @param {string} sql */
    query: (sql) =>
      page.evaluate(
        (q) =>
          /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.query(
            q,
          ),
        sql,
      ),
  };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} typeLabel
 */
async function addColumn(page, name, typeLabel) {
  await page.click('[data-action="column-add"]');
  const dialog = page.locator('.jdr-dialog');
  await dialog.locator('input').fill(name);
  await dialog.locator('select').selectOption({ label: typeLabel });
  await dialog.getByRole('button', { name: '추가' }).click();
  await expect(page.locator('.jdr-sidebar__column-name', { hasText: name })).toBeVisible();
}

/** @param {import('@playwright/test').Page} page */
async function seed(page) {
  await page.click('[data-action="table-create"]');
  await page.locator('.jdr-dialog input').fill('고객');
  await page.locator('.jdr-dialog').getByRole('button', { name: '만들기' }).click();
  await expect(page.locator('.jdr-grid__empty')).toHaveText(
    '열이 없습니다. 사이드바의 "+ 열"로 추가하세요.',
  );
  await addColumn(page, '이름', '텍스트');
  await addColumn(page, '나이', '정수');
  await addColumn(page, '본문', '장문');
  await addColumn(page, '활성', '참/거짓');
  const state = await hook(page).state();
  const table = state?.tables[0];
  if (!table) throw new Error('table missing');
  const [name, age, body, active] = table.columns.map((c) => c.id);
  const sql = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS}) INSERT INTO "${table.id}" ("id", "${name}", "${age}", "${body}", "${active}") SELECT i, '이름' || i, i * 3, '짧은 글 ' || i, i % 2 FROM n`;
  await page.evaluate(
    (statement) =>
      /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.apply({
        type: 'test.insert',
        tableId: null,
        do: [{ sql: statement }],
        undo: [],
        summary: 'seed',
      }),
    sql,
  );
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText(`행 ${ROWS}개`);
  return { table, name };
}

/** 페이지 안에서 편집기 입력의 생성·값·blur와 토스트를 기록한다. 왕복 없음. */
function installProbe() {
  /** @type {Array<Record<string, unknown>>} */
  const diag = [];
  /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window)).__jdrDiag = diag;
  const at = () => Math.round(performance.now());
  /** @param {HTMLElement} root */
  const wire = (root) => {
    const inputs = [
      ...(root.matches?.('.jdr-editor input, .jdr-editor textarea') ? [root] : []),
      ...(root.querySelectorAll?.('.jdr-editor input, .jdr-editor textarea') ?? []),
    ];
    for (const el of inputs) {
      const field = /** @type {HTMLInputElement} */ (el);
      diag.push({ at: at(), ev: 'field-added', value: field.value });
      field.addEventListener(
        'blur',
        () => diag.push({ at: at(), ev: 'blur', value: field.value }),
        true,
      );
      field.addEventListener('input', () =>
        diag.push({ at: at(), ev: 'input', value: field.value }),
      );
    }
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.className && String(n.className).includes('jdr-toast')) {
          diag.push({ at: at(), ev: 'toast', text: (n.textContent ?? '').slice(0, 60) });
        }
        wire(n);
      }
      for (const n of m.removedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.matches?.('.jdr-editor input, .jdr-editor textarea')) {
          diag.push({
            at: at(),
            ev: 'field-removed',
            value: /** @type {HTMLInputElement} */ (n).value,
          });
        } else if (n.querySelector?.('.jdr-editor input, .jdr-editor textarea')) {
          diag.push({ at: at(), ev: 'field-removed-subtree' });
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 720 });
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
});

for (let probe = 1; probe <= 6; probe += 1) {
  test(`DIAG probe ${probe}: 편집 중 머리글 클릭`, async ({ page }) => {
    /** @type {string[]} */
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err.message).slice(0, 200)));

    const { table, name } = await seed(page);
    await page.evaluate(installProbe);

    await page
      .locator('.jdr-grid__row[data-row="0"]:not([hidden]) .jdr-grid__cell[data-col="0"]')
      .dblclick();
    await expect(page.locator('.jdr-editor input')).toBeVisible();
    await page.locator('.jdr-editor input').fill(TYPED);
    await page.locator('.jdr-grid__hcell', { hasText: '나이' }).click();
    await expect(page.locator('.jdr-grid__hcell', { hasText: '나이' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    await expect(page.locator('.jdr-editor')).toBeHidden();

    const sql = `SELECT "${name}" FROM "${table.id}" WHERE "id" = 1`;
    const immediate = (await hook(page).query(sql)).rows[0]?.[0];
    const diag = await page.evaluate(
      () => /** @type {{ __jdrDiag: unknown }} */ (/** @type {unknown} */ (window)).__jdrDiag,
    );
    await page.waitForTimeout(1500);
    const later = (await hook(page).query(sql)).rows[0]?.[0];

    console.log(
      `DIAG-${probe} ${JSON.stringify({
        ok: immediate === TYPED,
        immediate,
        later,
        pageErrors,
        diag,
      })}`,
    );
  });
}
