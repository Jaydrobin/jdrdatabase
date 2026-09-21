// @ts-check
/**
 * Step 8 완료 기준: 5만 행 × 20열 xlsx 가져오기 20초 이하. 실제 산출물의 가져오기 대화상자를 통째로 잰다.
 * xlsx 픽스처는 없으면 SheetJS로 만든다(커밋하지 않는 generated/).
 */
import { expect, test } from '@playwright/test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import XLSX from '../../vendor/xlsx.full.min.js';
import { makeRandom } from '../../scripts/gen-fixture.mjs';

const PAGE_URL = pathToFileURL(path.resolve('dist/test/jdrdatabase.html')).href;
const ROWS = Number(process.env.JDR_PERF_XLSX_ROWS ?? 50_000);
const COLS = 20;
const XLSX_PATH = path.resolve(`test/fixtures/generated/import-${ROWS}.xlsx`);
/** DESIGN.md Step 8 완료 기준. */
const IMPORT_BUDGET_MS = 20_000;

test.beforeAll(async () => {
  const exists = await stat(XLSX_PATH).then(
    (s) => s.isFile() && s.size > 0,
    () => false,
  );
  if (exists) return;
  console.log(`generating ${ROWS}-row xlsx -> ${XLSX_PATH}`);
  const started = Date.now();
  const rand = makeRandom(20260921);
  const words = ['사과', '바나나', 'grape', 'melon', 'berry'];
  /** @type {unknown[][]} */
  const aoa = [];
  const header = [];
  for (let c = 0; c < COLS; c += 1) header.push(`col_${c}`);
  aoa.push(header);
  for (let r = 0; r < ROWS; r += 1) {
    /** @type {unknown[]} */
    const row = [];
    for (let c = 0; c < COLS; c += 1) {
      switch (c % 5) {
        case 0:
          row.push(Math.floor(rand() * 1_000_000));
          break;
        case 1:
          row.push(Number((rand() * 10_000).toFixed(3)));
          break;
        case 2:
          row.push(rand() < 0.5);
          break;
        case 3:
          row.push(new Date(2020, 0, 1 + Math.floor(rand() * 2_000)));
          break;
        default:
          row.push(`${words[Math.floor(rand() * words.length)]} ${Math.floor(rand() * 100)}`);
      }
    }
    aoa.push(row);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'bench');
  await mkdir(path.dirname(XLSX_PATH), { recursive: true });
  await writeFile(XLSX_PATH, new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
  const { size } = await stat(XLSX_PATH);
  console.log(`generated ${size} bytes in ${((Date.now() - started) / 1000).toFixed(1)} s`);
});

test('5만 행 xlsx 가져오기: 대화상자 열기부터 보고서까지 20초 이하', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
  const { size } = await stat(XLSX_PATH);

  const previewStarted = Date.now();
  await page.locator('input.jdr-import-input').setInputFiles(XLSX_PATH);
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('table[data-role="preview"]')).toBeVisible({ timeout: 120_000 });
  const previewMs = Date.now() - previewStarted;
  await expect(dialog.locator('table[data-role="columns"] tbody tr')).toHaveCount(COLS);

  const importStarted = Date.now();
  await dialog.getByRole('button', { name: '가져오기' }).click();
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('가져오기 결과', {
    timeout: IMPORT_BUDGET_MS * 3,
  });
  const importMs = Date.now() - importStarted;
  await expect(dialog.locator('.jdr-dialog__message').first()).toHaveText(
    `넣은 행: ${ROWS.toLocaleString('ko-KR')}`,
  );
  await dialog.getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText(
    `행 ${ROWS.toLocaleString('ko-KR')}개`,
  );

  console.log(
    `[perf] xlsx ${size} bytes: preview ${previewMs} ms, import ${importMs} ms (budget ${IMPORT_BUDGET_MS} ms)`,
  );
  expect(importMs).toBeLessThanOrEqual(IMPORT_BUDGET_MS);
});
