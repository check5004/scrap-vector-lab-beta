import test from 'node:test';
import assert from 'node:assert/strict';
import { type Provider } from '../src/ai.ts';
import {
 createProviderKeyStore, MAX_PROVIDER_KEY_LENGTH, MAX_PROVIDER_KEY_RECORD_LENGTH,
 PROVIDER_KEY_STORAGE_KEYS, providerStorageKey, type ProviderKeyStorage,
} from '../src/key-storage.ts';

// Synthetic, nonfunctional keys only. These tests never access a provider or API.
const KEYS = {
 openai: 'sk-proj-storage-unit-test-only-not-a-real-secret',
 openrouter: 'sk-or-v1-storage-unit-test-only-not-a-real-secret',
};
const record = (provider: Provider, key = KEYS[provider]) => JSON.stringify({ version: 1, provider, key });
test('beta never reads, migrates, overwrites or deletes production credential records', () => {
 const {values,storage,store}=memoryStorage();
 const production='scrap-vector-lab:provider-key:v1:openrouter';
 values.set(production,record('openrouter'));
 const operations:string[]=[];
 const observed=createProviderKeyStore(()=>({
  getItem(name){operations.push(name);return storage.getItem(name);},
  setItem(name,value){operations.push(name);storage.setItem(name,value);},
  removeItem(name){operations.push(name);storage.removeItem(name);},
 }));
 assert.equal(observed.load('openrouter').key,'');
 observed.save('openrouter',KEYS.openrouter);observed.clear('openrouter');
 assert.equal(values.get(production),record('openrouter'));
 assert.ok(operations.every(name=>name.startsWith('scrap-vector-lab-beta:provider-key:v1:')));
 assert.equal(store.load('openai').key,'');
});
function memoryStorage() {
 const values = new Map<string, string>();
 const storage: ProviderKeyStorage = {
  getItem: name => values.get(name) ?? null,
  setItem: (name, value) => { values.set(name, value); },
  removeItem: name => { values.delete(name); },
 };
 return { values, storage, store: createProviderKeyStore(() => storage) };
}

test('fresh stores restore trimmed, versioned provider-separated keys across a simulated reload', () => {
 const { values, storage, store } = memoryStorage();
 for (const provider of ['openai', 'openrouter'] as const) {
  assert.deepEqual(store.load(provider), { key: '', status: 'empty' });
  assert.deepEqual(store.save(provider, ` \t${KEYS[provider]}\n `), { status: 'saved' });
  assert.deepEqual(JSON.parse(values.get(PROVIDER_KEY_STORAGE_KEYS[provider])!), { version: 1, provider, key: KEYS[provider] });
 }
 const reloaded = createProviderKeyStore(() => storage);
 assert.deepEqual(reloaded.load('openai'), { key: KEYS.openai, status: 'loaded' });
 assert.deepEqual(reloaded.load('openrouter'), { key: KEYS.openrouter, status: 'loaded' });
 assert.equal(values.size, 2);
 assert.ok(Object.isFrozen(PROVIDER_KEY_STORAGE_KEYS));
 assert.equal(providerStorageKey('openai'), PROVIDER_KEY_STORAGE_KEYS.openai);
 assert.equal(providerStorageKey('openrouter'), PROVIDER_KEY_STORAGE_KEYS.openrouter);
});

test('clearing one provider removes only that record and stays cleared after reload', () => {
 const { values, storage, store } = memoryStorage();
 store.save('openai', KEYS.openai);
 store.save('openrouter', KEYS.openrouter);
 values.set('unrelated-app-setting', 'keep');
 assert.deepEqual(store.clear('openai'), { status: 'cleared' });
 assert.deepEqual(createProviderKeyStore(() => storage).load('openai'), { key: '', status: 'empty' });
 assert.deepEqual(store.load('openrouter'), { key: KEYS.openrouter, status: 'loaded' });
 assert.equal(values.get('unrelated-app-setting'), 'keep');
 assert.deepEqual(store.clear('openai'), { status: 'cleared' });
});

