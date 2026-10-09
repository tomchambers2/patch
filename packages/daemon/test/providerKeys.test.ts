// The host's provider-key store (spec/02 § Provider keys): storage on the
// host only (0600), UI-set wins over the environment, changes apply live, and
// no value ever leaves except through `get()`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderKeyError, ProviderKeyStore, providerKeysPath } from '../src/providerKeys.js';

// Obviously fake values, long enough to pass the length floor.
const UI_GEMINI = 'ui-gemini-fake-value-000000-WXYZ';
const ENV_GEMINI = 'env-gemini-fake-value-00000-ENV1';
const UI_GROQ = 'ui-groq-fake-value-0000000-GRQ9';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'patch-provider-keys-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function store(
  env: ConstructorParameters<typeof ProviderKeyStore>[0]['env'] = {},
  extra: Partial<ConstructorParameters<typeof ProviderKeyStore>[0]> = {},
): ProviderKeyStore {
  return new ProviderKeyStore({ path: providerKeysPath(home), env, ...extra });
}

describe('ProviderKeyStore — storage', () => {
  it('writes keys.json under PATCH_HOME with mode 0600', () => {
    store().set('gemini', UI_GEMINI);
    const path = join(home, 'keys.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      keys: { gemini: UI_GEMINI },
    });
  });

  it('survives a restart: a new store reads what the last one wrote', () => {
    store().set('groq', UI_GROQ);
    expect(store().get('groq')).toBe(UI_GROQ);
  });

  it('narrows a file someone widened back to 0600 on load', () => {
    store().set('gemini', UI_GEMINI);
    const path = join(home, 'keys.json');
    chmodSync(path, 0o644);
    store();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses to boot on a malformed file rather than starting empty (NO FALLBACK)', () => {
    writeFileSync(join(home, 'keys.json'), '{"keys": {"gemini": 1}}', { mode: 0o600 });
    expect(() => store()).toThrow(/not a valid provider-key file/);
  });

  it('refuses an unknown key id in the file', () => {
    writeFileSync(
      join(home, 'keys.json'),
      JSON.stringify({ version: 1, keys: { anthropic: 'x' } }),
      { mode: 0o600 },
    );
    expect(() => store()).toThrow(/not a valid provider-key file/);
  });

  it('trims a pasted value, and refuses empty, short or spaced ones', () => {
    const s = store();
    s.set('gemini', `  ${UI_GEMINI}\n`);
    expect(s.get('gemini')).toBe(UI_GEMINI);
    for (const bad of ['', '   ', 'short', 'has a space in the middle-000000']) {
      expect(() => s.set('openai', bad)).toThrow(ProviderKeyError);
    }
    expect(s.get('openai')).toBeUndefined();
  });
});

describe('ProviderKeyStore — precedence', () => {
  it('a UI-set key wins over the environment, and revoking it restores the environment', () => {
    const s = store({ gemini: ENV_GEMINI });
    expect(s.get('gemini')).toBe(ENV_GEMINI);
    s.set('gemini', UI_GEMINI);
    expect(s.get('gemini')).toBe(UI_GEMINI);
    s.revoke('gemini');
    expect(s.get('gemini')).toBe(ENV_GEMINI);
  });

  it('describe() states the source and last four, and nothing else', () => {
    const s = store({ gemini: ENV_GEMINI, groq: 'env-groq-fake-value-000000-G1G2' });
    s.set('gemini', UI_GEMINI);
    const described = s.describe();
    expect(described).toEqual([
      { id: 'gemini', source: 'ui', last4: 'WXYZ', envSet: true },
      { id: 'openai', source: 'none', envSet: false },
      { id: 'groq', source: 'env', last4: 'G1G2', envSet: true },
    ]);
    const json = JSON.stringify(described);
    expect(json).not.toContain(UI_GEMINI);
    expect(json).not.toContain(ENV_GEMINI);
  });
});

describe('ProviderKeyStore — revoke', () => {
  it('an env-only key cannot be revoked', () => {
    const s = store({ openai: 'env-openai-fake-value-00000-OAI1' });
    expect(() => s.revoke('openai')).toThrow(expect.objectContaining({ code: 'env_only' }));
  });

  it('a key that is not set cannot be revoked', () => {
    expect(() => store().revoke('groq')).toThrow(expect.objectContaining({ code: 'not_set' }));
  });

  it('refuses to revoke the only key the host needs to start', () => {
    const s = store({}, { requiredToStart: { groq: 'This host transcribes with Groq' } });
    s.set('groq', UI_GROQ);
    expect(() => s.revoke('groq')).toThrow(expect.objectContaining({ code: 'required' }));
    expect(s.get('groq')).toBe(UI_GROQ);
  });

  it('allows it when the environment still has one to fall back to', () => {
    const s = store(
      { groq: 'env-groq-fake-value-000000-G1G2' },
      { requiredToStart: { groq: 'This host transcribes with Groq' } },
    );
    s.set('groq', UI_GROQ);
    s.revoke('groq');
    expect(s.describe().find((k) => k.id === 'groq')?.source).toBe('env');
  });
});

describe('ProviderKeyStore — live change', () => {
  it('tells listeners after each change, once the file holds it', () => {
    const s = store();
    const seen: Array<string | undefined> = [];
    s.onChange(() => {
      seen.push(JSON.parse(readFileSync(join(home, 'keys.json'), 'utf8')).keys.gemini);
    });
    s.set('gemini', UI_GEMINI);
    s.revoke('gemini');
    expect(seen).toEqual([UI_GEMINI, undefined]);
  });

  it('a refused change tells nobody', () => {
    const s = store();
    let calls = 0;
    s.onChange(() => calls++);
    expect(() => s.revoke('gemini')).toThrow();
    expect(() => s.set('gemini', 'x')).toThrow();
    expect(calls).toBe(0);
  });
});

describe('ProviderKeyStore — from the shared settings (spec/01 § Settings)', () => {
  it('replaces every Settings-set key with the snapshot’s, and tells listeners once', () => {
    const s = store();
    s.set('gemini', UI_GEMINI);
    let told = 0;
    s.onChange(() => (told += 1));
    s.replaceAll({ groq: UI_GROQ });
    expect(s.get('gemini')).toBeUndefined();
    expect(s.get('groq')).toBe(UI_GROQ);
    expect(store().get('groq')).toBe(UI_GROQ);
    expect(told).toBe(1);
    // The same set again writes nothing and tells nobody.
    s.replaceAll({ groq: UI_GROQ });
    expect(told).toBe(1);
  });

  it('refuses a snapshot without the key this host needs to start, changing nothing', () => {
    const s = store({}, { requiredToStart: { groq: 'This host runs WHISPER_BACKEND=groq' } });
    s.set('groq', UI_GROQ);
    expect(() => s.replaceAll({})).toThrow(ProviderKeyError);
    expect(s.get('groq')).toBe(UI_GROQ);
  });

  it('allows it when the environment still has one', () => {
    const s = store(
      { groq: 'env-groq-fake-value-000000-ENV2' },
      { requiredToStart: { groq: 'groq host' } },
    );
    s.replaceAll({});
    expect(s.get('groq')).toBe('env-groq-fake-value-000000-ENV2');
  });

  it('hands up the Settings-set keys for the import, and the environment’s for adopting', () => {
    const s = store({ gemini: ENV_GEMINI });
    s.set('groq', UI_GROQ);
    expect(s.settingsKeys()).toEqual({ groq: UI_GROQ });
    expect(s.envValue('gemini')).toBe(ENV_GEMINI);
    expect(s.envValue('openai')).toBeUndefined();
  });
});
