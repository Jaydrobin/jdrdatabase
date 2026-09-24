// @ts-check
/**
 * Step 14 툴팁·도움말(D-19).
 * - 툴팁: 마우스 호버 500 ms 뒤 표시, 키보드 Tab 포커스로 즉시 표시, Esc로 숨김, `aria-describedby` 연결,
 *   툴팁 위로 포인터를 옮겨도 유지(WCAG 1.4.13), 누르면 닫힘, 대상이 DOM에서 사라지면 숨김, 터치에는 없음,
 *   비활성 버튼(Chromium은 포인터 이벤트를 낸다).
 * - 도움말: 버튼·F1로 열기, 모든 주제 표시(↑↓ 탭 이동), 저장 주제는 브라우저 모드 문구, 단축키 주제는
 *   `SHORTCUTS` 표에서 그림, Esc로 닫고 포커스가 도움말 버튼으로 돌아옴.
 */
import { expect, test } from '@playwright/test';
import { PAGE_URL } from './page-url.js';
import { createTableWith } from './schema-ui.js';

/** 툴팁 요소(문서에 하나). */
const TOOLTIP = '#jdr-tooltip';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 720 });
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
});

/**
 * 요소의 가운데로 포인터를 옮기고 그 시각(ms)을 돌려준다.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} target
 */
