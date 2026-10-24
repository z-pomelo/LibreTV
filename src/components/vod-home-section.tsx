'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { SourceConfig, VodHomeResponse } from '@/lib/types';
import { SmartImage } from './smart-image';
import { EmptyState, ErrorState, Spinner } from './states';
import { isAdultContent } from '@/lib/cms-parser';

interface NormalizedVodItem {
  id: string;
  name: string;
  pic?: string;
  remarks?: string;
}

interface NormalizedVodClass {
  id: string;
  name: string;
  pid?: string;
}

const VOD_SESSION_KEY = 'libretv-vod-home-memory';

export interface VodHomeSessionMemory {
  sourceKey: string;
  parentId?: string;
  subId?: string;
  page: number;
  items: NormalizedVodItem[];
  classes: NormalizedVodClass[];
  scrollY: number;
  lastClickedId?: string;
}

let vodMemoryFallback: VodHomeSessionMemory | null = null;

export function getVodHomeMemory(): VodHomeSessionMemory | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(VOD_SESSION_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return vodMemoryFallback;
}

export function setVodHomeMemory(mem: VodHomeSessionMemory | null) {
  vodMemoryFallback = mem;
  if (typeof window === 'undefined') return;
  try {
    if (mem) {
      sessionStorage.setItem(VOD_SESSION_KEY, JSON.stringify(mem));
    } else {
      sessionStorage.removeItem(VOD_SESSION_KEY);
    }
  } catch {}
}

/** 统一调用点播源首页数据，优先使用 api.sourceHome */
async function fetchSourceHome(
  source: SourceConfig,
  params: { typeId?: number | string; page?: number },
  signal?: AbortSignal
): Promise<VodHomeResponse> {
  return api.sourceHome(source, params, signal);
}

