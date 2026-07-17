import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCredentials, basicAuthHeader } from '../src/http.js';

describe('loadCredentials — BlazeMeter convention', () => {
  it('reads the file form: BLAZEMETER_API_KEY -> api-key.json {id, secret}', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bzm-cred-'));
    const keyPath = path.join(dir, 'api-key.json');
    await writeFile(keyPath, JSON.stringify({ id: 'file-id', secret: 'file-secret' }));

    const creds = await loadCredentials({ BLAZEMETER_API_KEY: keyPath } as NodeJS.ProcessEnv);
    expect(creds).toEqual({ id: 'file-id', secret: 'file-secret' });
  });

  it('reads the discrete-vars form for CI', async () => {
    const creds = await loadCredentials({
      BLAZEMETER_API_KEY_ID: 'ci-id',
      BLAZEMETER_API_KEY_SECRET: 'ci-secret',
    } as NodeJS.ProcessEnv);
    expect(creds).toEqual({ id: 'ci-id', secret: 'ci-secret' });
  });

  it('throws when no credentials are present', async () => {
    await expect(loadCredentials({} as NodeJS.ProcessEnv)).rejects.toThrow(/credentials/i);
  });

  it('encodes Basic auth as base64(id:secret)', () => {
    expect(basicAuthHeader({ id: 'a', secret: 'b' })).toBe(
      `Basic ${Buffer.from('a:b').toString('base64')}`,
    );
  });
});