async function pointTo(page, target) {
  const box = await target.boundingBox();
  if (!box) throw new Error('no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return Date.now();
}

test('툴팁: 호버 500 ms 뒤 표시와 aria-describedby, 툴팁 위로 옮겨도 유지, 벗어나면 숨김, 누르면 닫힘', async ({
  page,
}) => {
  const tooltip = page.locator(TOOLTIP);
  const save = page.locator('[data-action="save"]');
  await expect(tooltip).toHaveAttribute('role', 'tooltip');
  await expect(tooltip).toBeHidden();

  const start = await pointTo(page, save);
  // 500 ms 전에는 보이지 않는다.
  await page.waitForTimeout(250);
  await expect(tooltip).toBeHidden();
  await expect(tooltip).toHaveText('');
  await expect(tooltip).toBeVisible();
  expect(Date.now() - start).toBeGreaterThanOrEqual(500);
  await expect(tooltip).toHaveText('지금 파일에 저장합니다. (Ctrl+S)');
  await expect(save).toHaveAttribute('aria-describedby', 'jdr-tooltip');
  // 포인터 이벤트를 받지 않아 아래의 요소를 가리지 않는다.
  expect(await tooltip.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

  // 툴팁 위로 옮겨도 닫히지 않는다(가리킬 수 있음).
  const tip = await tooltip.boundingBox();
  if (!tip) throw new Error('no tooltip box');
  await page.mouse.move(tip.x + tip.width / 2, tip.y + tip.height / 2, { steps: 5 });
  await page.waitForTimeout(100);
  await expect(tooltip).toBeVisible();

  // 대상·툴팁 밖으로 나가면 닫히고 aria-describedby를 뗀다. 숨긴 툴팁은 문구를 비운다.
  await page.mouse.move(700, 600);
  await expect(tooltip).toBeHidden();
  await expect(tooltip).toHaveText('');
  await expect(save).not.toHaveAttribute('aria-describedby', /./);

  // 누르면 닫고, 포인터가 떠나기 전에는 다시 뜨지 않는다.
  const open = page.locator('[data-action="new"]');
  await pointTo(page, open);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(/빈 데이터베이스를 새로 만듭니다/);
  await page.mouse.down();
  await expect(tooltip).toBeHidden();
  await page.mouse.up();
  await page.waitForTimeout(700);
  await expect(tooltip).toBeHidden();
});

test('툴팁: 키보드 Tab 포커스로 즉시 표시, Esc로 숨김, 다음 버튼으로 옮기면 그 설명', async ({
  page,
}) => {
  const tooltip = page.locator(TOOLTIP);
  const open = page.locator('[data-action="open"]');
  await page.locator('[data-action="new"]').focus();
  await page.keyboard.press('Tab');
  await expect(open).toBeFocused();
  // 즉시: 호버 지연(500 ms)보다 짧은 제한 안에 보인다.
  await expect(tooltip).toBeVisible({ timeout: 300 });
  await expect(tooltip).toHaveText('컴퓨터에 있는 데이터베이스 파일(.db, .db.gz)을 엽니다.');
  await expect(open).toHaveAttribute('aria-describedby', 'jdr-tooltip');

  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await expect(open).not.toHaveAttribute('aria-describedby', /./);
  await expect(open).toBeFocused();

  await page.keyboard.press('Tab');
  const next = page.locator(':focus');
  const hint = await next.getAttribute('data-hint');
  expect(hint).toMatch(/^hint\./);
  await expect(tooltip).toBeVisible({ timeout: 300 });
  await expect(next).toHaveAttribute('aria-describedby', 'jdr-tooltip');

  // 마우스 클릭으로 준 포커스(`:focus-visible` 아님)에는 뜨지 않는다.
  await page.mouse.move(700, 600);
  await page.locator('[data-action="settings"]').click();
  await expect(page.locator('.jdr-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.jdr-dialog')).toHaveCount(0);
});

test('툴팁: 대상이 DOM에서 사라지면 숨김, 터치 포인터에는 없음, 비활성 버튼에도 보임(Chromium), 머리글 버튼', async ({
  page,
}) => {
  const tooltip = page.locator(TOOLTIP);
  await createTableWith(page, '표', [{ name: '이름', type: 'text' }]);

  // 사이드바의 테이블 이름 바꾸기 버튼 위에 툴팁을 띄운 채 그 요소를 지운다.
  const rename = page.locator('[data-action="table-rename"]').first();
  await pointTo(page, rename);
  await expect(tooltip).toHaveText('테이블 이름을 바꿉니다.');
  await rename.evaluate((el) => el.remove());
  await expect(tooltip).toBeHidden();

  // 터치 포인터(pointerType touch)의 pointerover에는 띄우지 않는다.
  await page.mouse.move(700, 600);
  await page.locator('[data-action="export"]').evaluate((el) => {
    el.dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch', isPrimary: true }),
    );
  });
  await page.waitForTimeout(700);
  await expect(tooltip).toBeHidden();

  // 비활성 버튼: Chromium은 disabled 버튼에도 pointerover를 내므로 툴팁이 보인다(docs/support-matrix.md).
  // 고른 뷰가 없으면 "뷰 삭제"가 꺼져 있다.
  const viewDelete = page.locator('[data-action="view-delete"]');
  await expect(viewDelete).toBeDisabled();
  await pointTo(page, viewDelete);
  await expect(tooltip).toHaveText('고른 뷰를 지웁니다. 데이터는 그대로입니다.');

  // 머리글의 정렬·메뉴 버튼(data-action 없음, hint.header-*).
  await page.mouse.move(700, 600);
  const sortButton = page.locator('.jdr-grid__hbtn--sort').first();
  await pointTo(page, sortButton);
  await expect(tooltip).toHaveText(/이 열로 정렬합니다/);
  await page.mouse.move(700, 600);
  await pointTo(page, page.locator('.jdr-grid__hbtn--menu').first());
  await expect(tooltip).toHaveText(/메뉴를 엽니다/);

  // 그리드 스크롤은 위치가 어긋나므로 닫는다.
  await page.locator('.jdr-grid__scroller').evaluate((el) => {
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(tooltip).toBeHidden();
});

test('모든 data-action 버튼과 선택 상자가 data-hint를 가진다(기본 화면·테이블·설정)', async ({
  page,
}) => {
  await createTableWith(page, '표', [{ name: '이름', type: 'text' }]);
  /** @param {string} where */
  const check = async (where) => {
    const missing = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button[data-action], select[data-action]'))
        .filter((el) => !/^hint\.[a-z0-9-]+$/.test(el.getAttribute('data-hint') ?? ''))
        .map((el) => el.getAttribute('data-action')),
    );
    expect(missing, where).toEqual([]);
  };
  await check('기본 화면');
  await expect(page.locator('.jdr-grid__frozen-select')).toHaveAttribute(
    'data-hint',
    'hint.frozen-select',
  );
  await page.click('[data-action="settings"]');
  await expect(page.locator('.jdr-dialog')).toBeVisible();
  await check('설정');
  await page.keyboard.press('Escape');
  await page.click('[data-action="filter"]');
  await page.click('[data-action="add"]');
  await check('필터');
  await page.keyboard.press('Escape');
});

test('도움말: 버튼으로 열기 → 모든 주제(↑↓·Home·End) → 저장 주제는 브라우저 문구 → Esc로 닫고 포커스 복귀, F1', async ({
  page,
}) => {
  const helpButton = page.locator('[data-action="help-open"]');
  await expect(helpButton).toHaveText('도움말');
  await helpButton.click();
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('도움말');
  const tabs = dialog.getByRole('tab');
  const panel = dialog.getByRole('tabpanel');
  const titles = [
    '테이블·열·빈 행',
    '열 타입',
    '열 숨기기·삭제·정리',
    '정렬·필터',
    '검색과 검색 인덱스',
    '뷰',
    '가져오기·내보내기',
    '저장과 복구',
    '여러 PC에서 쓰기',
    '이 기기에 남는 데이터',
    '단축키',
  ];
  await expect(tabs).toHaveText(titles);
  // 열리면 고른 탭(첫 주제)이 포커스를 받고, 그 탭만 탭 정지다.
  await expect(tabs.first()).toBeFocused();
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

  // ↓로 주제를 차례로 보인다. 모든 주제가 제목과 본문 문단을 가진다.
  for (const [i, title] of titles.entries()) {
    if (i > 0) await page.keyboard.press('ArrowDown');
    await expect(tabs.nth(i)).toBeFocused();
    await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('.jdr-help__heading')).toHaveText(title);
    expect(await panel.locator('.jdr-help__paragraph').count(), title).toBeGreaterThan(0);
    await expect(panel).toHaveAttribute(
      'aria-labelledby',
      (await tabs.nth(i).getAttribute('id')) ?? '',
    );
  }
  // 단축키 주제는 SHORTCUTS 표에서 그린다: 같은 행동의 조합은 한 줄(다시 실행: Ctrl+Shift+Z / Ctrl+Y).
  const keyRows = panel.locator('.jdr-help__keys tbody tr');
  await expect(keyRows.filter({ hasText: '다시 실행' }).locator('kbd')).toHaveText([
    'Ctrl+Shift+Z',
    'Ctrl+Y',
  ]);
  await expect(keyRows.filter({ hasText: '도움말 열기' }).locator('kbd')).toHaveText(['F1']);
  await expect(keyRows.filter({ hasText: '열 메뉴' }).locator('kbd')).toHaveText([
    'Shift+F10',
    'Menu',
  ]);
  expect(await keyRows.count()).toBe(13);

  await page.keyboard.press('Home');
  await expect(panel.locator('.jdr-help__heading')).toHaveText('테이블·열·빈 행');
  await page.keyboard.press('ArrowUp');
  await expect(panel.locator('.jdr-help__heading')).toHaveText('단축키');
  await page.keyboard.press('End');
  await expect(panel.locator('.jdr-help__heading')).toHaveText('단축키');

  // 저장 주제는 브라우저 모드(snapshot) 문구다.
  await tabs.filter({ hasText: '저장과 복구' }).click();
  await expect(panel).toContainText('저널');
  await expect(panel).toContainText('200 MB');
  await expect(panel).not.toContainText('작업 사본');

  // Esc로 닫고 포커스는 도움말 버튼으로 돌아간다.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(helpButton).toBeFocused();

  // F1도 도움말을 연다(Chromium은 F1 keydown을 문서에 준다).
  await page.locator('.jdr-app__main').click();
  await page.keyboard.press('F1');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('도움말');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

/**
 * F1 keydown마다 모든 처리기가 돈 뒤의 `defaultPrevented`를 모은다. 편집기가 전파를 막아도 보이도록
 * window 캡처에서 이벤트를 잡고 다음 태스크에서 읽는다.
 * @param {import('@playwright/test').Page} page
 */
async function watchF1(page) {
  await page.evaluate(() => {
    const w = /** @type {{ __f1: boolean[] }} */ (/** @type {unknown} */ (window));
    w.__f1 = [];
    window.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key === 'F1') setTimeout(() => w.__f1.push(ev.defaultPrevented), 0);
      },
      true,
    );
  });
  return async () => {
    await page.waitForTimeout(50);
    return page.evaluate(() => {
      const w = /** @type {{ __f1: boolean[] }} */ (/** @type {unknown} */ (window));
      const seen = w.__f1;
      w.__f1 = [];
      return seen;
    });
  };
}

