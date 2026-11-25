/**
 * B 站适配器 —— 材料由 dsh-bili-watch 的 CLI 提供（node tools/look.mjs）
 * ----------------------------------------------------------------------------
 * 为什么用它而不是自己打接口：wbi 签名、字幕轨、风控、ASR 幻觉判定、抽帧缓存，
 * 那一堆坑它都踩过了（见 ../tools/dsh-bili-watch 的 tools/look.mjs）。
 * 我们只用它的「取材料」能力，判断与提炼全在我们这边，它坏了好换。
 *
 * 已知限制（2026-11-25 实测）：匿名拉不到 AI 字幕（nav code=-101 账号未登录）。
 *   必须先在 watch 家目录扫码登录一次：node tools/look.mjs login
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { transcribeVideo, buildPrompt, findCachedVideo, omlxStatus } from '../lib/asr.mjs'

const WATCH = process.env.BILI_WATCH_CLI || 'bili-watch'
const BV_RE = /BV[0-9A-Za-z]{10}/
const AV_RE = /(?:^|\/)(av\d+)/i

// BILI_WATCH_CLI 可以是 .mjs 路径（用 node 跑），也可以是 PATH 上的可执行文件（bili-watch）
const running = async (sh, args, timeout = 240000) => {
  if (WATCH.endsWith('.mjs')) {
    if (!existsSync(WATCH)) return { code: 'missing', stdout: '', stderr: `没找到 ${WATCH}` }
    return sh(process.execPath, [WATCH, ...args, '--quiet'], { timeout })
  }
  return sh(WATCH, [...args, '--quiet'], { timeout })
}

/** 短链先展开成真链接，保证 key 稳定（同一条视频走 b23 和 BV 不能算两条） */
async function expand(sh, url) {
  if (!/b23\.tv|bili2233\.cn/i.test(url)) return url
  const r = await sh('curl', ['-sL', '-o', '/dev/null', '-w', '%{url_effective}', '--max-time', '20', url], { timeout: 25000 })
  return (r.stdout || '').trim() || url
}

function parseView(out) {
  const res = { intro: '', title: '', author: '', duration_sec: null, stat: {} }
  const lines = String(out || '').split('\n')
  for (const line of lines) {
    if (line.startsWith('视频: ') && !res.title) res.title = line.slice(4).trim()
    if (line.startsWith('UP: ')) {
      const m = line.match(/^UP:\s*(.+?)(?:\s*\(mid \d+\)|\s{2}时长|$)/)
      if (m) res.author = m[1].trim()
    }
    if (/时长/.test(line)) {
      const dm = line.match(/时长\s*(\d+h)?(\d+)m(\d+)s/)
      if (dm) res.duration_sec = Number((dm[1] || '0h').replace('h', '')) * 3600 + Number(dm[2]) * 60 + Number(dm[3])
      const pm = line.match(/播放\s*(\d+)/); if (pm) res.stat.plays = Number(pm[1])
      const cm = line.match(/评论\s*(\d+)/); if (cm) res.stat.comments = Number(cm[1])
    }
    if (line.startsWith('简介: ')) res.intro = line.slice(4).trim()
  }
  return res
}

function normTime(v) {
  if (v == null) return null
  if (typeof v === 'number') return v > 1e6 ? Math.round(v / 1000) : v
  const s = String(v).trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const mm = s.match(/^(\d+):(\d+)(?::(\d+))?$/)
  if (mm) return mm[3] ? Number(mm[1]) * 3600 + Number(mm[2]) * 60 + Number(mm[3]) : Number(mm[1]) * 60 + Number(mm[2])
  return null
}

/** text --format json 的形状随版本变过，按「找 text 字段 + 就近取时间」容错解析 */
function parseTranscriptJson(out) {
  let j
  try { j = JSON.parse(out) } catch { return [] }
  const units = []
  const seen = new Set()
  const keys = ['text', 'content', 'sentence', 'line', 'body']
  const tkeys = ['t', 'time', 'start', 'from', 'begin', 'ts']
  const walk = (n, depth = 0) => {
    if (!n || depth > 8) return
    if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1))
    if (typeof n !== 'object') return
    let text = null
    for (const k of keys) if (typeof n[k] === 'string' && n[k].trim()) { text = n[k].trim(); break }
    if (text) {
      let t = null
      for (const k of tkeys) if (n[k] != null) { t = normTime(n[k]); break }
      const sig = `${t}|${text}`
      if (!seen.has(sig)) { seen.add(sig); units.push({ t, text }) }
      return
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v, depth + 1)
  }
  walk(j)
  return units
}

