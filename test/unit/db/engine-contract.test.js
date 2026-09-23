// @ts-check
/**
 * wasm 엔진의 적합성 테스트(Step 1 완료 기준). 검사 본문은 `engine-contract.js`에 있고 네이티브 엔진도 같은 것을 돌린다.
 */
import { defineEngineContract } from './engine-contract.js';
import { openWasmEngine } from './helpers.js';

defineEngineContract('wasm', openWasmEngine);
