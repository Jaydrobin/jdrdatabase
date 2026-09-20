// @ts-check
/**
 * 테스트 빌드를 만들고, 30만 행 DB 픽스처가 없으면 생성한다(커밋하지 않는 test/fixtures/generated/).
 * `JDR_PERF_ROWS`로 행 수를 바꿀 수 있다(기본 300,000).
 */
import { stat } from 'node:fs/promises';
import { writeDist } from '../../build/build.mjs';
import { generateDb } from '../../scripts/gen-fixture.mjs';
import { FIXTURE_PATH, FIXTURE_ROWS } from './fixture.js';

export default async function globalSetup() {
  await writeDist({ test: true });
  const exists = await stat(FIXTURE_PATH).then(
    (s) => s.isFile() && s.size > 0,
    () => false,
  );
  if (exists) return;
  console.log(`generating ${FIXTURE_ROWS} rows -> ${FIXTURE_PATH}`);
  const started = Date.now();
  const { bytes } = await generateDb({ rows: FIXTURE_ROWS, cols: 20, long: 2, out: FIXTURE_PATH });
  console.log(`generated ${bytes} bytes in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