for (const provider of ['openai', 'openrouter'] as const) {
 test(`${provider}: empty, invalid, or wrong-provider replacements cannot restore an old key`, () => {
  const { storage, store } = memoryStorage();
  for (const input of ['', ' \n\t ', 'bad\nkey', provider === 'openai' ? KEYS.openrouter : KEYS.openai, 'x'.repeat(MAX_PROVIDER_KEY_LENGTH + 1)]) {
   store.save(provider, KEYS[provider]);
   assert.deepEqual(store.save(provider, input), { status: input.trim() ? 'invalid-cleared' : 'cleared' });
   assert.deepEqual(createProviderKeyStore(() => storage).load(provider), { key: '', status: 'empty' });
  }
  store.save(provider, KEYS[provider]);
  assert.deepEqual(store.save(provider, undefined as unknown as string), { status: 'invalid-cleared' });
  assert.deepEqual(store.load(provider), { key: '', status: 'empty' });
 });

 test(`${provider}: malformed, oversized, schema-mismatched, and wrong-provider records are removed safely`, () => {
  const { values, store } = memoryStorage();
  const other = provider === 'openai' ? 'openrouter' : 'openai';
  const malformed = [
   '', '{', 'null', '[]', '123', '"string"', 'true',
   JSON.stringify({ version: 1, provider }),
   JSON.stringify({ version: 1, provider, key: KEYS[provider], extra: true }),
   JSON.stringify({ version: '1', provider, key: KEYS[provider] }),
   JSON.stringify({ version: 2, provider, key: KEYS[provider] }),
   JSON.stringify({ version: 1, provider, key: null }),
   JSON.stringify({ version: 1, provider, key: 123 }),
   JSON.stringify({ version: 1, provider, key: {} }),
   record(other), record(provider, KEYS[other]),
   record(provider, ''), record(provider, ` ${KEYS[provider]} `),
   record(provider, `${KEYS[provider]}\u0000`),
   record(provider, `sk-or-v1-${'x'.repeat(MAX_PROVIDER_KEY_LENGTH)}`),
   ' '.repeat(MAX_PROVIDER_KEY_RECORD_LENGTH + 1),
   JSON.stringify({ version: 1, provider, key: KEYS[provider], __proto__: null, constructor: 'no' }),
  ];
  for (const raw of malformed) {
   values.set(PROVIDER_KEY_STORAGE_KEYS[provider], raw);
   values.set(PROVIDER_KEY_STORAGE_KEYS[other], record(other));
   assert.deepEqual(store.load(provider), { key: '', status: 'invalid-cleared' });
   assert.equal(values.has(PROVIDER_KEY_STORAGE_KEYS[provider]), false);
   assert.equal(values.get(PROVIDER_KEY_STORAGE_KEYS[other]), record(other));
  }
 });
}

test('unsupported runtime providers cannot read, write, or delete any storage location', () => {
 let calls = 0;
 const store = createProviderKeyStore(() => { calls++; throw Error('must never access storage'); });
 for (const provider of ['__proto__', 'constructor', 'https://attacker.invalid', '', null, undefined] as unknown as Provider[]) {
  assert.equal(providerStorageKey(provider), null);
  assert.deepEqual(store.load(provider), { key: '', status: 'unsupported-provider' });
  assert.deepEqual(store.save(provider, KEYS.openai), { status: 'unsupported-provider' });
  assert.deepEqual(store.clear(provider), { status: 'unsupported-provider' });
 }
 assert.equal(calls, 0);
});

test('storage accessor errors or missing browser storage return safe unavailable statuses', () => {
 for (const access of [() => null, () => undefined, () => { throw Error(KEYS.openai); }]) {
  const store = createProviderKeyStore(access);
  assert.deepEqual(store.load('openai'), { key: '', status: 'unavailable' });
  assert.deepEqual(store.save('openai', KEYS.openai), { status: 'unavailable' });
  assert.deepEqual(store.save('openai', ''), { status: 'clear-failed' });
  assert.deepEqual(store.clear('openai'), { status: 'clear-failed' });
 }
});

test('default localStorage property getter exceptions are contained', () => {
 const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
 Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error(KEYS.openai); } });
 try {
  const store = createProviderKeyStore();
  assert.deepEqual(store.load('openai'), { key: '', status: 'unavailable' });
  assert.deepEqual(store.save('openai', KEYS.openai), { status: 'unavailable' });
  assert.deepEqual(store.clear('openai'), { status: 'clear-failed' });
 } finally {
  if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
  else Reflect.deleteProperty(globalThis, 'localStorage');
 }
});

test('getItem failures and method property getter failures never surface raw errors', () => {
 for (const methodGetter of [false, true]) {
  const { storage, store } = memoryStorage();
  if (methodGetter) Object.defineProperty(storage, 'getItem', { get() { throw Error(KEYS.openai); } });
  else storage.getItem = () => { throw Error(KEYS.openai); };
  assert.deepEqual(store.load('openai'), { key: '', status: 'unavailable' });
 }
});

test('setItem failures remove any older record and report save-failed without returning the key', () => {
 for (const methodGetter of [false, true]) {
  const { values, storage, store } = memoryStorage();
  store.save('openai', KEYS.openai);
  if (methodGetter) Object.defineProperty(storage, 'setItem', { get() { throw Error(KEYS.openai); } });
  else storage.setItem = () => { throw Error(KEYS.openai); };
  assert.deepEqual(store.save('openai', 'sk-proj-another-unit-test-only'), { status: 'save-failed' });
  assert.equal(values.has(PROVIDER_KEY_STORAGE_KEYS.openai), false);
  assert.deepEqual(store.load('openai'), { key: '', status: 'empty' });
 }
});

