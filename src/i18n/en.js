// @ts-check
/**
 * 영어 문자열. v1에서는 키만 ko.js와 같게 유지한다(D-14).
 * @type {Readonly<Record<keyof typeof import('./ko.js').ko, string>>}
 */
export const en = Object.freeze({
  'app.title': 'jdrdatabase',
  'app.subtitle': 'A serverless SQLite database manager that runs in your browser',
  'app.version': 'Version {version}',
  'status.booting': 'Starting…',
  'status.ready': 'Ready',
});
