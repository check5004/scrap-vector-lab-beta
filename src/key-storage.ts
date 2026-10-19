import { validateProviderKey, type Provider } from './ai';

/** Personal BYOK only: browser-local storage is readable by scripts on this origin. */
export const PROVIDER_KEY_STORAGE_KEYS = Object.freeze({
 openai: 'scrap-vector-lab-beta:provider-key:v1:openai',
 openrouter: 'scrap-vector-lab-beta:provider-key:v1:openrouter',
});
export const MAX_PROVIDER_KEY_LENGTH = 4096;
export const MAX_PROVIDER_KEY_RECORD_LENGTH = 8192;

export type ProviderKeyStorageStatus =
 | 'loaded' | 'empty' | 'saved' | 'cleared' | 'invalid-cleared'
 | 'unavailable' | 'save-failed' | 'clear-failed' | 'unsupported-provider';
export type KeyStorageStatus = ProviderKeyStorageStatus;
export interface ProviderKeyStorageResult { status: ProviderKeyStorageStatus }
export interface ProviderKeyLoadResult extends ProviderKeyStorageResult { key: string }
export type ProviderKeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface ProviderKeyStore {
 load(provider: Provider): ProviderKeyLoadResult;
 save(provider: Provider, input: string): ProviderKeyStorageResult;
 clear(provider: Provider): ProviderKeyStorageResult;
}

const supportedProvider = (provider: unknown): provider is Provider => provider === 'openai' || provider === 'openrouter';
/** Exact app namespace for storage-event routing; unsupported providers have none. */
export function providerStorageKey(provider: Provider): string;
export function providerStorageKey(provider: unknown): string | null;
export function providerStorageKey(provider: unknown): string | null {
 return supportedProvider(provider) ? PROVIDER_KEY_STORAGE_KEYS[provider] : null;
}
const empty = (status: ProviderKeyStorageStatus): ProviderKeyLoadResult => ({ key: '', status });
const validKey = (provider: Provider, key: unknown): key is string => typeof key === 'string' &&
 key.length > 0 && key.length <= MAX_PROVIDER_KEY_LENGTH && key === key.trim() && validateProviderKey(provider, key) === null;

function decodeRecord(provider: Provider, raw: unknown): string | null {
 if (typeof raw !== 'string' || raw.length > MAX_PROVIDER_KEY_RECORD_LENGTH) return null;
 try {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 3 || !['version', 'provider', 'key'].every(key => Object.hasOwn(item, key)) ||
   item.version !== 1 || item.provider !== provider || !validKey(provider, item.key)) return null;
  return item.key;
 } catch {
  return null;
 }
}

/**
 * No network, logging, export, or memory fallback. All storage access (including
 * the localStorage getter and method getters) happens inside exception guards.
 * Inject an accessor to test a reload using a fresh store over the same storage.
 */
export function createProviderKeyStore(
 accessStorage: () => ProviderKeyStorage | null | undefined = () => globalThis.localStorage,
): ProviderKeyStore {
 // A failed delete must not bring the rejected old key back in this page session.
 // Across a reload, deletion cannot be guaranteed while the browser blocks storage.
 const blocked = new Set<Provider>();

 function storage(): ProviderKeyStorage | null {
  try { return accessStorage() ?? null; }
  catch { return null; }
 }

 function remove(provider: Provider, target: ProviderKeyStorage | null, success: 'cleared' | 'invalid-cleared'): ProviderKeyStorageResult {
  blocked.add(provider);
  if (!target) return { status: 'clear-failed' };
  try {
   target.removeItem(PROVIDER_KEY_STORAGE_KEYS[provider]);
   blocked.delete(provider);
   return { status: success };
  } catch {
   return { status: 'clear-failed' };
  }
 }

 return {
  load(provider) {
   if (!supportedProvider(provider)) return empty('unsupported-provider');
   const target = storage();
   if (blocked.has(provider)) return empty(remove(provider, target, 'cleared').status);
   if (!target) return empty('unavailable');
   let raw: unknown;
   try { raw = target.getItem(PROVIDER_KEY_STORAGE_KEYS[provider]); }
   catch { return empty('unavailable'); }
   if (raw === null) return empty('empty');
   const key = decodeRecord(provider, raw);
   if (key !== null) return { key, status: 'loaded' };
   return empty(remove(provider, target, 'invalid-cleared').status);
  },
  save(provider, input) {
   if (!supportedProvider(provider)) return { status: 'unsupported-provider' };
   const target = storage();
   const key = typeof input === 'string' ? input.trim() : '';
   if (!key) return remove(provider, target, typeof input === 'string' ? 'cleared' : 'invalid-cleared');
   if (!validKey(provider, key)) return remove(provider, target, 'invalid-cleared');
   const serialized = JSON.stringify({ version: 1, provider, key });
   if (serialized.length > MAX_PROVIDER_KEY_RECORD_LENGTH) return remove(provider, target, 'invalid-cleared');
   if (!target) {
    blocked.add(provider);
    return { status: 'unavailable' };
   }
   try {
    target.setItem(PROVIDER_KEY_STORAGE_KEYS[provider], serialized);
    blocked.delete(provider);
    return { status: 'saved' };
   } catch {
    // Failed replacement must not silently restore a previously saved key.
    const cleanup = remove(provider, target, 'cleared');
    return { status: cleanup.status === 'cleared' ? 'save-failed' : cleanup.status };
   }
  },
  clear(provider) {
   if (!supportedProvider(provider)) return { status: 'unsupported-provider' };
   return remove(provider, storage(), 'cleared');
  },
 };
}
