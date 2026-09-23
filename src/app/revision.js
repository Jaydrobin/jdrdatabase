// @ts-check
/**
 * revision 판정표(DESIGN.md 4.3, D-10)의 순수 함수. 파일을 열 때 한 번 호출한다.
 */

/**
 * @typedef {object} RevisionInput
 * @property {number} fileRevision 파일의 `_jdr_meta.revision`
 * @property {number | undefined} knownRevision 이 기기의 `known_revisions[db_id]`. 없으면 undefined
 * @property {number | undefined} journalBaseRevision 저널에 남은 이 `db_id`의 `base_revision`. 저널이 없으면 undefined
 */

/**
 * @typedef {object} RevisionVerdict
 * @property {'first' | 'ok' | 'behind'} file first: 이 기기에서 처음 / ok: 정상(known 갱신) / behind: 이 기기가 더 나중 버전을 저장한 적 있음(경고)
 * @property {'none' | 'match' | 'mismatch'} journal none: 저널 없음 / match: 같은 revision 위의 미저장 변경(복구·버리기) / mismatch: 다른 버전 위의 변경(버리기·내보내기)
 * @property {boolean} updateKnown `known_revisions[db_id]`를 파일 revision으로 갱신해도 되는가
 */

/**
 * @param {RevisionInput} input
 * @returns {RevisionVerdict}
 */
export function judge(input) {
  const { fileRevision, knownRevision, journalBaseRevision } = input;
  /** @type {RevisionVerdict['file']} */
  let file;
  if (knownRevision === undefined) file = 'first';
  else if (fileRevision >= knownRevision) file = 'ok';
  else file = 'behind';

  /** @type {RevisionVerdict['journal']} */
  let journal;
  if (journalBaseRevision === undefined) journal = 'none';
  else if (journalBaseRevision === fileRevision) journal = 'match';
  else journal = 'mismatch';

  return { file, journal, updateKnown: file !== 'behind' };
}
