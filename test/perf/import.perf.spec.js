// @ts-check
/**
 * Step 7 완료 기준: 30만 행 × 20열 CSV(약 150 MB) 가져오기 60초 이하(Chromium, Worker 모드).
 * 실제 산출물의 가져오기 대화상자(숨은 파일 입력 → 미리보기 → "가져오기" → 보고서)를 통째로 잰다.
 * CSV 픽스처는 없으면 `scripts/gen-fixture.mjs`의 `generate()`로 만든다(커밋하지 않는 generated/).
 */
import { expect, test } from '@playwright/test';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from '../../scripts/gen-fixture.mjs';
import { FIXTURE_ROWS } from './fixture.js';

const PAGE_URL = pathToFileURL(path.resolve('dist/test/jdrdatabase.html')).href;
const CSV_PATH = path.resolve(`test/fixtures/generated/import-${FIXTURE_ROWS}.csv`);
/** DESIGN.md Step 7 완료 기준·8장 예산. */
const IMPORT_BUDGET_MS = 60_000;

test.beforeAll(async () => {
  const exists = await stat(CSV_PATH).then(
    (s) => s.isFile() && s.size > 0,
    () => false,
  );
  if (exists) return;
  console.log(`generating ${FIXTURE_ROWS}-row CSV -> ${CSV_PATH}`);
  const started = Date.now();
  // 장문 2열을 20~60 단어(약 100~400자)로 두면 30만 행에서 약 150 MB가 된다(8장 규격).
  await generate({
    rows: FIXTURE_ROWS,
    cols: 20,
    long: 2,
    longMin: 20,
    longMax: 60,
    out: CSV_PATH,
  });
  const { size } = await stat(CSV_PATH);
  console.log(`generated ${size} bytes in ${((Date.now() - started) / 1000).toFixed(1)} s`);
});

test('30만 행 CSV 가져오기: 대화상자 열기부터 보고서까지 60초 이하', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
  await expect(page.locator('.jdr-statusbar__item').nth(1)).toHaveText('Worker 모드');
  const { size } = await stat(CSV_PATH);

  const previewStarted = Date.now();
  await page.locator('input.jdr-import-input').setInputFiles(CSV_PATH);
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('table[data-role="preview"]')).toBeVisible({ timeout: 120_000 });
  const previewMs = Date.now() - previewStarted;
  const columnRows = dialog.locator('table[data-role="columns"] tbody tr');
  await expect(columnRows).toHaveCount(20);

  const importStarted = Date.now();
  await dialog.getByRole('button', { name: '가져오기' }).click();
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('가져오기 결과', {
    timeout: IMPORT_BUDGET_MS * 3,
  });
  const importMs = Date.now() - importStarted;
  await expect(dialog.locator('.jdr-dialog__message').first()).toHaveText(
    `넣은 행: ${FIXTURE_ROWS.toLocaleString('ko-KR')}`,
  );
  await dialog.getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText(
    `행 ${FIXTURE_ROWS.toLocaleString('ko-KR')}개`,
  );

  console.log(
    `[perf] csv ${size} bytes: preview ${previewMs} ms, import ${importMs} ms (budget ${IMPORT_BUDGET_MS} ms)`,
  );
  expect(importMs).toBeLessThanOrEqual(IMPORT_BUDGET_MS);
});
