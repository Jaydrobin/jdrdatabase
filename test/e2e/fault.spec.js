// @ts-check
/**
 * Step 10 오류 주입 E2E. 실제 산출물(`file://`)에서 브라우저 API를 가짜로 바꿔 실패 경로를 밟는다.
 * - Worker 강제 종료: `Worker` 생성자를 감싸 인스턴스를 잡아 두고, 처리되지 않은 예외와 같은 `error`
 *   이벤트를 보낸 뒤 `terminate()`한다. 앱은 잠기고 저널 상태를 알리며, 새로 고치면 저널 복구가 제안된다.
 * - IndexedDB 열기 실패: `indexedDB` 접근이 던진다. 상태바 안내만 하고 새 테이블·저장(다운로드)은 동작한다.
 * - 파일 쓰기 중 예외: File System Access API를 가짜 핸들로 대체해 `write()`가 던지게 한다. 원본은 그대로,
 *   dirty·저널 유지, 다음 저장이 모든 변경을 담는다.
 * wasm 메모리 한계는 단위 테스트(`engine-wasm.test.js`)가 실측한다(2 GB 채우기는 브라우저 E2E에 맞지 않는다).
 */
import { expect, test } from '@playwright/test';
import { PAGE_URL } from './page-url.js';

/**
 * @typedef {object} TestHook
 * @property {() => { file: { name: string | null, hasHandle: boolean }, meta: Record<string, string>, tables: Array<{ id: string, name: string }>, dirty: boolean, journalStop: string } | null} state
 * @property {() => boolean} idbAvailable
 * @property {() => Promise<{ commands: unknown[] } | null>} journalPending
 * @property {(cmd: unknown) => Promise<{ affected: number }>} apply
 * @property {(sql: string) => Promise<{ columns: string[], rows: unknown[][] }>} query
 */

/** @param {import('@playwright/test').Page} page */
function state(page) {
  return page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.state(),
  );
}

