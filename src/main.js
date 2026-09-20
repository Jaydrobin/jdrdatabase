// @ts-check
/**
 * 부트스트랩(3.1). Step 0에서는 초기 화면과 상태바만 그린다.
 * Step 1에서 기능 감지, 모드 판정, Worker 기동이 추가된다.
 */
import { t } from './i18n/index.js';

/**
 * 정적 마크업을 만들고 문구는 textContent로 넣는다(CLAUDE.md 5.5).
 * @param {HTMLElement} root
 * @returns {{ status: HTMLElement }}
 */
function mount(root) {
  root.textContent = '';

  const main = document.createElement('main');
  main.className = 'jdr-app__main';

  const title = document.createElement('h1');
  title.className = 'jdr-app__title';
  title.textContent = t('app.title');

  const subtitle = document.createElement('p');
  subtitle.className = 'jdr-app__subtitle';
  subtitle.textContent = t('app.subtitle');

  main.append(title, subtitle);

  const statusbar = document.createElement('footer');
  statusbar.className = 'jdr-statusbar';
  const status = document.createElement('span');
  status.className = 'jdr-statusbar__item';
  status.textContent = t('status.booting');
  const version = document.createElement('span');
  version.className = 'jdr-statusbar__item';
  version.textContent = t('app.version', { version: __JDR_VERSION__ });
  statusbar.append(status, version);

  root.append(main, statusbar);
  return { status };
}

function boot() {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app 루트 요소가 없습니다.');
  document.title = t('app.title');
  const { status } = mount(root);
  status.textContent = t('status.ready');

  if (__JDR_TEST__) {
    // 테스트 빌드 전용 훅(CLAUDE.md 6장). 릴리스 빌드에서는 define으로 제거된다.
    Object.defineProperty(window, '__jdrTest', {
      value: Object.freeze({ version: __JDR_VERSION__ }),
      configurable: false,
      writable: false,
    });
  }
}

boot();
