/** Release identity is public metadata; never derive it from user input or URLs. */
declare const __SCRAP_SOURCE_COMMIT__: string;
export const RELEASE_VERSION = '0.3.0-dev.4';
const source = typeof __SCRAP_SOURCE_COMMIT__ === 'string' ? __SCRAP_SOURCE_COMMIT__ : 'local';
export const SOURCE_COMMIT = /^[a-f0-9]{40}$/.test(source) ? source : 'local';
export const APP_VERSION = `${RELEASE_VERSION}+${SOURCE_COMMIT === 'local' ? 'local' : SOURCE_COMMIT.slice(0, 7)}`;
export const APP_BUILD = Object.freeze({
  version: APP_VERSION,
  release: RELEASE_VERSION,
  channel: 'beta',
  source_repository: 'check5004/scrap-vector-lab',
  source_commit: SOURCE_COMMIT,
});
