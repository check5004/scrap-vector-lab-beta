import { readFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const sourceRepository = 'check5004/scrap-vector-lab';
const betaRepository = 'check5004/scrap-vector-lab-beta';
const repository = process.env.GITHUB_REPOSITORY;
let commit = process.env.GITHUB_SHA;
if (repository === betaRepository) {
  const mapping = JSON.parse(await readFile('release-source.json','utf8'));
  if (mapping.repository !== sourceRepository || mapping.branch !== 'beta/auto-curves-20261019' || !/^[a-f0-9]{40}$/.test(mapping.commit)) throw Error('Invalid pinned beta source mapping.');
  commit = mapping.commit;
  const response = await fetch(`https://api.github.com/repos/${sourceRepository}/git/trees/${commit}?recursive=1`, {headers:{Accept:'application/vnd.github+json'},redirect:'error'});
  if (!response.ok) throw Error(`Cannot verify public source tree: HTTP ${response.status}`);
  const tree = await response.json();
  if (tree.truncated || !Array.isArray(tree.tree)) throw Error('Incomplete source tree.');
  const remote = tree.tree.filter(item => item.type === 'blob');
  const local = execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean).filter(p=>p!=='release-source.json');
  if (local.length !== remote.length || remote.some(item=>!local.includes(item.path))) throw Error('Distribution paths differ from pinned source.');
  for (const item of remote) {
    const bytes = await readFile(item.path);
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (sha !== item.sha || item.mode !== '100644') throw Error(`Distribution differs from pinned source: ${item.path}`);
  }
  console.log(`Verified ${remote.length} source blobs against ${sourceRepository}@${commit}`);
} else if (repository !== sourceRepository || !process.env.GITHUB_REF?.startsWith('refs/heads/beta/')) {
  throw Error('This beta workflow may only run in the beta repository or an original-repository beta branch.');
}
if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw Error('Missing full source commit.');
if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV,`SCRAP_SOURCE_COMMIT=${commit}\n`);
const {version}=JSON.parse(await readFile('package.json','utf8'));
if(typeof version!=='string'||!/^\d+\.\d+\.\d+-dev\.\d+$/.test(version))throw Error('Expected explicit development release version.');
const buildInfo=await readFile('src/build-info.ts','utf8');
if(!buildInfo.includes(`RELEASE_VERSION = '${version}'`))throw Error('Package and application release versions differ.');
console.log(`Source version: ${version}+${commit.slice(0,7)}`);