test('failed deletion is truthful, suppresses the old key in this session, and can recover', () => {
 for (const methodGetter of [false, true]) {
  const { values, storage, store } = memoryStorage();
  store.save('openai', KEYS.openai);
  const remove = storage.removeItem;
  if (methodGetter) Object.defineProperty(storage, 'removeItem', { configurable: true, get() { throw Error(KEYS.openai); } });
  else storage.removeItem = () => { throw Error(KEYS.openai); };
  assert.deepEqual(store.clear('openai'), { status: 'clear-failed' });
  assert.ok(values.has(PROVIDER_KEY_STORAGE_KEYS.openai));
  assert.deepEqual(store.load('openai'), { key: '', status: 'clear-failed' });
  assert.deepEqual(store.save('openai', KEYS.openrouter), { status: 'clear-failed' });
  assert.deepEqual(store.load('openai'), { key: '', status: 'clear-failed' });
  Object.defineProperty(storage, 'removeItem', { configurable: true, writable: true, value: remove });
  assert.deepEqual(store.load('openai'), { key: '', status: 'cleared' });
  assert.equal(values.has(PROVIDER_KEY_STORAGE_KEYS.openai), false);
  assert.deepEqual(store.save('openai', KEYS.openai), { status: 'saved' });
  assert.deepEqual(store.load('openai'), { key: KEYS.openai, status: 'loaded' });
 }
});

test('simultaneous save/cleanup failures never re-expose an older key through the same store', () => {
 const { storage, store } = memoryStorage();
 store.save('openai', KEYS.openai);
 storage.setItem = () => { throw Error(KEYS.openai); };
 storage.removeItem = () => { throw Error(KEYS.openai); };
 assert.deepEqual(store.save('openai', 'sk-proj-new-synthetic-value'), { status: 'clear-failed' });
 assert.deepEqual(store.load('openai'), { key: '', status: 'clear-failed' });
});

test('invalid stored records with failed cleanup are never returned', () => {
 const { values, storage, store } = memoryStorage();
 values.set(PROVIDER_KEY_STORAGE_KEYS.openai, record('openrouter'));
 storage.removeItem = () => { throw Error(KEYS.openai); };
 assert.deepEqual(store.load('openai'), { key: '', status: 'clear-failed' });
});

test('storage denial after replacement suppresses the stale value when access resumes', () => {
 const { values, storage } = memoryStorage();
 let available = true;
 const store = createProviderKeyStore(() => available ? storage : null);
 store.save('openai', KEYS.openai);
 available = false;
 assert.deepEqual(store.save('openai', 'sk-proj-new-synthetic-value'), { status: 'unavailable' });
 available = true;
 assert.deepEqual(store.load('openai'), { key: '', status: 'cleared' });
 assert.equal(values.has(PROVIDER_KEY_STORAGE_KEYS.openai), false);
});

test('accessor denial during deletion warns that an existing record may remain and suppresses it', () => {
 for (const action of ['clear', 'empty replacement', 'invalid replacement'] as const) {
  const { values, storage } = memoryStorage();
  let available = true;
  const store = createProviderKeyStore(() => {
   if (!available) throw Error(KEYS.openai);
   return storage;
  });
  store.save('openai', KEYS.openai);
  available = false;
  const result = action === 'clear' ? store.clear('openai') : store.save('openai', action === 'empty replacement' ? '' : KEYS.openrouter);
  assert.deepEqual(result, { status: 'clear-failed' });
  assert.equal(values.get(PROVIDER_KEY_STORAGE_KEYS.openai), record('openai'));
  assert.deepEqual(store.load('openai'), { key: '', status: 'clear-failed' });
  available = true;
  assert.deepEqual(store.load('openai'), { key: '', status: 'cleared' });
  assert.equal(values.has(PROVIDER_KEY_STORAGE_KEYS.openai), false);
 }
});

test('bounded key/record validation includes serialized expansion without truncating keys', () => {
 const { values, store } = memoryStorage();
 const key = `sk-proj-${'x'.repeat(MAX_PROVIDER_KEY_LENGTH - 8)}`;
 assert.equal(key.length, MAX_PROVIDER_KEY_LENGTH);
 assert.deepEqual(store.save('openai', key), { status: 'saved' });
 assert.deepEqual(store.load('openai'), { key, status: 'loaded' });
 // Quotes pass the existing OpenAI format check but double in JSON storage.
 assert.deepEqual(store.save('openai', '"'.repeat(MAX_PROVIDER_KEY_LENGTH)), { status: 'invalid-cleared' });
 assert.equal(values.has(PROVIDER_KEY_STORAGE_KEYS.openai), false);
});

test('persistence actions never fetch or log values, including rejected replacements', t => {
 let network = 0;
 let logs = 0;
 t.mock.method(globalThis, 'fetch', async () => { network++; throw Error('Network must never run'); });
 for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) t.mock.method(console, method, () => { logs++; });
 const { store } = memoryStorage();
 store.save('openai', KEYS.openai);
 store.load('openai');
 store.save('openai', KEYS.openrouter);
 store.save('openrouter', KEYS.openai);
 store.clear('openai');
 assert.equal(network, 0);
 assert.equal(logs, 0);
});
