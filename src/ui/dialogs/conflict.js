// @ts-check
/**
 * 파일 열기·저장 흐름의 확인 대화상자(Step 2): 미저장 변경, 외부 SQLite 파일 등록, 큰 파일, revision 경고, 저널 복구.
 * `app/store.js`의 `Prompts` 인터페이스 구현이다.
 */
import { t } from '../../i18n/index.js';
import { formatBytes } from '../../util/bytes.js';
import { confirmDialog, openDialog } from './dialog.js';

/** @typedef {import('../../app/store.js').Prompts} Prompts */

/**
 * @returns {Prompts}
 */
export function createPrompts() {
  return {
    discardUnsaved: () =>
      confirmDialog({
        title: t('confirm.discard.title'),
        message: t('confirm.discard.message'),
        okLabel: t('confirm.discard.ok'),
        danger: true,
      }),

    adoptExternal: () =>
      confirmDialog({
        title: t('confirm.adopt.title'),
        message: t('confirm.adopt.message'),
        okLabel: t('confirm.adopt.ok'),
      }),

    largeFile: ({ size, warn }) =>
      confirmDialog({
        title: t('confirm.largeFile.title'),
        message: t('confirm.largeFile.message', {
          size: formatBytes(size),
          limit: formatBytes(warn),
        }),
        okLabel: t('confirm.largeFile.ok'),
      }),

    revisionBehind: ({ fileRevision, knownRevision }) =>
      confirmDialog({
        title: t('confirm.revisionBehind.title'),
        message: t('confirm.revisionBehind.message', { file: fileRevision, known: knownRevision }),
        okLabel: t('confirm.revisionBehind.ok'),
      }),

    async journalRecover({ count, truncated, isNew }) {
      const lines = [
        t(isNew ? 'confirm.newJournal.message' : 'confirm.journal.message', { count }),
      ];
      if (truncated) lines.push(t('confirm.journal.truncated'));
      const value = await openDialog({
        title: t('confirm.journal.title'),
        message: lines.join('\n'),
        buttons: [
          { label: t('confirm.journal.discard'), value: 'discard', danger: true },
          { label: t('confirm.journal.recover'), value: 'recover', primary: true },
        ],
        cancelValue: 'recover',
      });
      return value === 'discard' ? 'discard' : 'recover';
    },

    async journalMismatch({ count, baseRevision, fileRevision }) {
      const value = await openDialog({
        title: t('confirm.journalMismatch.title'),
        message: t('confirm.journalMismatch.message', {
          count,
          base: baseRevision,
          file: fileRevision,
        }),
        buttons: [
          { label: t('confirm.journalMismatch.discard'), value: 'discard', danger: true },
          { label: t('confirm.journalMismatch.export'), value: 'export', primary: true },
        ],
        cancelValue: 'export',
      });
      return value === 'discard' ? 'discard' : 'export';
    },
  };
}
