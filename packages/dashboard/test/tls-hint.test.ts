import { describe, it, expect } from 'vitest';
import { withCertHint, type Transport } from '../src/http.js';

// Global fetch reports an untrusted certificate as TypeError('fetch failed') with the
// TLS code on `cause` — alone, "fetch failed" tells a user behind a corporate proxy nothing.
function fetchFailed(code: string): TypeError {
  const cause = Object.assign(new Error('unable to get local issuer certificate'), { code });
  return new TypeError('fetch failed', { cause });
}

const throwing =
  (err: unknown): Transport =>
  async () => {
    throw err;
  };

describe('withCertHint — an untrusted certificate names the fix', () => {
  it.each([
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ])('%s -> points at NODE_EXTRA_CA_CERTS and --use-system-ca', async (code) => {
    const transport = withCertHint(throwing(fetchFailed(code)));
    const err = await transport('https://a.blazemeter.com/api/v4/masters/1').catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(code);
    expect(err.message).toContain('a.blazemeter.com');
    expect(err.message).toContain('NODE_EXTRA_CA_CERTS');
    expect(err.message).toContain('--use-system-ca');
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it('passes any other network error through untouched', async () => {
    const original = fetchFailed('ECONNREFUSED');
    const transport = withCertHint(throwing(original));
    await expect(transport('https://a.blazemeter.com/')).rejects.toBe(original);
  });

  it('passes a successful response through untouched', async () => {
    const res = { status: 200, ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    const transport = withCertHint(async () => res);
    await expect(transport('https://a.blazemeter.com/')).resolves.toBe(res);
  });
});
