import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cmsRequestHeaders, parseSearchList } from '@/lib/cms-parser';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import type { SearchResultItem, SourceConfig, VodClassItem, VodHomeResponse } from '@/lib/types';

export const runtime = 'nodejs';

/** 首页点播推荐结果短缓存：30 秒，避免同一源高频刷新上游 */
const HOME_CACHE_TTL = 30 * 1000;

/** 分类信息独立长缓存：10 分钟，减少对 ac=list 的重复查询 */
const CLASS_CACHE_TTL = 10 * 60 * 1000;

function parseSource(raw: string | null): SourceConfig | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as SourceConfig;
    if (!obj || typeof obj !== 'object' || !/^https?:\/\//.test(obj.url || '')) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * 解析 Apple CMS 响应中的分类列表
 */
function parseClasses(raw: unknown): VodClassItem[] {
  if (!Array.isArray(raw)) return [];
  const result: VodClassItem[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const id = obj.type_id ?? obj.id;
      const name = obj.type_name ?? obj.name;
      const pid = obj.type_pid ?? obj.pid;
      if (
        (typeof id === 'number' || (typeof id === 'string' && id.trim() !== '')) &&
        typeof name === 'string' &&
        name.trim() !== ''
      ) {
        const entry: VodClassItem = {
          id: typeof id === 'number' ? id : id.trim(),
          name: name.trim(),
        };
        if (typeof pid === 'number' || (typeof pid === 'string' && pid.trim() !== '')) {
          entry.pid = typeof pid === 'number' ? pid : pid.trim();
        }
        result.push(entry);
      }
    }
  }
  return result;
}

/**
 * 点播源首页推荐接口：获取指定采集站的视频列表（支持按分类与分页查询）及分类字典
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const url = new URL(req.url);
  const source = parseSource(url.searchParams.get('source'));
  const typeId = (url.searchParams.get('typeId') || '').trim();
  const pageRaw = parseInt(url.searchParams.get('page') || '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  if (!source) {
    return NextResponse.json({ error: '无效的点播源配置' }, { status: 400 });
  }

  // SSRF 防护校验
  const verdict = await checkUpstreamAllowed(source.url);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: 400 });
  }

  const baseUrl = source.url.replace(/\/+$/, '');
  const homeCacheKey = `source:home:${baseUrl}|${typeId}|${page}`;
  const cachedHome = getCache<VodHomeResponse>(homeCacheKey);
  if (cachedHome) {
    return NextResponse.json(cachedHome);
  }

  const classCacheKey = `source:class:${baseUrl}`;

  try {
    // 1. 向上游采集站请求视频列表
    const queryParams = new URLSearchParams({
      ac: 'videolist',
      pg: String(page),
    });
    if (typeId) {
      queryParams.set('t', typeId);
    }
    const sep = baseUrl.includes('?') ? '&' : '?';
    const videoListUrl = `${baseUrl}${sep}${queryParams.toString()}`;

    const res = await fetchUpstream(videoListUrl, {
      timeoutMs: 8000,
      headers: cmsRequestHeaders(),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `上游请求失败: HTTP ${res.status}` }, { status: 502 });
    }

    const data = await res.json();

    // 2. 提取分类信息：若 videolist 携带 class 则优先使用，否则尝试从内存缓存或 ac=list 中补充
    let classes = parseClasses((data as { class?: unknown })?.class);
    if (classes.length > 0) {
      setCache(classCacheKey, classes, CLASS_CACHE_TTL);
    } else {
      const cachedClasses = getCache<VodClassItem[]>(classCacheKey);
      if (cachedClasses !== undefined) {
        classes = cachedClasses;
      } else {
        try {
          const listRes = await fetchUpstream(`${baseUrl}${sep}ac=list`, {
            timeoutMs: 8000,
            headers: cmsRequestHeaders(),
          });
          if (listRes.ok) {
            const listData = await listRes.json();
            const fetchedClasses = parseClasses((listData as { class?: unknown })?.class);
            classes = fetchedClasses;
            setCache(classCacheKey, classes, CLASS_CACHE_TTL);
          } else {
            setCache(classCacheKey, [], CLASS_CACHE_TTL);
          }
        } catch {
          // XXX: 分类获取失败兜底为空数组，写入缓存防穿透
          classes = [];
          setCache(classCacheKey, [], CLASS_CACHE_TTL);
        }
      }
    }

    // 3. 解析视频项目列表
    let items: SearchResultItem[] = [];
    try {
      items = parseSearchList(data, source);
    } catch {
      // 部分源无数据或格式异常时优雅兜底
      items = [];
    }

    // 4. 解析分页元数据
    const rawPage = Number((data as { page?: unknown })?.page);
    const resPage = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : page;

    const rawPageCount = Number((data as { pagecount?: unknown })?.pagecount);
    const pageCount =
      Number.isFinite(rawPageCount) && rawPageCount >= 0
        ? rawPageCount
        : items.length > 0
          ? 1
          : 0;

    const rawTotal = Number((data as { total?: unknown })?.total);
    const total = Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : items.length;

    const responsePayload: VodHomeResponse = {
      items,
      classes,
      page: resPage,
      pageCount,
      total,
    };

    setCache(homeCacheKey, responsePayload, HOME_CACHE_TTL);
    return NextResponse.json(responsePayload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '获取点播源推荐失败' },
      { status: 502 }
    );
  }
}