export default {
  id: 'bilibili',
  label: 'B 站',
  caps: { transcript: true, timestamps: true, comments: true, needsLogin: true },

  match(url) {
    const bv = url.match(BV_RE)
    if (bv) return { id: bv[0], url: `https://www.bilibili.com/video/${bv[0]}` }
    if (/b23\.tv|bili2233\.cn/i.test(url)) {
      const h = (url.match(/(?:b23\.tv|bili2233\.cn)\/([A-Za-z0-9]+)/) || [])[1]
      if (h) return { id: `b23_${h}`, url, short: true }
    }
    const av = url.match(AV_RE)
    if (av) return { id: av[1].toLowerCase(), url }
    return null
  },

  async fetch(target, opts) {
    const { dir, maxMin, comments, sh } = opts
    const warnings = []
    let url = target.url
    let id = target.id
    if (target.short) {
      url = await expand(sh, target.url)
      const bv = url.match(BV_RE)
      if (bv) id = bv[0]
      else warnings.push(`短链展开没拿到 BV，按 ${id} 处理`)
    }
    const tgt = id.startsWith('BV') || id.startsWith('av') ? id : url

    // ① 元数据 + 简介
    const v = await running(sh, ['view', tgt], 90000)
    const meta = parseView(v.stdout)
    if (v.code !== 0 && !meta.title) warnings.push(`view 失败：${v.stderr.split('\n')[0] || v.code}`)

    // ② 评论（JSON，匿名可用）
    let items = []
    let total = null
    const c = await running(sh, ['comments', tgt, String(comments || 20), '--format', 'json'], 120000)
    try {
      const cj = JSON.parse(c.stdout)
      items = (cj.items || []).map((x) => ({
        author: x.uname, uid: x.mid, text: String(x.message || '').replace(/\s+/g, ' ').trim(),
        likes: Number(x.like) || 0, replies: Number(x.rcount) || 0, tag: x.tag || '',
      })).filter((x) => x.text)
      total = cj.total ?? null
      // view 的文本格式会变；comments 的 json 里有 video 三元组，当兜底更稳
      const vj = cj.video || {}
      if (!meta.title && vj.title) meta.title = String(vj.title)
      if (!meta.author && vj.up) meta.author = String(vj.up)
      if (!meta.duration_sec && vj.dur) meta.duration_sec = Number(vj.dur)
    } catch {
      warnings.push(`评论没拿到（${(c.stderr || '').split('\n')[0] || c.code}）`)
    }

    // ③ 正文：字幕优先，取不到才是 ASR / OCR
    let transcript = { kind: 'none', units: [] }
    const dur = meta.duration_sec ?? 0
    if (dur && maxMin && dur > maxMin * 60) {
      warnings.push(`时长 ${Math.round(dur / 60)} 分钟超过上限 ${maxMin} 分钟，本次不取正文（确实要取加 --allow-long）`)
    } else {
      const t = await running(sh, ['text', tgt, '--format', 'json', '--full'], 900000)
      const units = parseTranscriptJson(t.stdout)
      if (units.length) {
        const kind = /字幕/.test(t.stderr) && /miss/.test(t.stderr) ? 'asr' : 'subtitle'
        transcript = { kind, units }
        if (/miss|转写/.test(t.stderr)) {
          for (const line of t.stderr.split('\n')) if (/字幕|转写|OCR/.test(line) && /\[track\]/.test(line)) warnings.push(line.replace(/^\[track\]\s*/, ''))
        }
      } else {
        const why = (t.stderr || '').split('\n').filter((l) => /\[track\]/.test(l)).slice(-3).map((l) => l.replace(/^\[track\]\s*/, ''))
        warnings.push(...(why.length ? why : [`正文没拿到（${t.code}）`]))
        transcript = { kind: 'none', units: [], reason: why.join('；') }
      }

      // ⭐ 字幕拿不到时走 oMLX 本地转写（方案 A 的第二条腿，不依赖 B 站登录）
      if (transcript.kind === 'none' && opts.asr !== false) {
        const st = await omlxStatus()
        if (!st.ok) {
          warnings.push(`本地转写跳过：${st.reason}`)
        } else {
          let vid = findCachedVideo(id)
          if (!vid) {
            // watch 的 frames 会顺带把 360p 视频下下来；step 给大值只为要那份文件
            await running(sh, ['frames', tgt, '--step', '999999'], 600000)
            vid = findCachedVideo(id)
          }
          if (!vid) {
            warnings.push('本地转写跳过：没有本地视频文件（下载失败）')
          } else {
            const r = await transcribeVideo(vid.file, {
              durationSec: meta.duration_sec,
              prompt: buildPrompt({ title: meta.title, intro: meta.intro, keywords: opts.keywords }),
              workDir: dir,
              log: (m) => warnings.push('[asr] ' + m),
            })
            warnings.push(...r.warnings)
            if (r.kind === 'asr') transcript = { kind: 'asr', units: r.units }
          }
        }
      }
    }

    return {
      source: 'bilibili', source_id: id, url,
      title: meta.title || '', author: meta.author || '', duration_sec: dur || null,
      published: null, intro: meta.intro || '', stat: meta.stat || {},
      capabilities: { transcript: transcript.kind !== 'none', timestamps: true, comments: true },
      transcript, comments: items,
      comments_meta: { total, shown: items.length, requested: comments || 20 },
      warnings,
    }
  },
}
