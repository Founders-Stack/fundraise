import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../dist/client.js';

const originalFetch = globalThis.fetch;
const originalTimeout = process.env.FS_API_TIMEOUT_MS;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalTimeout === undefined) delete process.env.FS_API_TIMEOUT_MS;
  else process.env.FS_API_TIMEOUT_MS = originalTimeout;
});

test('forwards JSON and returns API data', async () => {
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.body, '{"previewId":"preview"}');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ issuanceId: 'created' });
  };
  assert.deepEqual(await api('POST', '/issuances', { previewId: 'preview' }), { issuanceId: 'created' });
});

test('preserves API errors', async () => {
  globalThis.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 });
  await assert.rejects(api('GET', '/issuances'), e => e instanceof ApiError && e.status === 401 && e.body.error === 'unauthorized');
});

for (const phase of ['headers', 'body']) {
  test(`times out during ${phase} without retrying a mutation`, async () => {
    process.env.FS_API_TIMEOUT_MS = '10';
    let calls = 0;
    globalThis.fetch = async (_url, { signal }) => {
      calls++;
      const stalled = () => new Promise((resolve, reject) => {
        const keepAlive = setTimeout(resolve, 1000);
        signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
      });
      if (phase === 'headers') return stalled();
      return { text: stalled };
    };
    await assert.rejects(api('POST', '/issuances', {}), e => {
      assert.equal(e.status, 504);
      assert.equal(e.body.error, 'api_timeout');
      assert.match(e.body.message, /outcome is unknown/);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('rejects invalid timeout configuration before sending', async () => {
  globalThis.fetch = async () => { assert.fail('must not send'); };
  for (const value of ['0', '-1', 'NaN', '1.5', '2147483648']) {
    process.env.FS_API_TIMEOUT_MS = value;
    await assert.rejects(api('GET', '/issuances'), /FS_API_TIMEOUT_MS/);
  }
});
