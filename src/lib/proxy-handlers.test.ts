import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { handleProxyRequest, handleLiveStreamRequest } from './proxy-handlers';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

describe('DISABLE_STREAM_PROXY 媒体流代理拦截', () => {
  const originalEnv = process.env.DISABLE_STREAM_PROXY;
  const originalPass = process.env.PASSWORD;
  let authCookie = '';

  beforeAll(() => {
    process.env.PASSWORD = 'test-secret-password';
    const { token } = signSession();
    authCookie = `${SESSION_COOKIE}=${token}`;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DISABLE_STREAM_PROXY;
    } else {
      process.env.DISABLE_STREAM_PROXY = originalEnv;
    }
    if (originalPass === undefined) {
      delete process.env.PASSWORD;
    } else {
      process.env.PASSWORD = originalPass;
    }
  });

  it('开启 DISABLE_STREAM_PROXY 时，.m3u8 目标在请求前直接拦截返回 403', async () => {
    process.env.PASSWORD = 'test-secret-password';
    process.env.DISABLE_STREAM_PROXY = 'true';
    const req = new Request('https://libretv.test/api/proxy?url=https%3A%2F%2Fexample.com%2Fvideo.m3u8', {
      headers: { cookie: authCookie },
    });
    const res = await handleProxyRequest(req, 'https://example.com/video.m3u8');
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain('媒体流代理已被管理员禁用');
  });

  it('开启 DISABLE_STREAM_PROXY 时，.ts 分片目标在请求前直接拦截返回 403', async () => {
    process.env.PASSWORD = 'test-secret-password';
    process.env.DISABLE_STREAM_PROXY = '1';
    const req = new Request('https://libretv.test/api/proxy?url=https%3A%2F%2Fexample.com%2Fseg1.ts', {
      headers: { cookie: authCookie },
    });
    const res = await handleProxyRequest(req, 'https://example.com/seg1.ts');
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain('媒体流代理已被管理员禁用');
  });

  it('开启 DISABLE_STREAM_PROXY 时，直播流代理直接拦截返回 403', async () => {
    process.env.PASSWORD = 'test-secret-password';
    process.env.DISABLE_STREAM_PROXY = 'true';
    const req = new Request('https://libretv.test/api/live/stream?url=https%3A%2F%2Fexample.com%2Flive.m3u8', {
      headers: { cookie: authCookie },
    });
    const res = await handleLiveStreamRequest(req, 'https://example.com/live.m3u8');
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain('直播流代理已被管理员禁用');
  });
});
