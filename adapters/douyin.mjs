/**
 * 抖音适配器 —— 占位：先认链接、明确告诉你缺什么，不假装能用。
 * ----------------------------------------------------------------------------
 * 抖音没有字幕轨可拉，必须：分享链接 → yt-dlp 下音轨 → 本地 ASR。
 * 本机当前缺 yt-dlp（command -v yt-dlp 为空），ASR 环境也没装。
 * 要启用：
 *   brew install yt-dlp
 *   node ~/.hermes/tools/dsh-bili-watch/scripts/fetch-deps.mjs asr
 * 装完把下面 fetch 里的 TODO 换成真实现（yt-dlp -f bestaudio -o <dir>/audio.m4a <url>
 *   → ffmpeg 转 wav → watch 的 _bili-asr.py 转写）。
 * 抖音分享链接常带短链（v.douyin.com/xxxx），需要先跟一次 301 拿真实 URL。
 */
export default {
  id: 'douyin',
  label: '抖音',
  caps: { transcript: false, timestamps: false, comments: false, needsLogin: true },

  match(url) {
    if (!/douyin\.com|iesdouyin\.com/i.test(url)) return null
    const id = (url.match(/\/video\/(\d+)/) || url.match(/modal_id=(\d+)/) || url.match(/v\.douyin\.com\/([A-Za-z0-9]+)/) || [])[1]
    return { id: id || 'unknown', url }
  },

  async fetch(target) {
    return {
      source: 'douyin', source_id: target.id, url: target.url,
      title: '', author: '', capabilities: { transcript: false },
      transcript: { kind: 'none', units: [] }, comments: [],
      warnings: [
        '抖音适配器还没实现：抖音没有字幕轨，必须下载音轨 + 本地 ASR',
        '缺 yt-dlp（brew install yt-dlp）和 ASR 环境（fetch-deps.mjs asr）',
        '装好后这条链接可以直接复用同一套材料包格式，不需要改下游',
      ],
    }
  },
}