/** @param {import('@playwright/test').Page} page */
async function waitReady(page) {
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
  await expect.poll(async () => (await state(page))?.meta.db_id ?? '').toMatch(/^[0-9a-f-]{36}$/);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function createTable(page, name) {
  await page.click('[data-action="table-create"]');
  await page.locator('.jdr-dialog input').fill(name);
  await page.locator('.jdr-dialog').getByRole('button', { name: '만들기' }).click();
  await expect(page.locator('.jdr-sidebar__table-name', { hasText: name })).toBeVisible();
  await expect.poll(async () => (await state(page))?.dirty).toBe(true);
}

/** Worker 인스턴스를 잡아 두는 초기화 스크립트. 앱 스크립트보다 먼저 실행된다. */
function captureWorkers() {
  const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
  /** @type {Worker[]} */
  const workers = [];
  const Original = /** @type {typeof Worker} */ (w.Worker);
  class CapturedWorker extends Original {
    /**
     * @param {string | URL} url
     * @param {WorkerOptions} [options]
     */
    constructor(url, options) {
      super(url, options);
      workers.push(this);
    }
  }
  w.Worker = CapturedWorker;
  w.__jdrWorkers = workers;
}

/**
 * 잡아 둔 첫 Worker에 처리되지 않은 예외의 `error` 이벤트를 보내고 종료한다.
 * @param {import('@playwright/test').Page} page
 */
async function crashWorker(page) {
  await page.evaluate(() => {
    const w = /** @type {{ __jdrWorkers: Worker[] }} */ (/** @type {unknown} */ (window));
    const worker = w.__jdrWorkers[0];
    if (!worker) throw new Error('worker not captured');
    worker.dispatchEvent(new ErrorEvent('error', { message: 'injected: uncaught in worker' }));
    worker.terminate();
  });
}

test.describe('Worker 강제 종료', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(captureWorkers);
    await page.addInitScript(() => {
      const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
      delete w.showOpenFilePicker;
      delete w.showSaveFilePicker;
    });
    page.on('dialog', (dialog) => void dialog.accept());
    await page.goto(PAGE_URL);
    await waitReady(page);
    await expect(page.locator('.jdr-statusbar__item').nth(1)).toHaveText('Worker 모드');
  });

  test('미저장 변경이 저널에 있으면 앱을 잠그고 복구 절차를 안내하며, 이후 호출은 즉시 거부되고, 새로 고치면 복구된다', async ({
    page,
  }) => {
    await createTable(page, '고객');
    const dbId = (await state(page))?.meta.db_id;
    await crashWorker(page);

    const lock = page.locator('.jdr-lock');
    await expect(lock.locator('.jdr-lock__title')).toHaveText('데이터베이스 엔진이 멈췄습니다');
    await expect(lock.locator('.jdr-lock__message')).toHaveText(
      '저장되지 않은 변경은 이 브라우저의 저널에 남아 있습니다. 페이지를 새로 고친 뒤 같은 파일을 열면 복구를 제안합니다.',
    );
    await expect(lock.locator('.jdr-lock__detail')).toContainText('E_ENV_NO_WORKER');
    await expect(page.locator('.jdr-statusbar__item').first()).toHaveText(
      '데이터베이스 엔진이 멈췄습니다',
    );

    // 죽은 Worker에 보낸 요청은 응답이 없다. client가 즉시 거부하므로 저장은 매달리지 않고 오류로 끝난다.
    const started = Date.now();
    await page.click('[data-action="save"]');
    await expect(page.locator('.jdr-toast--error').last()).toContainText('E_ENV_NO_WORKER');
    expect(Date.now() - started).toBeLessThan(5_000);

    // 새로 고침: 저널 복구 제안 → 복구 → 테이블이 돌아온다. 떠나기 확인은 뜨지 않는다(dialog 핸들러는 보험).
    await page.reload();
    const dialog = page.locator('.jdr-dialog');
    await expect(dialog.locator('.jdr-dialog__title')).toHaveText('저장되지 않은 변경 복구');
    await dialog.getByRole('button', { name: '복구' }).click();
    await expect(page.locator('.jdr-sidebar__table-name', { hasText: '고객' })).toBeVisible();
    const recovered = await state(page);
    expect(recovered?.meta.db_id).toBe(dbId);
    expect(recovered?.dirty).toBe(true);
  });

  test('미저장 변경이 없으면 잃은 것이 없다고 안내한다', async ({ page }) => {
    await crashWorker(page);
    await expect(page.locator('.jdr-lock__message')).toHaveText(
      '저장되지 않은 변경은 없습니다. 페이지를 새로 고쳐 다시 시작하세요.',
    );
    await page.reload();
    await waitReady(page);
    await expect(page.locator('.jdr-dialog')).toHaveCount(0);
  });
});

