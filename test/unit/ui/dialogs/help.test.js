// @ts-check
/**
 * 도움말 대화상자(Step 14)의 순수 부분: 주제 목록, 저장 주제의 모드별 본문 키, 문단 나누기.
 * 대화상자 자체(탭 이동, Esc, 포커스 복귀)는 E2E `help.spec.js`가 본다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bodyKey, HELP_TOPICS, paragraphs } from '../../../../src/ui/dialogs/help.js';
import { t } from '../../../../src/i18n/index.js';

test('주제는 D-19의 열한 개이고 순서가 정해져 있다', () => {
  assert.deepEqual(
    [...HELP_TOPICS],
    [
      'basics',
      'types',
      'columns',
      'sortFilter',
      'search',
      'views',
      'importExport',
      'saving',
      'multiPc',
      'appData',
      'shortcuts',
    ],
  );
});

test('bodyKey: 저장 주제만 저장 방식(persistence)에 따라 본문이 다르다', () => {
  assert.equal(bodyKey('saving', 'snapshot'), 'help.saving.body');
  assert.equal(bodyKey('saving', 'native'), 'help.saving.bodyNative');
  assert.equal(bodyKey('search', 'native'), 'help.search.body');
  assert.match(t(bodyKey('saving', 'snapshot')), /저널/);
  assert.match(t(bodyKey('saving', 'native')), /작업 사본/);
  assert.match(t(bodyKey('saving', 'native')), /\.bak/);
});

test('paragraphs: 빈 줄로 나누고 앞뒤 공백과 빈 문단을 버린다', () => {
  assert.deepEqual(paragraphs('첫 문단\n\n둘째 문단\n이어지는 줄\n\n\n  \n셋째 '), [
    '첫 문단',
    '둘째 문단\n이어지는 줄',
    '셋째',
  ]);
  assert.deepEqual(paragraphs(''), []);
  for (const topic of HELP_TOPICS) {
    assert.ok(paragraphs(t(bodyKey(topic, 'snapshot'))).length >= 1, topic);
  }
});
