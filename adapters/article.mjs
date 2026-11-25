/**
 * 通用网页文章适配器（兜底）—— 小黑盒 / 百度贴吧 / 公众号 / 任意可 curl 的正文页
 * ----------------------------------------------------------------------------
 * 只做三件事：curl 取 HTML → 去标签取正文 → 抽标题/作者。
 * 明确不做：JS 渲染（curl 拿不到）、需要登录的页面、反爬强的站点。
 *
 * 各站的真实差异写在 parsers 里，逐个补。没补的走 generic：
 *   贴吧  —— 正文是楼层，楼层里就是讨论，comments 置空
 *   小黑盒 —— 正文 SSR 有一部分；评论是 JS 渲染，拿不到
 *   公众号 —— mp.weixin.qq.com 正文在 #js_content，可 curl
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const strip = (html) => {
  let s = String(html || '')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  s = s.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n')
  return s.trim()
}
const pick = (html, re) => { const m = String(html || '').match(re); return m ? strip(m[1]) : '' }
const metaOf = (html, prop) => pick(html, new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)`, 'i'))

const parsers = {
  tieba: {
    test: (u) => /tieba\.baidu\.com\/p\//.test(u),
    body: (h) => pick(h, /<div[^>]+class="[^"]*d_post_content[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || strip(h),
    title: (h) => metaOf(h, 'og:title') || pick(h, /<title>([\s\S]*?)<\/title>/i),
  },
  xiaoheihe: {
    test: (u) => /(xiaoheihe\.cn|heybox\.com|小黑盒)/i.test(u),
    body: (h) => pick(h, /<article[\s\S]*?<\/article>/i) || strip(h),
    title: (h) => metaOf(h, 'og:title') || pick(h, /<title>([\s\S]*?)<\/title>/i),
  },
  wechat: {
    test: (u) => /mp\.weixin\.qq\.com\/s/.test(u),
    body: (h) => pick(h, /<div[^>]+id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<script/i) || strip(h),
    title: (h) => pick(h, /<h1[^>]*class="rich_media_title"[^>]*>([\s\S]*?)<\/h1>/i) || metaOf(h, 'og:title'),
  },
}

export default {
  id: 'article',
  label: '网页文章',
  caps: { transcript: true, timestamps: false, comments: false, needsLogin: false },

  match(url) {
    if (!/^https?:\/\//i.test(url)) return null
    if (/bilibili\.com|b23\.tv|douyin\.com|iesdouyin\.com|xiaohongshu\.com|rednote\.com|xhslink\.cn/i.test(url)) return null
    const id = (url.match(/\/p\/(\d+)/) || url.match(/\/s\/([A-Za-z0-9_-]+)/) || url.match(/([A-Za-z0-9_-]{6,})\/?$/) || [])[1]
    return { id: id || Buffer.from(url).toString('base64url').slice(0, 16), url }
  },

  async fetch(target, { sh }) {
    const warnings = []
    const r = await sh('curl', ['-sL', '--max-time', '40', '-A', UA, target.url], { timeout: 45000 })
    if (r.code !== 0 || !r.stdout) {
      return { source: 'article', source_id: target.id, url: target.url, title: '', author: '', capabilities: { transcript: false }, transcript: { kind: 'none', units: [] }, comments: [], warnings: [`取页失败（${r.code}）：${(r.stderr || '').split('\n')[0] || ''}`] }
    }
    const html = r.stdout
    const p = Object.values(parsers).find((x) => { try { return x.test(target.url) } catch { return false } }) || null
    const title = (p ? p.title(html) : metaOf(html, 'og:title') || pick(html, /<title>([\s\S]*?)<\/title>/i)) || ''
    const body = (p ? p.body(html) : strip(html)) || ''
    const author = metaOf(html, 'author') || pick(html, /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)/i) || ''
    if (body.length < 300) warnings.push(`正文只抽到 ${body.length} 字，可能是 JS 渲染页或反爬拦截`)
    if (!p) warnings.push('这个站还没有专门解析器，正文按通用规则抽的（可能带导航/推荐位噪声）')
    return {
      source: 'article', source_id: target.id, url: target.url,
      title, author, duration_sec: null, published: metaOf(html, 'article:published_time') || null,
      capabilities: { transcript: body.length > 0, timestamps: false, comments: false },
      transcript: { kind: 'article', units: body ? body.split('\n').map((t) => ({ t: null, text: t })).filter((u) => u.text.length > 1) : [] },
      comments: [],
      warnings,
    }
  },
}
