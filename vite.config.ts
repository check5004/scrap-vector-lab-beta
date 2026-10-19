import { defineConfig } from 'vite';
const source = process.env.SCRAP_SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? 'local';
if (source !== 'local' && !/^[a-f0-9]{40}$/.test(source)) throw Error('SCRAP_SOURCE_COMMIT must be a full lowercase Git SHA or local.');
export default defineConfig({base:'./', define: { __SCRAP_SOURCE_COMMIT__: JSON.stringify(source) }, worker:{format:'es'}, build:{target:'es2022'}});
