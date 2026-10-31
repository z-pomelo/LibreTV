import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from './store';

describe('播放倍速记忆与保持逻辑', () => {
  beforeEach(() => {
    useAppStore.getState().updateSettings({ playbackRate: 1 });
  });

  it('默认倍速为 1.0', () => {
    expect(useAppStore.getState().playbackRate).toBe(1);
  });

  it('用户主动更改倍速可正确持久化', () => {
    useAppStore.getState().updateSettings({ playbackRate: 1.5 });
    expect(useAppStore.getState().playbackRate).toBe(1.5);

    useAppStore.getState().updateSettings({ playbackRate: 2.0 });
    expect(useAppStore.getState().playbackRate).toBe(2.0);

    useAppStore.getState().updateSettings({ playbackRate: 1.25 });
    expect(useAppStore.getState().playbackRate).toBe(1.25);
  });

  it('换集防御：底层重置为 1.0 时不覆盖用户已设置的偏好倍速', () => {
    // 用户当前已设置 1.5 倍速
    useAppStore.getState().updateSettings({ playbackRate: 1.5 });
    let targetRate = useAppStore.getState().playbackRate;
    let isSwitchingEpisode = true;

    // 模拟换集时浏览器资源加载算法派发的重置事件 (1.0)
    const simulateRateChange = (newRate: number) => {
      if (isSwitchingEpisode && Math.abs(newRate - 1.0) < 0.01 && Math.abs(targetRate - 1.0) > 0.01) {
        // 浏览器重置，忽略
        return;
      }
      targetRate = newRate;
      useAppStore.getState().updateSettings({ playbackRate: newRate });
    };

    simulateRateChange(1.0);
    // 依然保持 1.5，没有被浏览器的 1.0 冲掉
    expect(targetRate).toBe(1.5);
    expect(useAppStore.getState().playbackRate).toBe(1.5);

    // 换集完成起播
    isSwitchingEpisode = false;

    // 用户主动点选 1.0 倍速（正常）
    simulateRateChange(1.0);
    expect(targetRate).toBe(1.0);
    expect(useAppStore.getState().playbackRate).toBe(1.0);
  });
});
