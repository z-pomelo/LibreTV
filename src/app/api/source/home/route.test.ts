import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './route';
import * as apiGuard from '@/lib/api-guard';
import * as ssrf from '@/lib/ssrf';
import * as fetchUtils from '@/lib/fetch-utils';
import { NextResponse } from 'next/server';

vi.mock('@/lib/api-guard', () => ({
  guardRequest: vi.fn(),
  jsonError: (msg: string, status: number) => NextResponse.json({ error: msg }, { status }),
}));

vi.mock('@/lib/ssrf', () => ({
  checkUpstreamAllowed: vi.fn(),
}));

vi.mock('@/lib/fetch-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fetch-utils')>();
  return {
    ...actual,
    fetchUpstream: vi.fn(),
  };
});

describe('GET /api/source/home', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('权限守卫拦截：未登录返回 401', async () => {
    vi.mocked(apiGuard.guardRequest).mockReturnValueOnce(
      NextResponse.json({ error: '未登录' }, { status: 401 })
    );

    const req = new Request('http://localhost/api/source/home');
    const res = await GET(req);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('未登录');
  });

  it('缺少或非法 source 参数时返回 400', async () => {
    vi.mocked(apiGuard.guardRequest).mockReturnValue(null);

    // 缺少 source
    const res1 = await GET(new Request('http://localhost/api/source/home'));
    expect(res1.status).toBe(400);
    expect((await res1.json()).error).toBe('无效的点播源配置');

    // source 为非合法 JSON
    const res2 = await GET(new Request('http://localhost/api/source/home?source=invalid_json'));
    expect(res2.status).toBe(400);
    expect((await res2.json()).error).toBe('无效的点播源配置');

    // source.url 非 http(s)
    const res3 = await GET(
      new Request(
        `http://localhost/api/source/home?source=${encodeURIComponent(
          JSON.stringify({ key: 's1', name: 'S1', url: 'ftp://example.com' })
        )}`
      )
    );
    expect(res3.status).toBe(400);
    expect((await res3.json()).error).toBe('无效的点播源配置');
  });

  it('SSRF 校验失败时返回 400 并提示原因', async () => {
    vi.mocked(apiGuard.guardRequest).mockReturnValue(null);
    vi.mocked(ssrf.checkUpstreamAllowed).mockResolvedValueOnce({
      ok: false,
      reason: '目标地址解析到私有/保留网络',
    });

    const source = { key: 'ssrf', name: 'SSRF源', url: 'http://127.0.0.1/api.php' };
    const res = await GET(
      new Request(
        `http://localhost/api/source/home?source=${encodeURIComponent(JSON.stringify(source))}`
      )
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('目标地址解析到私有/保留网络');
  });

  it('标准响应解析：ac=videolist 携带 class 时正常解析', async () => {
    vi.mocked(apiGuard.guardRequest).mockReturnValue(null);
    vi.mocked(ssrf.checkUpstreamAllowed).mockResolvedValue({ ok: true });

    const source = { key: 'vod_1', name: '点播源1', url: 'https://cms1.test.com/api.php/provide/vod' };
    const mockData = {
      page: 1,
      pagecount: 5,
      total: 100,
      class: [
        { type_id: 1, type_pid: 0, type_name: '电影' },
        { type_id: 2, type_pid: 1, type_name: '动作片' },
      ],
      list: [
        {
          vod_id: 1001,
          vod_name: '测试电影',
          vod_pic: 'https://img.example.com/1.jpg',
          type_name: '电影',
          vod_year: '2024',
          vod_remarks: 'HD',
        },
      ],
    };

    vi.mocked(fetchUtils.fetchUpstream).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockData,
    } as unknown as Response);

    const res = await GET(
      new Request(
        `http://localhost/api/source/home?source=${encodeURIComponent(JSON.stringify(source))}`
      )
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.page).toBe(1);
    expect(data.pageCount).toBe(5);
    expect(data.total).toBe(100);
    expect(data.classes).toEqual([
      { id: 1, name: '电影', pid: 0 },
      { id: 2, name: '动作片', pid: 1 },
    ]);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      sourceKey: 'vod_1',
      sourceName: '点播源1',
      vodId: '1001',
      name: '测试电影',
    });
  });

  it('分类降级与缓存：ac=videolist 无 class 时请求 ac=list 并写入 10 分钟缓存', async () => {
    vi.mocked(apiGuard.guardRequest).mockReturnValue(null);
    vi.mocked(ssrf.checkUpstreamAllowed).mockResolvedValue({ ok: true });

    const source = { key: 'vod_2', name: '点播源2', url: 'https://cms2.test.com/api' };

    // 第一次请求第 1 页：videolist 无 class，降级请求 ac=list
    vi.mocked(fetchUtils.fetchUpstream)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          page: 1,
          pagecount: 2,
          total: 20,
          list: [{ vod_id: 2001, vod_name: '视频1' }],
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          class: [{ type_id: 'comic', type_name: '动漫' }],
        }),
      } as unknown as Response);

    const res1 = await GET(
      new Request(
        `http://localhost/api/source/home?source=${encodeURIComponent(JSON.stringify(source))}&page=1`
      )
    );
    expect(res1.status).toBe(200);
    const data1 = await res1.json();
    expect(data1.classes).toEqual([{ id: 'comic', name: '动漫' }]);
    expect(fetchUtils.fetchUpstream).toHaveBeenCalledTimes(2);

    // 第二次请求第 2 页：由于 page 不同，首页缓存未命中，但分类命中 10 分钟缓存，无需再次调用 ac=list
    vi.mocked(fetchUtils.fetchUpstream).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        page: 2,
        pagecount: 2,
        total: 20,
        list: [{ vod_id: 2002, vod_name: '视频2' }],
      }),
    } as unknown as Response);

    const res2 = await GET(
      new Request(
        `http://localhost/api/source/home?source=${encodeURIComponent(JSON.stringify(source))}&page=2`
      )
    );
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.classes).toEqual([{ id: 'comic', name: '动漫' }]);
    expect(fetchUtils.fetchUpstream).toHaveBeenCalledTimes(3); // 仅增加 1 次 videolist 请求
  });

  it('分页与分类参数正确拼装至上游请求 URL', async () => {
    vi.mocked(apiGuard.guardRequest).mockReturnValue(null);
    vi.mocked(ssrf.checkUpstreamAllowed).mockResolvedValue({ ok: true });

    const source = { key: 'vod_3', name: '点播源3', url: 'https://cms3.test.com/api/' };

    vi.mocked(fetchUtils.fetchUpstream).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ page: 3, pagecount: 10, total: 100, class: [], list: [] }),
    } as unknown as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ class: [] }),
    } as unknown as Response);

    await GET(
      new Request(
        `http://localhost/api/source/home?source=${encodeURIComponent(JSON.stringify(source))}&page=3&typeId=drama`
      )
    );

    expect(fetchUtils.fetchUpstream).toHaveBeenCalledWith(
      'https://cms3.test.com/api?ac=videolist&pg=3&t=drama',
      expect.any(Object)
    );
  });

  it('短时缓存：30 秒内相同请求直接走内存缓存', async () => {
    vi.mocked(apiGuard.guardRequest).mockReturnValue(null);
    vi.mocked(ssrf.checkUpstreamAllowed).mockResolvedValue({ ok: true });

    const source = { key: 'vod_4', name: '点播源4', url: 'https://cms4.test.com/api' };

    vi.mocked(fetchUtils.fetchUpstream).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        page: 1,
        pagecount: 1,
        total: 1,
        class: [{ type_id: 1, type_name: '电影' }],
        list: [{ vod_id: 1, vod_name: '缓存测试' }],
      }),
    } as unknown as Response);

    const reqUrl = `http://localhost/api/source/home?source=${encodeURIComponent(JSON.stringify(source))}`;
    const res1 = await GET(new Request(reqUrl));
    expect(res1.status).toBe(200);

    const callCount = vi.mocked(fetchUtils.fetchUpstream).mock.calls.length;

    // 再次发起完全相同的请求
    const res2 = await GET(new Request(reqUrl));
    expect(res2.status).toBe(200);
    // 上游请求次数未增加
    expect(vi.mocked(fetchUtils.fetchUpstream).mock.calls.length).toBe(callCount);
  });

  it('上游异常处理：HTTP 状态非 200 或网络错误返回 502', async () => {
    vi.mocked(apiGuard.guardRequest).mockReturnValue(null);
    vi.mocked(ssrf.checkUpstreamAllowed).mockResolvedValue({ ok: true });

    const source5 = { key: 'vod_5', name: '点播源5', url: 'https://cms5.test.com/api' };
    vi.mocked(fetchUtils.fetchUpstream).mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as unknown as Response);

    const res1 = await GET(
      new Request(
        `http://localhost/api/source/home?source=${encodeURIComponent(JSON.stringify(source5))}`
      )
    );
    expect(res1.status).toBe(502);

    const source6 = { key: 'vod_6', name: '点播源6', url: 'https://cms6.test.com/api' };
    vi.mocked(fetchUtils.fetchUpstream).mockRejectedValueOnce(new Error('上游超时'));

    const res2 = await GET(
      new Request(
        `http://localhost/api/source/home?source=${encodeURIComponent(JSON.stringify(source6))}`
      )
    );
    expect(res2.status).toBe(502);
    expect((await res2.json()).error).toBe('上游超时');
  });

  it('分类接口失败兜底：ac=list 失败但不阻断视频列表展示', async () => {
    vi.mocked(apiGuard.guardRequest).mockReturnValue(null);
    vi.mocked(ssrf.checkUpstreamAllowed).mockResolvedValue({ ok: true });

    const source = { key: 'vod_7', name: '点播源7', url: 'https://cms7.test.com/api' };

    vi.mocked(fetchUtils.fetchUpstream)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          page: 1,
          pagecount: 1,
          total: 1,
          list: [{ vod_id: 7001, vod_name: '视频' }],
        }),
      } as unknown as Response)
      .mockRejectedValueOnce(new Error('分类接口网络中断'));

    const res = await GET(
      new Request(
        `http://localhost/api/source/home?source=${encodeURIComponent(JSON.stringify(source))}`
      )
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.classes).toEqual([]);
    expect(data.items).toHaveLength(1);
  });
});
