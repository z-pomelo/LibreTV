/**
 * 判断部署者是否通过 DISABLE_STREAM_PROXY 环境变量禁用了媒体流代理。
 *
 * 开启后（DISABLE_STREAM_PROXY=true 或 1）：
 * - 服务端直接拒绝代理 m3u8/分片/直播流，避免消耗服务器流量和带宽；
 * - 仅保留海报/封面等公开图片的防盗链代理（体积小且防止裂图）；
 * - 前端播放器感知后直连失败直接报错或提示换源，不再请求代理回退。
 */
export function isStreamProxyDisabled(): boolean {
  const v = process.env.DISABLE_STREAM_PROXY?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}