test('IndexedDB 열기 실패: 상태바에 안내하고 저널·백업 없이 새 테이블과 저장(다운로드)이 동작한다', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      get() {
        throw new Error('injected: indexedDB blocked');
      },
    });
  });
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(PAGE_URL);
  await waitReady(page);
  expect(
    await page.evaluate(() =>
      /** @type {{ __jdrTest: TestHook }} */ (
        /** @type {unknown} */ (window)
      ).__jdrTest.idbAvailable(),
    ),
  ).toBe(false);
  await expect(page.locator('.jdr-statusbar__item--note')).toHaveText(
    'IndexedDB 없음: 저널·백업·최근 파일 꺼짐',
  );

  await createTable(page, '고객');
  const downloadPromise = page.waitForEvent('download');
  await page.click('[data-action="save"]');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('database.db');
  await expect.poll(async () => (await state(page))?.dirty).toBe(false);
  await expect(page.locator('.jdr-toast--info')).toContainText('다운로드했습니다');
  await expect(page.locator('.jdr-toast--error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('파일 쓰기 중 예외: E_FILE_WRITE로 알리고 원본·dirty·저널은 그대로이며, 다음 저장이 모든 변경을 담는다', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    /** 처음 몇 번의 write()를 던지게 한다. 테스트가 `__jdrWriteFailures`를 0으로 내리면 성공한다. */
    w.__jdrWriteFailures = 1;
    /** @type {Uint8Array<ArrayBuffer>[]} */
    const chunks = [];
    w.__jdrWritten = chunks;
    // 메서드는 프로토타입에 두어 구조화 복제(최근 파일 핸들 저장)가 가능한 평범한 객체로 보이게 한다.
    class FakeHandle {
      constructor() {
        this.kind = 'file';
        this.name = 'fake.db';
      }
      async getFile() {
        return new File(chunks, this.name);
      }
      async queryPermission() {
        return 'granted';
      }
      async requestPermission() {
        return 'granted';
      }
      async createWritable() {
        /** @type {Uint8Array<ArrayBuffer>[]} */
        const staged = [];
        return {
          write: async (/** @type {Uint8Array<ArrayBuffer>} */ bytes) => {
            const left = Number(w.__jdrWriteFailures);
            if (left > 0) {
              w.__jdrWriteFailures = left - 1;
              throw new DOMException('injected: disk full', 'QuotaExceededError');
            }
            staged.push(bytes);
          },
          close: async () => {
            chunks.splice(0, chunks.length, ...staged);
          },
          abort: async () => {
            staged.length = 0;
          },
        };
      }
    }
    const handle = new FakeHandle();
    w.showSaveFilePicker = async () => handle;
    w.showOpenFilePicker = async () => {
      throw new DOMException('not in this test', 'AbortError');
    };
  });
  await page.goto(PAGE_URL);
  await waitReady(page);
  await createTable(page, '고객');
  const dbId = (await state(page))?.meta.db_id;

  await page.click('[data-action="save"]');
  const toast = page.locator('.jdr-toast--error').last();
  await expect(toast).toContainText('E_FILE_WRITE');
  await expect(toast).toContainText('기존 파일은 그대로 남아 있습니다');
  const failed = await state(page);
  expect(failed?.dirty).toBe(true);
  expect(failed?.file.name).toBeNull();
  expect(failed?.file.hasHandle).toBe(false);
  expect(failed?.meta.revision).toBe('0');
  const pending = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (
      /** @type {unknown} */ (window)
    ).__jdrTest.journalPending(),
  );
  expect(pending?.commands.length).toBe(1);
  expect(
    await page.evaluate(
      () =>
        /** @type {{ __jdrWritten: Uint8Array[] }} */ (/** @type {unknown} */ (window)).__jdrWritten
          .length,
    ),
  ).toBe(0);

  // 이번에는 쓰기가 성공한다. 정본이 없으므로 다시 저장 위치를 고른다(같은 가짜 핸들).
  await page.evaluate(() => {
    /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window)).__jdrWriteFailures = 0;
  });
  await page.click('[data-action="save"]');
  await expect(page.locator('.jdr-toast--info').last()).toContainText('저장했습니다');
  await expect.poll(async () => (await state(page))?.dirty).toBe(false);
  const saved = await state(page);
  expect(saved?.file.name).toBe('fake.db');
  expect(saved?.file.hasHandle).toBe(true);
  expect(saved?.meta.db_id).toBe(dbId);
  // 실패한 스냅샷이 revision 1을 썼고 성공한 저장이 2를 쓴다(단조 증가).
  expect(saved?.meta.revision).toBe('2');
  const written = await page.evaluate(() =>
    /** @type {{ __jdrWritten: Uint8Array[] }} */ (
      /** @type {unknown} */ (window)
    ).__jdrWritten.map((c) => c.byteLength),
  );
  expect(written.length).toBe(1);
  expect(written[0]).toBeGreaterThan(4096);
  expect(
    await page.evaluate(() =>
      /** @type {{ __jdrTest: TestHook }} */ (
        /** @type {unknown} */ (window)
      ).__jdrTest.journalPending(),
    ),
  ).toBeNull();
  await expect(page.locator('.jdr-toast--error')).toHaveCount(1);
});
