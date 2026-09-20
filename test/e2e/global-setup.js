// @ts-check
/**
 * E2E가 여는 테스트 빌드(`dist/test/jdrdatabase.html`)를 실행 직전에 항상 다시 만든다.
 *
 * `npm run test:e2e`만 빌드를 하던 때는 `npx playwright test -g …`로 하나만 돌리면 예전 산출물이
 * 열렸다. 그러면 지금 고친 코드가 아니라 마지막으로 빌드된 코드를 검사하게 되어 통과도 실패도
 * 믿을 수 없다(고쳤는데 빨강, 안 고쳤는데 초록). 여기서 만들면 어떻게 실행하든 같다.
 */
import { writeDist } from '../../build/build.mjs';

export default async function globalSetup() {
  await writeDist({ test: true });
}