/** 首页点播源推荐区 */
export function VodHomeView({ onPick }: { onPick: (title: string) => void }) {
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const selectedRecommendVodKey = useAppStore((s) => s.selectedRecommendVodKey);

  // 1. 获取所有可用点播源（过滤成人内容）
  const allAvailableSources = useMemo(() => {
    const map = new Map<string, SourceConfig>();
    for (const s of envSources) map.set(s.key, s);
    for (const s of customAPIs) map.set(s.key, s);
    let list = Array.from(map.values());
    if (yellowFilter) {
      list = list.filter((s) => !s.isAdult);
    }
    return list;
  }, [envSources, customAPIs, yellowFilter]);

  // 优先选取在 selectedKeys 中的源；若均未选中，则退回至全部可用源
  const activeSources = useMemo(() => {
    const selected = allAvailableSources.filter((s) => selectedKeys.includes(s.key));
    return selected.length > 0 ? selected : allAvailableSources;
  }, [allAvailableSources, selectedKeys]);

  // 2. 当前激活的点播源（由设置中的 selectedRecommendVodKey 决定）
  const activeSource = useMemo(() => {
    if (activeSources.length === 0) return undefined;
    if (selectedRecommendVodKey) {
      const found = activeSources.find((s) => s.key === selectedRecommendVodKey);
      if (found) return found;
    }
    return activeSources[0];
  }, [activeSources, selectedRecommendVodKey]);

  const activeSourceKey = activeSource?.key;

  // 3. 内部状态：在组件创建时直接从 session 记忆中同步初始化（避免二次 render 导致 items 被截断）
  const initialMem = useMemo(() => {
    const m = getVodHomeMemory();
    if (!m) return null;
    if (!activeSourceKey || m.sourceKey === activeSourceKey) return m;
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSourceKey]);

  const [selectedParentId, setSelectedParentId] = useState<string | undefined>(
    () => initialMem?.parentId
  );
  const [selectedSubId, setSelectedSubId] = useState<string | undefined>(
    () => initialMem?.subId
  );
  const [page, setPage] = useState<number>(() => initialMem?.page ?? 1);
  const [accumulatedItems, setAccumulatedItems] = useState<NormalizedVodItem[]>(
    () => initialMem?.items ?? []
  );
  const [classes, setClasses] = useState<NormalizedVodClass[]>(
    () => initialMem?.classes ?? []
  );

  const prevSourceKeyRef = useRef<string | undefined>(activeSourceKey);

  // 外部或内部导致当前激活源变更时同步重置（仅在确定从一个真实源切换到另一个真实源时重置）
  useEffect(() => {
    if (!activeSourceKey) return;
    if (prevSourceKeyRef.current && prevSourceKeyRef.current !== activeSourceKey) {
      setVodHomeMemory(null);
      setSelectedParentId(undefined);
      setSelectedSubId(undefined);
      setPage(1);
      setAccumulatedItems([]);
      setClasses([]);
    }
    prevSourceKeyRef.current = activeSourceKey;
  }, [activeSourceKey]);

  // 恢复之前的滚动条高度与卡片焦点（精准定位至点击的最后一部影片，不再漂移到中间）
  const hasRestoredScrollRef = useRef(false);
  useEffect(() => {
    if (hasRestoredScrollRef.current) return;
    const mem = getVodHomeMemory();
    if (!mem || mem.sourceKey !== activeSourceKey || accumulatedItems.length === 0) return;

    hasRestoredScrollRef.current = true;

    const doScroll = () => {
      if (mem.lastClickedId) {
        const targetEl = document.getElementById(`vod-card-${mem.lastClickedId}`);
        if (targetEl) {
          targetEl.scrollIntoView({ block: 'center', behavior: 'instant' });
          targetEl.focus?.({ preventScroll: true });
          return;
        }
      }
      if (mem.scrollY > 0) {
        window.scrollTo({ top: mem.scrollY, behavior: 'instant' });
      }
    };

    doScroll();
    // 双重保障：等待 DOM 布局稳定后再次校准，防止图片撑开后漂移
    const timer1 = setTimeout(doScroll, 80);
    const timer2 = setTimeout(doScroll, 250);
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [activeSourceKey, accumulatedItems.length]);

  // 4. 解析分类层级（一级大类与二级细分子类）
  const { rootClasses, childMap } = useMemo(() => {
    const classIdSet = new Set(classes.map((c) => c.id));
    // 找出所有有效子分类（其 pid 对应 classes 中存在的一级父类）
    const validChildren = classes.filter(
      (c) => c.pid && c.pid !== '0' && c.pid !== c.id && classIdSet.has(c.pid)
    );

    if (validChildren.length === 0) {
      return {
        rootClasses: classes,
        childMap: new Map<string, NormalizedVodClass[]>(),
      };
    }

    const childMap = new Map<string, NormalizedVodClass[]>();
    for (const child of validChildren) {
      const p = child.pid!;
      const list = childMap.get(p) ?? [];
      list.push(child);
      childMap.set(p, list);
    }

    // 一级大类：本身不是子分类的所有分类
    const childIdSet = new Set(validChildren.map((c) => c.id));
    const roots = classes.filter((c) => !childIdSet.has(c.id));

    return {
      rootClasses: roots,
      childMap,
    };
  }, [classes]);

  // 当前选中一级分类下的二级子类列表
  const currentSubClasses = useMemo(() => {
    if (!selectedParentId) return [];
    return childMap.get(selectedParentId) ?? [];
  }, [selectedParentId, childMap]);

  // 5. 方案一：计算发送给 API 的有效 typeId
  const effectiveTypeId = useMemo(() => {
    if (!selectedParentId) return undefined;
    // 有选中具体二级子类，传子类 ID
    if (selectedSubId) return selectedSubId;
    // 无二级子类的独立分类，直接传本身 ID
    return selectedParentId;
  }, [selectedParentId, selectedSubId]);

  // 切换一级分类（方案一：自动选中并高亮该大类的第一个细分子类）
  const handleSelectParent = (newParentId?: string) => {
    if (newParentId === selectedParentId) return;

    if (!newParentId) {
      // 选中顶层「全部」
      setSelectedParentId(undefined);
      setSelectedSubId(undefined);
    } else {
      setSelectedParentId(newParentId);
      const subList = childMap.get(newParentId);
      if (subList && subList.length > 0) {
        // 自动激活该大类的第一个有效子分类（例如动作片、国产剧）
        setSelectedSubId(subList[0].id);
      } else {
        setSelectedSubId(undefined);
      }
    }
    setPage(1);
    setAccumulatedItems([]);
    setVodHomeMemory(null);
  };

  // 切换二级分类
  const handleSelectSub = (newSubId: string) => {
    if (newSubId === selectedSubId) return;
    setSelectedSubId(newSubId);
    setPage(1);
    setAccumulatedItems([]);
    setVodHomeMemory(null);
  };

  // 6. 数据拉取
  const query = useQuery({
    queryKey: ['vod-home', activeSource?.key, effectiveTypeId ?? 'all', page],
    queryFn: ({ signal }) => {
      if (!activeSource) return Promise.reject(new Error('未找到可用点播源'));
      return fetchSourceHome(activeSource, { typeId: effectiveTypeId, page }, signal);
    },
    enabled: !!activeSource,
    staleTime: 5 * 60 * 1000,
  });

  // 处理返回数据（分类提取与条目追加/去重）
  useEffect(() => {
    if (!query.data) return;

    // 提取并归一化 classes
    const rawClasses = query.data.classes ?? [];
    if (rawClasses.length > 0) {
      const normalizedClasses: NormalizedVodClass[] = [];
      for (const c of rawClasses) {
        const id = c.id;
        const name = c.name;
        const pid = c.pid !== undefined ? String(c.pid) : undefined;
        if (id !== undefined && name) {
          const trimmedName = String(name).trim();
          if (!yellowFilter || !isAdultContent(trimmedName)) {
            normalizedClasses.push({ id: String(id), name: trimmedName, pid });
          }
        }
      }

      if (normalizedClasses.length > 0) {
        setClasses(normalizedClasses);
      }
    }

    // 提取并归一化条目列表
    const rawItems = query.data.items ?? [];
    const normalized: NormalizedVodItem[] = [];
    const seenInPage = new Set<string>();
    for (const item of rawItems) {
      if (yellowFilter && (isAdultContent(item.typeName) || isAdultContent(item.name))) continue;
      const id = String(item.vodId || item.name || '');
      const name = item.name ? String(item.name).trim() : '';
      if (name && !seenInPage.has(id)) {
        seenInPage.add(id);
        normalized.push({
          id,
          name,
          pic: item.pic,
          remarks: item.remarks,
        });
      }
    }

    if (page === 1) {
      setAccumulatedItems((prev) => (prev.length > normalized.length ? prev : normalized));
    } else {
      setAccumulatedItems((prev) => {
        const existingIds = new Set(prev.map((i) => i.id));
        const nonDuplicate = normalized.filter((i) => !existingIds.has(i.id));
        return [...prev, ...nonDuplicate];
      });
    }
  }, [query.data, page, yellowFilter]);

  // 计算总页数
  const pageCount = query.data?.pageCount ?? 1;
  const hasMore = page < pageCount;

  // 无源时展示友好空状态
  if (!activeSource || activeSources.length === 0) {
    return (
      <section aria-label="点播源推荐" className="py-8">
        <EmptyState
          icon="link"
          title="暂无可用的点播源"
          description="当前未配置或未启用任何点播源，请在设置中添加点播源或导入数据源订阅。"
        />
      </section>
    );
  }

  const handleItemPick = (item: NormalizedVodItem) => {
    if (activeSourceKey && typeof window !== 'undefined') {
      setVodHomeMemory({
        sourceKey: activeSourceKey,
        parentId: selectedParentId,
        subId: selectedSubId,
        page,
        items: accumulatedItems,
        classes,
        scrollY: window.scrollY,
        lastClickedId: item.id,
      });
    }
    onPick(item.name);
  };

  return (
    <section aria-label="点播源首页推荐">
      {/* 顶部源信息标识 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5 text-xs text-muted font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-accent" />
          <span>{activeSource.name || activeSource.key}</span>
        </div>
      </div>

      {/* 一级分类 Pills */}
      {rootClasses.length > 0 && (
        <div
          className={cn(
            'flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none',
            currentSubClasses.length > 0 ? 'mb-2.5' : 'mb-4'
          )}
        >
          <button
            type="button"
            className={cn(
              'px-3.5 py-1.5 rounded-full text-xs font-medium transition-all shrink-0',
              selectedParentId === undefined
                ? 'bg-accent text-on-accent shadow-xs'
                : 'bg-chip text-muted hover:text-content hover:bg-hover'
            )}
            onClick={() => handleSelectParent(undefined)}
            aria-pressed={selectedParentId === undefined}
          >
            全部
          </button>
          {rootClasses.map((c) => {
            const isSelected = selectedParentId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                className={cn(
                  'px-3.5 py-1.5 rounded-full text-xs font-medium transition-all shrink-0',
                  isSelected
                    ? 'bg-accent text-on-accent shadow-xs'
                    : 'bg-chip text-muted hover:text-content hover:bg-hover'
                )}
                onClick={() => handleSelectParent(c.id)}
                aria-pressed={isSelected}
              >
                {c.name}
              </button>
            );
          })}
        </div>
      )}

      {/* 二级细分子类 Chips（优雅次级导航胶囊） */}
      {currentSubClasses.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto pb-1 mb-4 scrollbar-none p-1 bg-chip/40 rounded-xl border border-line/30">
          {currentSubClasses.map((sub) => {
            const isSelected = selectedSubId === sub.id;
            return (
              <button
                key={sub.id}
                type="button"
                className={cn(
                  'px-3 py-1 rounded-lg text-xs transition-all shrink-0',
                  isSelected
                    ? 'bg-accent text-on-accent font-medium shadow-xs'
                    : 'text-muted hover:text-content hover:bg-hover/60'
                )}
                onClick={() => handleSelectSub(sub.id)}
                aria-pressed={isSelected}
              >
                {sub.name}
              </button>
            );
          })}
        </div>
      )}

      {/* 内容主体 */}
      {query.isError && accumulatedItems.length === 0 ? (
        <ErrorState
          message="点播源推荐内容加载失败，请检查网络或更换源"
          onRetry={() => query.refetch()}
        />
      ) : query.isLoading && accumulatedItems.length === 0 ? (
        <GridSkeleton />
      ) : accumulatedItems.length === 0 ? (
        <p className="text-center text-sm text-faint py-8">该分类暂无推荐内容</p>
      ) : (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
            {accumulatedItems.map((item) => (
              <VodItemCard key={item.id} item={item} onClick={() => handleItemPick(item)} />
            ))}
          </div>

          {/* 加载更多 */}
          {hasMore && (
            <div className="flex justify-center mt-6">
              <button
                type="button"
                disabled={query.isFetching}
                onClick={() => setPage((p) => p + 1)}
                className="btn-ghost px-5 py-2 text-xs sm:text-sm flex items-center gap-2 rounded-full border border-line hover:border-accent hover:text-accent transition-all disabled:opacity-60"
              >
                {query.isFetching ? (
                  <>
                    <Spinner size="sm" />
                    <span>正在加载...</span>
                  </>
                ) : (
                  <span>加载更多</span>
                )}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** 点播源单卡片 */
function VodItemCard({ item, onClick }: { item: NormalizedVodItem; onClick: () => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => setImgFailed(false), [item.pic]);

  return (
    <div
      id={`vod-card-${item.id}`}
      className="card cursor-pointer hover:scale-[1.03] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      aria-label={`搜索 ${item.name}`}
    >
      <div className="relative aspect-[2/3] bg-chip">
        {item.pic && !imgFailed ? (
          <SmartImage
            url={item.pic}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={item.name}
            className="w-full h-full object-cover"
            onExhausted={() => setImgFailed(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-chip">
            <svg
              className="w-8 h-8 text-faint"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z"
              />
            </svg>
          </div>
        )}
        {item.remarks && (
          <span className="absolute bottom-1.5 right-1.5 max-w-[90%] truncate tag bg-black/70 text-rating font-medium text-[10px] px-1.5 py-0.5">
            {item.remarks}
          </span>
        )}
      </div>
      <div className="p-2">
        <div className="text-xs font-medium text-content truncate" title={item.name}>
          {item.name}
        </div>
      </div>
    </div>
  );
}

/** 加载骨架屏 */
function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] rounded-lg bg-chip animate-pulse" />
          <div className="h-3 mt-2 rounded bg-chip animate-pulse" />
        </div>
      ))}
    </div>
  );
}
