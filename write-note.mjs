#!/usr/bin/env node
/**
 * write-note —— 把 03-草稿/ 里的草案落进库里
 * ============================================================================
 * 做五件事（--dry-run 只打印，不动文件）：
 *   1. frontmatter 的 status 改成 verified
 *   2. 移到 01-视频笔记/<分类>/ 或 02-文章笔记/<分类>/
 *   3. 原文（transcript.txt / comments.json / material.json）复制进 99-原文/<日期>-<id>/
 *      —— 以后想重新提炼不用再下视频、不用再转写
 *   4. 00-索引/台账.md 追加一行
 *   5. 00-索引/主题索引.md 里按 topic 归类；当天日记存在就追加一行
 *
 * 用法：
 *   node write-note.mjs <draft.md> --to "01-视频笔记/AI与工具" [--dry-run]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'

const VAULT = process.env.OBSIDIAN_VAULT || ''
const NOTES_SUBDIR = process.env.NOTES_SUBDIR || '笔记'
const NOTES = join(VAULT, NOTES_SUBDIR)
const DATA = process.env.VIDEO_INTAKE_DATA || join(process.cwd(), 'data')

function parseFront(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { fm: {}, body: text, raw: '' }
  const fm = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (!kv) continue
    let v = kv[2].trim()
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    else v = v.replace(/^["']|["']$/g, '')
    fm[kv[1]] = v
  }
  return { fm, body: text.slice(m[0].length), raw: m[0] }
}

const setFm = (raw, key, value) => raw.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: ${value}`)

function summaryOf(body) {
  const line = body.split('\n').find((l) => l.startsWith('> 一句话'))
  if (line) {
    const t = line.replace(/^>\s*一句话[：:]\s*/, '').split(/[。；]/)[0].trim()
    return t.length > 70 ? t.slice(0, 68) + '…' : t
  }
  return '(无一句话总结)'
}

function appendUnique(file, block, marker) {
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (cur.includes(marker)) return { changed: false, file }
  writeFileSync(file, cur.replace(/\s*$/, '\n') + '\n' + block + '\n', 'utf8')
  return { changed: true, file }
}

/** 台账是张表：新行要插在表头分隔行下面，不能糊在文件末尾 */
function insertLedgerRow(file, row, id) {
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (cur.includes(id)) return { changed: false, file }
  const lines = cur.split('\n')
  const sep = lines.findIndex((l) => /^\|\s*-{2,}/.test(l.trim()))
  if (sep >= 0) {
    lines.splice(sep + 1, 0, row)
    writeFileSync(file, lines.join('\n'), 'utf8')
  } else {
    writeFileSync(file, cur.replace(/\s*$/, '\n') + '\n' + row + '\n', 'utf8')
  }
  return { changed: true, file }
}

export function writeNote(draftPath, { to, dryRun = false } = {}) {
  if (!VAULT) throw new Error('必须设环境变量 OBSIDIAN_VAULT（指向 Obsidian 仓库根目录）')
  if (!existsSync(draftPath)) throw new Error('找不到草案：' + draftPath)
  if (!to) throw new Error('必须给 --to（例如 "01-视频笔记/AI与工具"）')
  const text = readFileSync(draftPath, 'utf8')
  const { fm, body, raw } = parseFront(text)
  const id = fm.source_id || basename(draftPath).split('-')[1] || 'unknown'
  const date = fm.read_at || new Date().toISOString().slice(0, 10)
  const title = fm.title || basename(draftPath, '.md')
  const destDir = join(NOTES, to)
  const dest = join(destDir, basename(draftPath))
  const log = []

  // ① 状态改 verified
  const newText = setFm(setFm(raw, 'status', 'verified'), 'read_at', date) + body
  log.push(`status → verified`)

  // ② 移库
  log.push(`移动：${draftPath.replace(VAULT, '<vault>')} → ${dest.replace(VAULT, '<vault>')}`)

  // ③ 原文归档
  const matDir = join(DATA, `${fm.source}-${id}`)
  const archDir = join(NOTES, '99-原文', `${date}-${id}`)
  const copyList = ['transcript.txt', 'comments.json', 'material.json'].filter((f) => existsSync(join(matDir, f)))
  log.push(`原文归档：${copyList.length} 个文件 → ${archDir.replace(VAULT, '<vault>')}`)

  // ④ 台账
  const ledger = join(NOTES, '00-索引', '台账.md')
  const row = `| ${date} | ${fm.source || '?'} | ${title} | ${summaryOf(body)} | [[${to}/${basename(draftPath, '.md')}\\|笔记]] |`
  log.push(`台账追加一行：${row.slice(0, 90)}…`)

  // ⑤ 主题索引
  const alias = String(title).split(/[！!：:，,（(]/)[0].slice(0, 20) || title.slice(0, 20)
  const topics = Array.isArray(fm.topic) ? fm.topic : (fm.topic ? [fm.topic] : ['未分类'])
  const topicLine = `- [[${to}/${basename(draftPath, '.md')}\\|${alias}]] — ${fm.author || '?'} · ${fm.duration || ''}`

  // ⑥ 日记
  const diary = join(VAULT, '日记', `${date}.md`)

  if (dryRun) return { ok: true, dryRun: true, dest, archDir, copyList, row, topics, topicLine, diaryExists: existsSync(diary), log }

  // 实际执行
  mkdirSync(destDir, { recursive: true })
  writeFileSync(draftPath, newText, 'utf8')
  renameSync(draftPath, dest)

  if (copyList.length) {
    mkdirSync(archDir, { recursive: true })
    for (const f of copyList) copyFileSync(join(matDir, f), join(archDir, f))
  }

  insertLedgerRow(ledger, row, id)

  const tIdx = join(NOTES, '00-索引', '主题索引.md')
  let cur = existsSync(tIdx) ? readFileSync(tIdx, 'utf8') : '# 主题索引\n'
  for (const t of topics) {
    const head = `## ${t}`
    if (cur.includes(topicLine)) break
    if (cur.includes(head)) {
      cur = cur.replace(head, head + '\n' + topicLine)
    } else {
      cur = cur.replace(/\s*$/, '\n') + `\n${head}\n${topicLine}\n`
    }
  }
  writeFileSync(tIdx, cur, 'utf8')

  if (existsSync(diary)) {
    writeFileSync(diary, readFileSync(diary, 'utf8').replace(/\s*$/, '\n') + `- 看了 [[${to}/${basename(draftPath, '.md')}]]（${fm.source} ${id}）\n`, 'utf8')
  }

  return { ok: true, dest, archDir, copyList, row, topics, topicLine, diaryAppended: existsSync(diary) }
}

/* CLI */
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--to')
  const to = i >= 0 ? argv[i + 1] : ''
  const draft = argv.find((a) => a.endsWith('.md'))
  try {
    const r = writeNote(draft, { to, dryRun: argv.includes('--dry-run') })
    if (r.dryRun) {
      console.log('=== DRY RUN（没有改动任何文件）===')
      for (const l of r.log) console.log('  · ' + l)
      console.log(`  主题：${r.topics.join(' / ')}`)
      console.log(`  主题索引行：${r.topicLine}`)
      console.log(`  当天日记：${r.diaryExists ? '存在，会追加一行' : '不存在，跳过'}`)
    } else {
      console.log('✓ 已落库')
      console.log(JSON.stringify(r, null, 2))
    }
  } catch (e) {
    console.error('✗ ' + (e?.message ?? e))
    process.exit(1)
  }
}
