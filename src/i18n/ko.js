// @ts-check
/**
 * 한국어 UI 문자열(D-14). 코드에서는 이 키를 `t()`로만 쓴다.
 * 키 형식: `<영역>.<이름>`. 오류 문구는 `error.<코드>`이며 util/errors.js의 코드 목록과 1:1이다.
 */
export const ko = Object.freeze({
  'app.title': 'jdrdatabase',
  'app.subtitle': '서버 없이 브라우저에서 동작하는 SQLite 데이터베이스 관리 앱',
  'app.version': '버전 {version}',
  'status.booting': '시작 중…',
  'status.ready': '준비됨',
  'status.mode.worker': 'Worker 모드',
  'status.mode.inline': '단일 스레드 모드',
  'status.engine': 'SQLite {version}',
  'lock.title': '앱을 시작할 수 없습니다',
  'lock.supportedBrowsers':
    '지원 브라우저: Chrome·Edge 최신 2개 버전(권장), Firefox·Safari 최신 버전. WebAssembly가 켜져 있어야 합니다.',
  'lock.cause': '원인: {message}',
  'error.E_ENV_NO_WASM': 'WebAssembly를 사용할 수 없어 데이터베이스 엔진을 시작하지 못했습니다.',
  'error.E_ENV_NO_WORKER':
    'Worker를 만들 수 없어 단일 스레드 모드로 실행합니다. 큰 작업 중에는 화면이 잠시 멈출 수 있습니다.',
  'error.E_ENV_NO_IDB': 'IndexedDB를 사용할 수 없어 저널·백업·최근 파일 기능이 꺼집니다.',
  'error.E_FILE_NOT_SQLITE': 'SQLite 데이터베이스 파일이 아닙니다. 파일은 변경되지 않았습니다.',
  'error.E_FILE_CORRUPT':
    '데이터베이스 파일이 손상되었습니다. 파일은 변경되지 않았습니다. sqlite3의 .recover 명령으로 복구를 시도할 수 있습니다.',
  'error.E_FILE_TOO_LARGE':
    '파일이 이 실행 환경의 크기 상한을 넘어 열 수 없습니다. 파일은 변경되지 않았습니다.',
  'error.E_FILE_NEWER_SCHEMA':
    '이 파일은 더 새로운 버전의 앱으로 저장되었습니다. 읽기 전용으로 엽니다.',
  'error.E_FILE_PERMISSION': '파일에 쓸 권한이 없습니다. 다른 이름으로 저장하세요.',
  'error.E_FILE_WRITE':
    '파일 쓰기에 실패했습니다. 기존 파일은 그대로 남아 있습니다. 다시 시도하거나 다운로드로 저장하세요.',
  'error.E_REVISION_BEHIND':
    '이 기기에서 더 나중 버전을 저장한 적이 있습니다. 클라우드 동기화가 끝나지 않은 파일일 수 있습니다.',
  'error.E_DB_QUERY': '데이터베이스 작업이 실패했습니다.',
  'error.E_DB_BUSY': '다른 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.',
  'error.E_RESULT_TOO_LARGE': '내부 오류: 질의 결과가 너무 큽니다(1만 행 초과).',
  'error.E_BATCH_TOO_LARGE': '내부 오류: 한 번에 보내는 배치가 너무 큽니다.',
  'error.E_MEM': '메모리가 부족합니다. 작업을 중단했습니다. 저장한 뒤 앱을 다시 시작하세요.',
  'error.E_NAME_INVALID': '이름이 비어 있거나 이미 사용 중입니다.',
  'error.E_SYSTEM_COLUMN': '시스템 열은 변경할 수 없습니다.',
  'error.E_VALUE_INVALID': '이 열의 타입에 맞지 않는 값입니다.',
  'error.E_PASTE_TOO_LARGE':
    '붙여넣을 셀이 너무 많습니다(100만 셀 초과). CSV 가져오기를 사용하세요.',
  'error.E_UNDO_LIMIT':
    '이 작업은 되돌리기 한도를 넘어 되돌릴 수 없습니다. 계속하면 되돌리기 기록이 비워집니다.',
  'error.E_IMPORT_ENCODING': '깨진 문자가 너무 많습니다. 인코딩을 다시 선택하세요.',
  'error.E_IMPORT_CANCELLED': '가져오기를 취소했습니다. 변경 사항은 모두 되돌렸습니다.',
  'error.E_XLSX_ENCRYPTED': '암호가 걸린 XLSX 파일은 열 수 없습니다.',
  'error.E_XLSX_CORRUPT': 'XLSX 파일을 읽을 수 없습니다.',
  'error.E_GZIP_UNSUPPORTED': '이 브라우저는 압축 저장을 지원하지 않습니다. 비압축으로 저장하세요.',
  'error.E_QUOTA': '브라우저 저장 공간이 부족해 백업·저널을 생략합니다.',
  'error.E_UNSUPPORTED': '내부 오류: 현재 엔진이 지원하지 않는 작업입니다.',
  'error.E_NATIVE_IPC': '데스크톱 엔진과의 통신에 실패했습니다. 앱을 다시 시작하세요.',
  'error.E_DISK_FULL':
    '디스크 공간이 부족합니다. 원본 파일은 변경되지 않았습니다. 공간을 확보한 뒤 다시 시도하세요.',
  'error.E_FILE_LOCKED':
    '원본 파일을 교체할 수 없습니다(잠금 또는 권한). 원본은 그대로이며 다른 이름으로 저장할 수 있습니다.',
  'error.E_ORIGINAL_CHANGED': '파일을 연 뒤 디스크의 원본이 바뀌었습니다.',
  'error.E_UNKNOWN': '예상하지 못한 오류가 발생했습니다. 저장한 뒤 앱을 다시 시작하세요.',
});