test('F1: 대화상자가 떠 있어도 브라우저 기본 동작을 막고, 셀 편집 중에는 도움말을 연 뒤 편집을 잇는다', async ({
  page,
}) => {
  await createTableWith(page, '표', [{ name: '이름', type: 'text' }]);
  const takeF1 = await watchF1(page);
  const dialog = page.locator('.jdr-dialog');
  const title = dialog.locator('.jdr-dialog__title');

  // 대화상자가 없으면 도움말을 연다.
  await page.locator('.jdr-grid__scroller').focus();
  await page.keyboard.press('F1');
  await expect(title).toHaveText('도움말');
  expect(await takeF1()).toEqual([true]);
  // 도움말이 떠 있는 동안의 F1: 두 번째 도움말은 열지 않지만 브라우저의 도움말 탭도 열지 않는다.
  await page.keyboard.press('F1');
  await expect(dialog).toHaveCount(1);
  expect(await takeF1()).toEqual([true]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // 다른 대화상자(설정)가 떠 있으면 도움말을 열지 않고 기본 동작만 막는다.
  await page.click('[data-action="settings"]');
  await expect(title).toHaveText('설정');
  await page.keyboard.press('F1');
  await expect(title).toHaveText('설정');
  await expect(dialog).toHaveCount(1);
  expect(await takeF1()).toEqual([true]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // 셀 편집 중: 도움말이 열리고, 닫으면 편집기로 돌아와 입력하던 값이 그대로다. Enter로 확정된다.
  const cell = page.locator('.jdr-grid__row[data-row="0"] .jdr-grid__cell[data-col="0"]');
  await cell.click();
  await page.mouse.move(700, 700);
  await page.keyboard.type('abc');
  const input = page.locator('.jdr-editor input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('abc');
  await page.keyboard.press('F1');
  await expect(title).toHaveText('도움말');
  expect(await takeF1()).toEqual([true]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('abc');
  await page.keyboard.type('d');
  await page.keyboard.press('Enter');
  await expect(page.locator('.jdr-editor')).toBeHidden();
  await expect(cell).toHaveText('abcd');

  // 머리글 이름 편집기에서도 같다(편집은 도움말을 닫으면 이어진다).
  await page.click('[data-action="column-add"]');
  const rename = page.locator('.jdr-grid__hrename');
  await expect(rename).toBeFocused();
  await rename.fill('새이름');
  await page.keyboard.press('F1');
  await expect(title).toHaveText('도움말');
  expect(await takeF1()).toEqual([true]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(rename).toBeFocused();
  await expect(rename).toHaveValue('새이름');
  await page.keyboard.press('Enter');
  await expect(rename).toHaveCount(0);
  await expect(page.locator('.jdr-grid__hname', { hasText: /^새이름$/ })).toHaveCount(1);
});

test('툴팁: 누른 뒤 다시 그려진 대상(머리글 정렬, 사이드바 숨기기)에는 포인터가 떠날 때까지 다시 뜨지 않는다', async ({
  page,
}) => {
  const tooltip = page.locator(TOOLTIP);
  await createTableWith(page, '표', [
    { name: '가', type: 'text' },
    { name: '나', type: 'text' },
  ]);
  for (const selector of [
    '.jdr-grid__hcell[data-col="0"] .jdr-grid__hbtn--sort',
    '.jdr-sidebar [data-action="column-visibility"] >> nth=1',
  ]) {
    await page.mouse.move(700, 700);
    await expect(tooltip).toBeHidden();
    const target = page.locator(selector);
    await pointTo(page, target);
    await expect(tooltip).toBeVisible();
    // 지금의 버튼들에 표시를 해 두고, 누른 뒤 대상이 새 노드로 바뀌었는지(재현 조건) 확인한다.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('button')) el.dataset.old = '1';
    });
    await page.mouse.down();
    await expect(tooltip).toBeHidden();
    await page.mouse.up();
    await expect(page.locator(selector)).not.toHaveAttribute('data-old', '1');
    await page.waitForTimeout(900);
    await expect(tooltip).toBeHidden();
    // 떠났다 돌아오면 다시 뜬다.
    await page.mouse.move(700, 700);
    await pointTo(page, page.locator(selector));
    await expect(tooltip).toBeVisible();
  }
});

test('툴팁: Tab 포커스가 일으킨 스크롤 뒤에도 키보드 툴팁이 대상 옆에 남고, 대상이 영역 밖으로 나가면 닫힌다', async ({
  page,
}) => {
  const tooltip = page.locator(TOOLTIP);
  // "+ 테이블"은 기본 열 30개를 만든다. 사이드바 열 목록이 넘쳐 아래쪽 버튼은 스크롤해야 보인다.
  await page.click('[data-action="table-create"]');
  await page.keyboard.press('Enter');
  await expect(page.locator('.jdr-dialog')).toHaveCount(0);
  await page.mouse.move(700, 700);
  const sidebar = page.locator('.jdr-sidebar');
  await expect(sidebar).toHaveJSProperty('scrollTop', 0);
  const last = page.locator('.jdr-sidebar [data-action="column-visibility"]').last();
  // 키보드로 포커스를 옮긴 상태에서(:focus-visible) 마지막 열의 버튼으로 간다. focus()는 대상을 화면 안으로 굴린다.
  await page.locator('[data-action="table-create"]').focus();
  await page.keyboard.press('Tab');
  await last.focus();
  expect(await sidebar.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.waitForTimeout(200);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(/숨기거나 다시 보입니다/);
  await expect(last).toHaveAttribute('aria-describedby', 'jdr-tooltip');
  // 위치는 스크롤 뒤의 대상 바로 아래(또는 위)다.
  const target = await last.boundingBox();
  const tip = await tooltip.boundingBox();
  if (!target || !tip) throw new Error('no box');
  const below = Math.abs(tip.y - (target.y + target.height + 6)) <= 2;
  const above = Math.abs(tip.y + tip.height - (target.y - 6)) <= 2;
  expect(below || above).toBe(true);

  // 사이드바를 맨 위로 굴려 대상이 보이는 영역 밖으로 나가면 닫는다.
  await sidebar.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(tooltip).toBeHidden();
  await expect(last).not.toHaveAttribute('aria-describedby', /./);
});

test('툴팁: 포인터를 둔 채 단축키로 모달을 열면 배경 버튼의 툴팁을 닫는다', async ({ page }) => {
  const tooltip = page.locator(TOOLTIP);
  const settings = page.locator('[data-action="settings"]');
  await pointTo(page, settings);
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('F1');
  await expect(page.locator('.jdr-dialog__title')).toHaveText('도움말');
  await expect(tooltip).toBeHidden();
  await expect(settings).not.toHaveAttribute('aria-describedby', /./);
  await page.keyboard.press('Escape');
  await expect(page.locator('.jdr-dialog')).toHaveCount(0);
});

test('툴팁: 대화상자 안에서 첫 Esc는 툴팁만 닫고, 다음 Esc가 대화상자를 닫으며 돌아간 버튼에는 다시 뜨지 않는다', async ({
  page,
}) => {
  const tooltip = page.locator(TOOLTIP);
  const dialog = page.locator('.jdr-dialog');
  // 설정 버튼은 대화상자가 떠 있는 동안 꺼져 포커스를 잃으므로, 여는 버튼이 켜진 채인 필터 대화상자로 본다.
  await createTableWith(page, '표', [{ name: '이름', type: 'text' }]);
  const opener = page.locator('[data-action="filter"]');
  await opener.click();
  await expect(dialog).toBeVisible();
  await page.mouse.move(5, 700);
  // 툴팁이 있는 버튼까지 Tab으로 간다.
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press('Tab');
    const hinted = await page.evaluate(
      () => document.activeElement instanceof HTMLElement && !!document.activeElement.dataset.hint,
    );
    if (hinted) break;
  }
  const focused = page.locator(':focus');
  await expect(focused).toHaveAttribute('data-hint', /^hint\./);
  const hint = (await focused.getAttribute('data-hint')) ?? '';
  await expect(tooltip).toBeVisible();

  // 조합 중의 Esc는 입력기의 것: 툴팁도 대화상자도 그대로다.
  await focused.evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(tooltip).toBeVisible();
  await expect(dialog).toBeVisible();

  // 첫 Esc: 툴팁만 닫는다. 대화상자와 포커스는 그대로다.
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(focused).toHaveAttribute('data-hint', hint);
  // 다음 Esc: 대화상자를 닫고 포커스는 여는 버튼으로 돌아간다. 그 버튼의 툴팁은 다시 띄우지 않는다.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.waitForTimeout(300);
  await expect(tooltip).toBeHidden();
  // 포커스가 떠났다 돌아오면(키보드) 다시 뜬다.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(opener).toBeFocused();
  await expect(tooltip).toBeVisible();
});
