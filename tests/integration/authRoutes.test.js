import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../../backend/app.js';

function signToken(payload, secret) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(payload);
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

test('protected routes return 401/403 and allow valid scope', async (t) => {
  process.env.AUTH_JWT_SECRET = 'integration-secret';
  process.env.ALLOW_LOCAL_DEV_AUTH_BYPASS = '0';
  const app = createApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const noAuthRes = await fetch(`${base}/api/magic-listing/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'missing', fieldName: 'title' }),
  });
  assert.equal(noAuthRes.status, 401);

  const wrongScopeToken = signToken({ sub: 'user-1', scopes: ['ai.styles:analyze'], exp: Math.floor(Date.now() / 1000) + 3600 }, process.env.AUTH_JWT_SECRET);
  const forbiddenRes = await fetch(`${base}/api/magic-listing/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${wrongScopeToken}` },
    body: JSON.stringify({ sessionId: 'missing', fieldName: 'title' }),
  });
  assert.equal(forbiddenRes.status, 403);

  const okToken = signToken({ sub: 'user-1', scopes: ['ai.listing:generate'], exp: Math.floor(Date.now() / 1000) + 3600 }, process.env.AUTH_JWT_SECRET);
  const okRes = await fetch(`${base}/api/magic-listing/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${okToken}` },
    body: JSON.stringify({ sessionId: 'session-auth-test', fieldName: 'title', aiValue: 'AI Title', acceptedValue: 'Reviewed Title', status: 'accepted' }),
  });
  assert.equal(okRes.status, 200);
  const body = await okRes.json();
  assert.equal(body.success, true);
});
