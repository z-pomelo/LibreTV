import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isStreamProxyDisabled } from './env-stream-proxy';

describe('isStreamProxyDisabled', () => {
  const originalEnv = process.env.DISABLE_STREAM_PROXY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DISABLE_STREAM_PROXY;
    } else {
      process.env.DISABLE_STREAM_PROXY = originalEnv;
    }
  });

  it('未配置时返回 false', () => {
    delete process.env.DISABLE_STREAM_PROXY;
    expect(isStreamProxyDisabled()).toBe(false);
  });

  it('配置为 true/1/yes 时返回 true（大小写与空白字符不敏感）', () => {
    process.env.DISABLE_STREAM_PROXY = 'true';
    expect(isStreamProxyDisabled()).toBe(true);

    process.env.DISABLE_STREAM_PROXY = ' TRUE ';
    expect(isStreamProxyDisabled()).toBe(true);

    process.env.DISABLE_STREAM_PROXY = '1';
    expect(isStreamProxyDisabled()).toBe(true);

    process.env.DISABLE_STREAM_PROXY = 'yes';
    expect(isStreamProxyDisabled()).toBe(true);
  });

  it('配置为 false/0/no 或其他无效值时返回 false', () => {
    process.env.DISABLE_STREAM_PROXY = 'false';
    expect(isStreamProxyDisabled()).toBe(false);

    process.env.DISABLE_STREAM_PROXY = '0';
    expect(isStreamProxyDisabled()).toBe(false);

    process.env.DISABLE_STREAM_PROXY = 'random';
    expect(isStreamProxyDisabled()).toBe(false);
  });
});
