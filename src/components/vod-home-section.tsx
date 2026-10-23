'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { SourceConfig, VodHomeResponse } from '@/lib/types';
import { Dropdown, type DropdownOption } from './dropdown';
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
  const setSelectedRecommendVodKey = useAppStore((s) => s.setSelectedRecommendVodKey);

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

  // 2. 当前选中的源
  const activeSource = useMemo(() => {
    if (activeSources.length === 0) return undefined;
    if (selectedRecommendVodKey) {
      const found = activeSources.find((s) => s.key === selectedRecommendVodKey);
      if (found) return found;
    }
    return activeSources[0];
  }, [activeSources, selectedRecommendVodKey]);

  // 3. 内部状态：分类与页码
  const [typeId, setTypeId] = useState<string | number | undefined>(undefined);
  const [page, setPage] = useState<number>(1);
  const [accumulatedItems, setAccumulatedItems] = useState<NormalizedVodItem[]>([]);
  const [classes, setClasses] = useState<NormalizedVodClass[]>([]);

  // 外部或内部导致当前激活源变更时同步重置
  const activeSourceKey = activeSource?.key;
  useEffect(() => {
    setTypeId(undefined);
    setPage(1);
    setAccumulatedItems([]);
    setClasses([]);
  }, [activeSourceKey]);

  // 源切换时重置分类、页码与列表
  const handleSelectSource = (newKey: string) => {
    if (newKey === activeSource?.key) return;
    setSelectedRecommendVodKey(newKey);
    setTypeId(undefined);
    setPage(1);
    setAccumulatedItems([]);
    setClasses([]);
  };

  // 分类切换时重置页码为 1
  const handleSelectType = (newTypeId: string | number | undefined) => {
    if (newTypeId === typeId) return;
    setTypeId(newTypeId);
    setPage(1);
    setAccumulatedItems([]);
  };

  // 4. 数据拉取
  const query = useQuery({
    queryKey: ['vod-home', activeSource?.key, typeId ?? 'all', page],
    queryFn: ({ signal }) => {
      if (!activeSource) return Promise.reject(new Error('未找到可用点播源'));
      return fetchSourceHome(activeSource, { typeId, page }, signal);
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
        if (id !== undefined && name) {
          const trimmedName = String(name).trim();
          if (!yellowFilter || !isAdultContent(trimmedName)) {
            normalizedClasses.push({ id: String(id), name: trimmedName });
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
      setAccumulatedItems(normalized);
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

  // 下拉选项
  const sourceOptions: DropdownOption[] = activeSources.map((s) => ({
    value: s.key,
    label: s.name || s.key,
    hint: s.url,
  }));

  return (
    <section aria-label="点播源首页推荐">
      {/* 顶部工具条 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted font-medium shrink-0">点播源：</span>
          <Dropdown
            value={activeSource.key}
            onChange={handleSelectSource}
            options={sourceOptions}
            ariaLabel="切换点播源"
            className="w-48 sm:w-56"
          />
        </div>
      </div>

      {/* 分类 Chips */}
      {classes.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 mb-4 scrollbar-none">
          <button
            type="button"
            className={cn(
              'px-2.5 py-1 rounded-full text-xs transition-colors shrink-0',
              typeId === undefined
                ? 'bg-accent text-on-accent'
                : 'bg-chip text-muted hover:text-content hover:bg-hover'
            )}
            onClick={() => handleSelectType(undefined)}
            aria-pressed={typeId === undefined}
          >
            全部
          </button>
          {classes.map((c) => {
            const isSelected = typeId !== undefined && String(typeId) === c.id;
            return (
              <button
                key={c.id}
                type="button"
                className={cn(
                  'px-2.5 py-1 rounded-full text-xs transition-colors shrink-0',
                  isSelected
                    ? 'bg-accent text-on-accent'
                    : 'bg-chip text-muted hover:text-content hover:bg-hover'
                )}
                onClick={() => handleSelectType(c.id)}
                aria-pressed={isSelected}
              >
                {c.name}
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
              <VodItemCard key={item.id} item={item} onClick={() => onPick(item.name)} />
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
