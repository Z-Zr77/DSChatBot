// OneBot 连接参数：地址归一化 + token 头。三类协议端（SnowLuma / NapCat / Lagrange）共用。
import test from 'node:test';
import assert from 'node:assert';
import { wsUrlOf, wsHeadersOf, wsUrlWithToken } from '../src/onebot.mjs';

test('默认没有配置时连 127.0.0.1:3001', () => {
  assert.equal(wsUrlOf({ onebot: {} }), 'ws://127.0.0.1:3001');
  assert.equal(wsUrlOf({}), 'ws://127.0.0.1:3001');
});

test('wsPort 能改', () => {
  assert.equal(wsUrlOf({ onebot: { wsPort: 5099 } }), 'ws://127.0.0.1:5099');
});

test('wsUrl 填完整地址时原样用', () => {
  assert.equal(wsUrlOf({ onebot: { wsUrl: 'ws://192.168.1.9:3001/onebot/v11/ws' } }),
    'ws://192.168.1.9:3001/onebot/v11/ws');
});

test('wsUrl 只填 host:port 时补 ws://', () => {
  assert.equal(wsUrlOf({ onebot: { wsUrl: '127.0.0.1:3001' } }), 'ws://127.0.0.1:3001');
});

test('没有 token 就不带头', () => {
  assert.deepEqual(wsHeadersOf({ onebot: {} }), {});
  assert.deepEqual(wsHeadersOf({}), {});
});

test('有 token 时带 Bearer 头（SnowLuma 默认要这个）', () => {
  assert.deepEqual(wsHeadersOf({ onebot: { accessToken: 'abc123' } }), { Authorization: 'Bearer abc123' });
});

test('token 前后空格不算 token', () => {
  assert.deepEqual(wsHeadersOf({ onebot: { accessToken: '   ' } }), {});
});

test('兜底：同时把 token 放到 query 上（有些实现只认这个）', () => {
  const u = wsUrlWithToken({ onebot: { accessToken: 'tok' } });
  assert.match(u, /access_token=tok/);
});
