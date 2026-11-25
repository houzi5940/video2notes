/**
 * lib/asr.mjs —— 用 oMLX 的 whisper-large-v3-turbo 转写视频音轨
 * ============================================================================
 * 为什么不用 faster-whisper：那是 CTranslate2 格式，oMLX 只吃 MLX 权重。
 * oMLX 自带 mlx_audio + /v1/audio/transcriptions，`verbose_json` 会返回
 * segments（start/end/text）+ no_speech_prob + compression_ratio —— 后面两个
 * 正好当幻觉判据用。
 *
 * 分块：WHISPER 处理长音频会退化，按 CHUNK_SEC 切，每块单独请求，时间戳补偏移。
 * 中文两个坑（实测）：① 默认出繁体 ② 英文术语被音译（token→talking）。
 *   ⇒ prompt 里固定写「请用简体中文」+ 术语表，两个一起解决。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const OMLX = process.env.OMLX_URL || 'http://127.0.0.1:11451'
const MODEL = process.env.OMLX_ASR_MODEL || 'whisper-large-v3-turbo'
const CHUNK_SEC = Number(process.env.OMLX_ASR_CHUNK || 480)
export const WATCH_CACHE = join(homedir(), '.dsh', 'bili-watch', 'cache', 'frames')

const run = (cmd, args, timeout = 600000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
    resolve({ code: err ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
  })
})

export async function omlxStatus() {
  try {
    const r = await fetch(OMLX + '/v1/models', { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` }
    const j = await r.json()
    const ids = (j.data || []).map((m) => m.id)
    return { ok: ids.includes(MODEL), reason: ids.includes(MODEL) ? '' : `没有 ${MODEL}（现有：${ids.join(', ')}）`, ids }
  } catch (e) {
    return { ok: false, reason: `oMLX 连不上（${OMLX}）：${e?.message ?? e}` }
  }
}

/** 找 watch 已经下过的视频文件（frames 那步会缓存 360p mp4） */
export function findCachedVideo(bvid) {
  try {
    const hit = readdirSync(WATCH_CACHE).filter((d) => d.startsWith(bvid)).sort().reverse()
    for (const d of hit) {
      const f = join(WATCH_CACHE, d, `${bvid}.mp4`)
      if (existsSync(f)) return { file: f, dir: join(WATCH_CACHE, d) }
    }
  } catch { /* 目录不存在 */ }
  return null
}

async function transcribeChunk(wav, prompt) {
  const buf = readFileSync(wav)
  const fd = new FormData()
  fd.append('file', new Blob([buf], { type: 'audio/wav' }), 'chunk.wav')
  fd.append('model', MODEL)
  fd.append('language', 'zh')
  fd.append('response_format', 'verbose_json')
  fd.append('prompt', prompt)
  const r = await fetch(OMLX + '/v1/audio/transcriptions', { method: 'POST', body: fd, signal: AbortSignal.timeout(900000) })
  const j = await r.json().catch(() => ({}))
  if (j?.error) throw new Error(j.error.message || 'transcribe 失败')
  return j
}

/**
 * @param {string} videoPath  本地 mp4
 * @param {object} opts       { durationSec, prompt, workDir, sh, log }
 * @returns {{kind:'asr', units:[{t,text}], warnings:[string]}}
 */
export async function transcribeVideo(videoPath, opts = {}) {
  const { durationSec = 0, prompt = '以下是普通话的句子，请用简体中文。', workDir, log = () => {} } = opts
  const warnings = []
  const st = await omlxStatus()
  if (!st.ok) return { kind: 'none', units: [], warnings: [`ASR 不可用：${st.reason}`] }

  const dur = durationSec || 0
  if (!dur) return { kind: 'none', units: [], warnings: ['拿不到时长，跳过转写'] }
  const chunks = Math.ceil(dur / CHUNK_SEC)
  log(`转写 ${Math.round(dur / 60)} 分钟音频，分 ${chunks} 块（每块 ${CHUNK_SEC / 60} 分钟，${MODEL}）`)

  const units = []
  let bad = 0
  for (let i = 0; i < chunks; i++) {
    const off = i * CHUNK_SEC
    const wav = join(workDir, `asr-${i}.wav`)
    const ff = await run('ffmpeg', ['-y', '-ss', String(off), '-t', String(CHUNK_SEC), '-i', videoPath,
      '-ar', '16000', '-ac', '1', '-vn', '-loglevel', 'error', wav], 300000)
    if (ff.code !== 0 || !existsSync(wav)) {
      warnings.push(`第 ${i + 1} 块提音频失败：${(ff.stderr || '').split('\n')[0]}`)
      continue
    }
    const t0 = Date.now()
    try {
      const j = await transcribeChunk(wav, prompt)
      const segs = j.segments || []
      for (const s of segs) {
        const text = String(s.text || '').trim()
        if (!text) continue
        const noisy = (s.no_speech_prob ?? 0) > 0.5 || (s.compression_ratio ?? 0) > 2.4
        if (noisy) bad++
        units.push({ t: Math.round(off + (s.start || 0)), text, ...(noisy ? { suspect: true } : {}) })
      }
      log(`  块 ${i + 1}/${chunks}：${segs.length} 段，${((Date.now() - t0) / 1000).toFixed(0)}s`)
    } catch (e) {
      warnings.push(`第 ${i + 1} 块转写失败：${e?.message ?? e}`)
    } finally {
      try { unlinkSync(wav) } catch { /* 忽略 */ }
    }
  }
  if (bad) warnings.push(`有 ${bad} 段被标为可疑（no_speech 概率高或重复度异常），提炼时别当原话引用`)
  return { kind: units.length ? 'asr' : 'none', units, warnings }
}

/** 从标题/简介/关键词里抠出可能被听错的专有名词，拼进 prompt 纠偏 */
export function buildPrompt({ title = '', intro = '', keywords = [] } = {}) {
  const latin = (String(title) + ' ' + String(intro)).match(/[A-Za-z][A-Za-z0-9.+#_-]{1,20}/g) || []
  const uniq = [...new Set(latin.map((s) => s.replace(/[.,]+$/, '')))].filter((s) => s.length > 1).slice(0, 20)
  const kw = keywords.map((s) => String(s).trim()).filter(Boolean).slice(0, 10)
  const gloss = [...new Set([...uniq, ...kw])]
  return '以下是普通话的句子，请用简体中文。'
    + (gloss.length ? `可能出现的术语：${gloss.join('、')}。` : '')
}
