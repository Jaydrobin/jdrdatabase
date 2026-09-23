/**
 * 빌드 시 esbuild `define`으로 치환되는 컴파일 타임 상수.
 * 값은 build/build.mjs가 정한다. 릴리스 빌드에서 `__JDR_TEST__`는 false다.
 */
declare const __JDR_TEST__: boolean;
declare const __JDR_VERSION__: string;
