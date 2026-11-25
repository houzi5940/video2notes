/**
 * 小红书适配器 —— 短链展开 → 取 HTML → 解析 __INITIAL_STATE__
 * ----------------------------------------------------------------------------
 * 为什么这么走：小红书是客户端渲染，正文不在 DOM 里，但在页面的
 * `window.__INITIAL_STATE__` 里有一份完整的笔记 JSON（含正文、图片、互动数、评论）。
 * 所以不需要浏览器，curl + 正则抠出来就能用。
 *
 * 已知限制：
 *   · 部分笔记有登录墙，noteData 为空 —— 会明确报错，让你贴正文，不瞎编
 *   · 评论只拿第一页（默认 10 条左右）
 *   · 图片只记数量，内容要靠 VL 看（后续可加）
 */
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const HOSTS = /(^|\.)(xiaohongshu\.com|rednote\.com|xhslink\.cn)$/i

/** 从 HTML 里抠出 __INITIAL_STATE__，返回对象或 null */
export function parseInitialState(html) {
  const m = String(html || '').match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)
  if (!m) return null
  try {
    return JSON.parse(m[1].replace(/\bundefined\b/g, 'null'))
  } catch {
    return null
  }
}

/** 在任意结构里找「像一篇笔记」的对象：有 noteId 且正文/标题至少一个 */
export function findNote(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null
  if (Array.isArray(obj)) {
    for (const v of obj) { const r = findNote(v, depth + 1); if (r) return r }
    return null
  }
  if (obj.noteId && (typeof obj.desc === 'string' || typeof obj.title === 'string')) return obj
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') { const r = findNote(v, depth + 1); if (r) return r }
  }
  return null
}

/** 递归收集评论（形如 {content, userInfo|user}） */
export function collectComments(obj, depth = 0, out = []) {
  if (!obj || typeof obj !== 'object' || depth > 10) return out
  if (Array.isArray(obj)) { for (const v of obj) collectComments(v, depth + 1, out); return out }
  if (typeof obj.content === 'string' && (obj.userInfo || obj.user)) {
    const u = obj.userInfo || obj.user || {}
    out.push({
      author: u.nickname || u.nickName || '',
      uid: u.userId || u.user_id || '',
      text: String(obj.content || '').replace(/\s+/g, ' ').trim(),
      likes: Number(obj.likeCount || obj.likedCount || 0),
      replies: Number(obj.subCommentCount || 0),
      tag: '',
    })
  }
  for (const v of Object.values(obj)) if (v && typeof v === 'object') collectComments(v, depth + 1, out)
  return out
}

const idOf = (url) => {
  const m = String(url).match(/(?:explore|item|discovery\/item)\/([0-9a-f]{24})/i)
  return m ? m[1] : ''
}

export default {
  id: 'xiaohongshu',
  label: '小红书',
  caps: { transcript: true, timestamps: false, comments: true, needsLogin: false },

  match(url) {
    let u
    try { u = new URL(url) } catch { return null }
    if (!HOSTS.test(u.hostname)) return null
    if (/xhslink\.cn$/i.test(u.hostname)) {
      const code = u.pathname.replace(/^\/+/, '').replace(/\//g, '_') || 'short'
      return { id: `short_${code}`, url, short: true }
    }
    const id = idOf(url) || u.pathname.split('/').filter(Boolean).pop() || 'unknown'
    return { id, url }
  },

  async fetch(target, { dir, comments, sh }) {
    const warnings = []
    let url = target.url
    let id = target.id

    // ① 短链展开
    if (target.short) {
      const r = await sh('curl', ['-s', '-o', '/dev/null', '-L', '-A', UA, '--max-time', '25', '-w', '%{url_effective}', url], { timeout: 30000 })
      const fin = (r.stdout || '').trim()
      if (fin && /rednote\.com|xiaohongshu\.com/.test(fin)) {
        url = fin
        id = idOf(fin) || id
      } else {
        warnings.push(`短链展开没拿到笔记地址（${r.code}），按原链接试`)
      }
    }

    // ② 取页面
    const got = await sh('curl', ['-s', '-L', '-A', UA, '--max-time', '30', url], { timeout: 35000 })
    if (got.code !== 0 || !got.stdout) {
      return {
        source: 'xiaohongshu', source_id: id, url, title: '', author: '',
        capabilities: { transcript: false }, transcript: { kind: 'none', units: [] }, comments: [],
        warnings: [`取页面失败（${got.code}）：${(got.stderr || '').split('\n')[0] || '网络问题'}`],
      }
    }
    const html = got.stdout
    try { const f = await import('node:fs'); f.writeFileSync(`${dir}/source.html`, html) } catch { /* 存不下不影响解析 */ }

    const state = parseInitialState(html)
    if (!state) {
      return {
        source: 'xiaohongshu', source_id: id, url, title: '', author: '',
        capabilities: { transcript: false }, transcript: { kind: 'none', units: [] }, comments: [],
        warnings: ['页面里没有 __INITIAL_STATE__（可能是登录墙或改版）⇒ 需要你贴正文，不猜'],
      }
    }

    const note = findNote(state)
    if (!note) {
      return {
        source: 'xiaohongshu', source_id: id, url, title: '', author: '',
        capabilities: { transcript: false }, transcript: { kind: 'none', units: [] }, comments: [],
        warnings: ['页面能取到但里面没有笔记数据（登录墙 / 笔记已删 / 改版）⇒ 需要你贴正文'],
      }
    }

    const user = note.user || note.userInfo || {}
    const ii = note.interactInfo || {}
    const desc = String(note.desc || '').trim()
    const units = desc
      ? desc.split(/\n+/).map((t) => t.trim()).filter((t) => t.length > 1).map((t) => ({ t: null, text: t }))
      : []

    const all = collectComments(state)
    const seen = new Set()
    const cs = all.filter((c) => {
      const k = c.author + '|' + c.text
      if (seen.has(k)) return false
      seen.add(k); return true
    }).slice(0, Math.max(1, Number(comments) || 20))

    if (!desc) warnings.push('正文为空（可能是纯图笔记）')
    if (!cs.length) warnings.push('没取到评论（可能有登录墙，或评论在客户端里）')

    return {
      source: 'xiaohongshu',
      source_id: id,
      url,
      title: String(note.title || desc.slice(0, 30) || ''),
      author: user.nickName || user.nickname || '',
      duration_sec: null,
      published: note.time ? new Date(Number(note.time)).toISOString().slice(0, 10) : null,
      intro: '',
      stat: {
        likes: Number(ii.likedCount || 0),
        collects: Number(ii.collectedCount || 0),
        comments: Number(ii.commentCount || 0),
        shares: Number(ii.shareCount || 0),
        images: (note.imageList || []).length,
      },
      capabilities: { transcript: units.length > 0, timestamps: false, comments: cs.length > 0 },
      transcript: { kind: 'article', units },
      comments: cs,
      comments_meta: { total: Number(ii.commentCount || cs.length), shown: cs.length },
      warnings,
    }
  },
}
