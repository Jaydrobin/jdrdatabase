// @ts-check
import { open } from 'node:fs/promises';
import path from 'node:path';

/** 성능 픽스처 행 수. `JDR_PERF_ROWS`로 줄여 빠르게 돌릴 수 있다(예산 판정은 30만 행에서만 의미가 있다). */
export const FIXTURE_ROWS = Number(process.env.JDR_PERF_ROWS ?? 300_000);
export const FIXTURE_PATH = path.resolve(`test/fixtures/generated/bench-${FIXTURE_ROWS}.db`);

/**
 * 픽스처를 한 번 끝까지 읽어 OS 페이지 캐시에 올린다. 8장의 열기·가져오기 시간은 앱의 처리 시간을 재는 것이지
 * 러너 디스크의 첫 읽기(actions/cache 복원 직후 300 MB가 콜드일 때 900 ms → 1,927 ms, 세션 H 실측)를 재는
 * 것이 아니다. 내용은 버린다.
 * @param {string} file
 */
export async function warmCache(file) {
  const handle = await open(file, 'r');
  try {
    const chunk = new Uint8Array(4 * 1024 * 1024);
    let read = 0;
    do {
      ({ bytesRead: read } = await handle.read(chunk, 0, chunk.byteLength, null));
    } while (read > 0);
  } finally {
    await handle.close();
  }
}
