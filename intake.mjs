#!/usr/bin/env node
/**
 * video-intake —— 把一条链接变成「可提炼的材料包」
 * ============================================================================
 * 只做第一层：认平台 → 取材料（正文/字幕 + 元数据 + 评论）→ 落盘 + 记账。
 * 提炼、补丁、写 Obsidian 都不在这里（那是 agent 的活），见 README。
 *
 * 用法：
 *   node intake.mjs <url|BV号> [--comments 20] [--max-min 60] [--force] [--json]
 *   node intake.mjs --list                 # 看台账
 *   node intake.mjs --show <key>           # 看某条的材料包
 *
 * 输出：$DATA/<source>-<id>/  下 material.json / transcript.txt / comments.json / meta.json
 * 台账：$DATA/ledger.jsonl（同一 key 第二次进来默认不重复抓，除非 --force）
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, statSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adapters } from './adapters/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DATA = process.env.VIDEO_INTAKE_DATA || join(dirname(fileURLToPath(import.meta.url)), 'data')
const LEDGER = join(DATA, 'ledger.jsonl')

export function sh(cmd, args, { timeout = 120000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.killed ? 'timeout' : (err.code ?? 1)) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

export const readLedger = () => {
  try {
    return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
export const ledgerFind = (key) => readLedger().filter((r) => r.key === key).pop() || null
export const ledgerPush = (rec) => {
  mkdirSync(DATA, { recursive: true })
  appendFileSync(LEDGER, JSON.stringify(rec) + '\n', 'utf8')
}

const fmtDur = (s) => {
  const n = Number(s) || 0
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), ss = n % 60
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(ss).padStart(2, '0')}s`
}

export async function intake(rawUrl, opts = {}) {
  const maxMin = Number(opts.maxMin ?? 60)
  const wantComments = Number(opts.comments ?? 20)
  const url = String(rawUrl || '').trim()
  if (!url) throw new Error('没给链接')

  const adapter = adapters.find((a) => { try { return a.match(url) } catch { return false } })
  if (!adapter) {
    return {
      ok: false,
      error: 'no_adapter',
      hint: '还没有这个平台的适配器。现在能用：bilibili / 网页文章（小黑盒、贴吧、公众号等）/ douyin（待装 yt-dlp）。新平台只要加一个 adapters/*.mjs，match() + fetch() 两个函数。',
      tried: adapters.map((a) => a.id),
    }
  }

  const target = adapter.match(url)
  let key = `${adapter.id}:${target.id}`
  const prior = ledgerFind(key)
  if (prior && !opts.force) {
    return { ok: true, duplicate: true, key, dir: prior.dir, title: prior.title, note: '这条之前抓过，直接用材料包（要重抓加 --force）' }
  }

  const tmpDir = join(DATA, `${adapter.id}-${target.id}`)
  mkdirSync(tmpDir, { recursive: true })

  const t0 = Date.now()
  const material = await adapter.fetch(target, {
    dir: tmpDir, maxMin, comments: wantComments, sh,
    keywords: opts.keywords || [],
    asr: opts.asr !== false,
  })

  // ⭐ 短链的 id 是短码，真 id 要等 fetch 展开后才知道（小红书 / b23.tv 都是这样）。
  //    展开后把目录改成正名，否则同一个东西从短链和长链进来会变成两份。
  let dir = tmpDir
  let finalKey = key
  const realId = String(material.source_id || '').trim()
  if (realId && realId !== String(target.id)) {
    const realDir = join(DATA, `${adapter.id}-${realId}`)
    finalKey = `${adapter.id}:${realId}`
    if (existsSync(join(realDir, 'material.json')) && !opts.force) {
      rmSync(tmpDir, { recursive: true, force: true })
      const prev = ledgerFind(finalKey)
      return { ok: true, duplicate: true, key: finalKey, dir: realDir, title: material.title, note: '这条之前抓过（按展开后的真 id 认出来的），直接用材料包' }
    }
    mkdirSync(realDir, { recursive: true })
    for (const f of readdirSync(tmpDir)) renameSync(join(tmpDir, f), join(realDir, f))
    rmSync(tmpDir, { recursive: true, force: true })
    dir = realDir
  }
  key = finalKey
  material.schema = 1
  material.fetched_at = new Date().toISOString()
  material.key = key
  material.dir = dir
  material.elapsed_ms = Date.now() - t0

  // 落盘：正文单独一份（agent 按块读，不整篇塞上下文）
  const txFile = join(dir, 'transcript.txt')
  if (material.transcript?.units?.length) {
    const lines = material.transcript.units.map((u) => (u.t != null ? `[${Math.floor(u.t / 60)}:${String(Math.floor(u.t % 60)).padStart(2, '0')}] ${u.text}` : u.text))
    writeFileSync(txFile, lines.join('\n') + '\n', 'utf8')
    material.transcript.text_file = txFile
    material.transcript.chars = lines.join('\n').length
  } else {
    delete material.transcript.text_file
  }
  if (material.comments?.length) writeFileSync(join(dir, 'comments.json'), JSON.stringify(material.comments, null, 2), 'utf8')
  writeFileSync(join(dir, 'material.json'), JSON.stringify(material, null, 2), 'utf8')

  ledgerPush({
    key, url, source: adapter.id, id: material.source_id || target.id, title: material.title || '',
    author: material.author || '', duration_sec: material.duration_sec ?? null,
    dir, fetched_at: material.fetched_at,
    transcript_kind: material.transcript?.kind || 'none',
    comments: material.comments?.length || 0,
    warnings: material.warnings || [],
  })

  return { ok: true, key, dir, material }
}

/* ── CLI ────────────────────────────────────────────────────────────────── */
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
  const has = (n) => argv.includes(n)
  const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--force'))

  if (has('--list') || argv.length === 0) {
    const rows = readLedger()
    if (!rows.length) { console.log(`台账是空的。用 node intake.mjs <url> 抓第一条。`); process.exit(0) }
    for (const r of rows.slice(-40)) {
      console.log(`${r.key}\t${r.transcript_kind}\t${r.comments}评\t${fmtDur(r.duration_sec)}\t${r.title}`)
    }
    console.log(`\n共 ${rows.length} 条 · 数据在 ${DATA}`)
    process.exit(0)
  }
  if (has('--show')) {
    const k = flag('--show')
    const r = ledgerFind(k)
    if (!r) { console.error(`台账里没有 ${k}`); process.exit(1) }
    console.log(JSON.stringify(r, null, 2)); process.exit(0)
  }

  const url = pos[0]
  try {
    const r = await intake(url, {
      comments: flag('--comments', 20),
      maxMin: flag('--max-min', 60),
      keywords: String(flag('--kw', '') || '').split(',').map((s) => s.trim()).filter(Boolean),
      asr: !has('--no-asr'),
      force: has('--force'),
    })
    if (has('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 2) }
    if (!r.ok) {
      console.error(`✗ ${r.error}\n${r.hint || ''}`)
      if (r.tried) console.error(`已装适配器：${r.tried.join(' / ')}`)
      process.exit(2)
    }
    if (r.duplicate) { console.log(`↺ 已抓过：${r.key}\n  ${r.dir}\n  ${r.note}`); process.exit(0) }
    const m = r.material
    console.log(`✓ ${m.title}`)
    console.log(`  平台 ${m.source} · ${m.author || '?'} · ${fmtDur(m.duration_sec)} · ${m.transcript?.kind || '无正文'} · ${(m.comments || []).length} 条评论`)
    if (m.transcript?.chars) console.log(`  正文 ${m.transcript.chars} 字 → ${m.transcript.text_file}`)
    for (const w of m.warnings || []) console.log(`  ⚠ ${w}`)
    console.log(`  材料包 ${r.dir}`)
    process.exit(0)
  } catch (e) {
    console.error(`✗ ${e?.message ?? e}`)
    process.exit(1)
  }
}
