// Records the demo described in STORYBOARD.md.
//
// Phase 1 (capture) drives the real app in Edge, saving raw 2x frames plus a timeline of
// camera moves, cursor positions and clicks. Phase 2 (render) builds the 60 fps video from
// that: the camera crop, cursor and click ripples are drawn here rather than in the page,
// so they stay smooth whatever rate the browser delivered frames at.
//
//   node demo/record.mjs                 capture and render
//   node demo/record.mjs --render-only   re-render from the last capture (after tweaking the renderer)

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ffmpegPath from 'ffmpeg-static'
import { chromium } from 'playwright-core'
import sharp from 'sharp'
import { createServer } from 'vite'
import { writeAudio } from './audio.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(here, 'out')
const FRAMES = path.join(OUT, 'frames')
const BROWSER = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 5199

/** Browser viewport in CSS px. */
const W = 1600
const H = 900
/** Capture density, so zoomed-in shots are still sharp. */
const DPR = 2
const OUT_W = 1920
const OUT_H = 1080
const FPS = 60

const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2)
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const lerp = (a, b, p) => a + (b - a) * p

// Capture

async function capture() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(FRAMES, { recursive: true })
  const server = await createServer({ root: path.resolve(here, '..'), logLevel: 'error', server: { port: PORT, strictPort: true } })
  await server.listen()
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true })
  try {
    console.log('Making the demo PDF…')
    const pdf = await makePdf(browser)
    const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, colorScheme: 'light' })
    // Start in light mode so a single click on the toggle shows dark.
    await context.addInitScript(() => {
      if (!localStorage.getItem('reader:theme')) localStorage.setItem('reader:theme', '"light"')
    })
    console.log('Recording…')
    const timeline = await direct(await context.newPage(), pdf)
    fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(timeline))
    const secs = timeline.end - timeline.start
    console.log(`Captured ${timeline.frames.length} frames over ${secs.toFixed(1)}s (${(timeline.frames.length / secs).toFixed(0)} fps)`)
  } finally {
    await browser.close()
    await server.close()
  }
}

async function makePdf(browser) {
  const page = await browser.newPage()
  await page.goto(pathToFileURL(path.join(here, 'essay.html')).href, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true })
  await page.close()
  fs.writeFileSync(path.join(OUT, 'The Art of Slow Reading.pdf'), pdf)
  return pdf
}

/** Plays the storyboard and returns the timeline the renderer needs. */
async function direct(page, pdf) {
  const frames = []
  const camera = []
  const mouse = []
  const clicks = []
  /** Stretches of the capture left out of the video, like the PDF loading. */
  const cuts = []
  const now = () => Date.now() / 1000
  const sleep = (s) => page.waitForTimeout(s * 1000)

  const cdp = await page.context().newCDPSession(page)
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = `f${String(frames.length).padStart(5, '0')}.jpg`
    fs.writeFileSync(path.join(FRAMES, file), Buffer.from(data, 'base64'))
    frames.push({ t: metadata.timestamp, file })
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })

  // Camera: scale around a point, in viewport CSS px, easing over `dur` seconds.
  const cam = (scale, x, y, dur = 1) => camera.push({ t: now(), scale, x, y, dur })
  const focus = (r, scale, dur) => cam(scale, r.x + r.w / 2, r.y + r.h / 2, dur)
  const reset = (dur = 1) => cam(1, W / 2, H / 2, dur)

  // Cursor: eased moves, sampled into the timeline.
  let mx = W * 0.72
  let my = H * 0.86
  async function move(x, y, dur = 0.7) {
    const fx = mx
    const fy = my
    const start = now()
    for (;;) {
      const p = Math.min(1, (now() - start) / dur)
      mx = lerp(fx, x, ease(p))
      my = lerp(fy, y, ease(p))
      await page.mouse.move(mx, my)
      mouse.push({ t: now(), x: mx, y: my })
      if (p >= 1) return
      await sleep(1 / 60)
    }
  }
  async function down() {
    clicks.push({ t: now(), type: 'down', x: mx, y: my })
    await page.mouse.down()
  }
  async function up() {
    await page.mouse.up()
    clicks.push({ t: now(), type: 'up' })
  }
  async function click(r, dur = 0.8) {
    await move(r.x + r.w / 2, r.y + r.h / 2, dur)
    await down()
    await sleep(0.07)
    await up()
  }
  /** Drags across a run of text, from the start of its first line to the end of its last. */
  async function select(rects) {
    const first = rects[0]
    const last = rects[rects.length - 1]
    await move(first.x + 1, first.y + first.h / 2, 0.8)
    await down()
    await move(last.x + last.w - 1, last.y + last.h / 2, 0.6 + 0.35 * rects.length)
    await up()
  }
  const box = async (locator) => {
    const b = await locator.boundingBox()
    return { x: b.x, y: b.y, w: b.width, h: b.height }
  }

  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W * DPR, maxHeight: H * DPR, everyNthFrame: 1 })

  // 1. Landing, while the highlighter sweeps under the headline.
  await page.goto(`http://localhost:${PORT}/`)
  await page.evaluate(() => document.fonts.ready)
  const start = now()
  mouse.push({ t: start, x: mx, y: my })
  await sleep(3)

  // 2. Open the essay.
  const chooser = page.waitForEvent('filechooser')
  await click(await box(page.locator('section button', { hasText: 'Open a PDF' })), 1)
  await (await chooser).setFiles({ name: 'The Art of Slow Reading.pdf', mimeType: 'application/pdf', buffer: pdf })
  // Skip the moment the first page is still blank.
  const loading = now()
  await page.waitForSelector('.page[data-page="0"] .textLayer')
  await sleep(0.1)
  cuts.push({ from: loading, to: now() })
  await sleep(1.4)

  // 3. Follow a link in the table of contents.
  const toc = union(await findText(page, 'III.Marginalia'))
  await move(toc.x + toc.w * 0.6, toc.y + toc.h / 2, 1)
  await sleep(0.3)
  await click(toc, 0.3)
  await sleep(1.6)

  // 4. Highlight a sentence in amber: the first of only two zooms.
  const s1 = await findText(page, 'A margin is an invitation to talk back.')
  focus(union(s1), 1.5, 0.7)
  await sleep(0.5)
  await select(s1)
  const amber = page.locator('button[title="Highlight amber"]')
  await amber.waitFor({ state: 'visible' })
  await sleep(0.4)
  await click(await box(amber), 0.6)
  await sleep(0.8)
  reset(0.7)
  await sleep(0.8)

  // 5. Highlight a longer passage with a note.
  const s2 = await findText(
    page,
    'The notes we leave at the edges of a page are not decorations; they are a record of one mind meeting another, and years later they let us see who we were when we first read the words.',
  )
  await select(s2)
  const note = page.locator('button[title^="Highlight and add a note"]')
  await note.waitFor({ state: 'visible' })
  await sleep(0.4)
  await click(await box(note), 0.6)
  const card = page.locator('aside article', { hasText: 'The notes we leave' })
  const textarea = card.locator('textarea')
  await textarea.waitFor()
  await sleep(0.2)
  // The second zoom, so the note being typed is readable.
  focus(await box(card), 1.4, 0.7)
  const ta = await box(textarea)
  await move(ta.x + ta.w * 0.6, ta.y + ta.h / 2, 0.8)
  await sleep(0.2)
  await page.keyboard.type('This is why I keep a pencil nearby.', { delay: 55 })
  await sleep(0.4)
  await page.keyboard.press('Enter')
  await sleep(0.8)
  reset(0.7)
  await sleep(0.8)

  // 6. Fold the long passage away, then open it again.
  const chevron = () => page.locator('aside article', { hasText: 'The notes we leave' }).locator('button[aria-expanded]')
  await click(await box(chevron()), 0.8)
  await sleep(1.1)
  await click(await box(chevron()), 0.5)
  await sleep(1.1)

  // 7. Scroll back to the first page, then jump from the sidebar to a highlight several pages down.
  await move(W * 0.32, H * 0.55, 0.9)
  for (let i = 0; i < 26; i++) {
    await page.mouse.wheel(0, -240)
    await sleep(0.035)
  }
  await sleep(1)
  const firstCard = page.locator('aside article', { hasText: 'A margin is an invitation' }).locator('p').first()
  await click(await box(firstCard), 1.1)
  await sleep(2.4)

  // 8. Dark mode.
  await click(await box(page.locator('header button[title^="Theme"]')), 1)
  await sleep(1.6)

  // 9. Back to the library: the cover now shows progress and highlights.
  await click(await box(page.locator('header a[title="Library"]')), 1)
  const cover = page.locator('a[data-id]').first()
  await cover.locator('img:not(.hidden)').waitFor()
  await sleep(0.6)
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('section')].find((el) => el.textContent?.includes('Continue reading'))
    if (s) scrollTo({ top: s.offsetTop - 40, behavior: 'smooth' })
  })
  await sleep(1.3)
  const c = await box(cover)
  await move(c.x + c.w / 2, c.y + c.h * 0.45, 1)
  await sleep(1.8)

  // 10. Ease the cursor away and hold.
  await move(c.x + c.w * 1.8, c.y + c.h * 0.2, 1.4)
  await sleep(1.8)
  const end = now()

  await cdp.send('Page.stopScreencast')
  return { start, end, frames, camera, mouse, clicks, cuts }
}

/** Finds a phrase in the rendered text layers (whitespace-insensitive) and returns its line boxes. */
async function findText(page, phrase) {
  const handle = await page.waitForFunction(
    (needle) => {
      const want = needle.replace(/\s+/g, '')
      for (const layer of document.querySelectorAll('.textLayer')) {
        const chars = []
        let hay = ''
        const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          for (let i = 0; i < n.data.length; i++) {
            if (/\s/.test(n.data[i])) continue
            chars.push([n, i])
            hay += n.data[i]
          }
        }
        const at = hay.indexOf(want)
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(chars[at][0], chars[at][1])
        const [endNode, endOffset] = chars[at + want.length - 1]
        range.setEnd(endNode, endOffset + 1)
        const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1 && r.height < 80)
        if (!rects.length || rects.some((r) => r.bottom < 0 || r.top > innerHeight)) continue
        return rects.map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })).sort((a, b) => a.y - b.y || a.x - b.x)
      }
      return null
    },
    phrase,
    { timeout: 20000 },
  )
  return handle.jsonValue()
}

function union(rects) {
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y }
}

// Render

async function render() {
  const tl = JSON.parse(fs.readFileSync(path.join(OUT, 'timeline.json'), 'utf8'))
  const cuts = tl.cuts ?? []
  const cutBefore = (t) => cuts.reduce((sum, c) => sum + (c.to <= t ? c.to - c.from : 0), 0)
  /** Capture time for a moment in the finished video, stepping over the cuts. */
  const sourceTime = (videoTime) => {
    let t = tl.start + videoTime
    for (const c of cuts) if (t >= c.from) t += c.to - c.from
    return t
  }
  const duration = tl.end - tl.start - cutBefore(tl.end)
  const total = Math.ceil(duration * FPS)
  const file = path.join(OUT, 'reader-demo.mp4')

  const audio = path.join(OUT, 'soundtrack.wav')
  const clickTimes = tl.clicks.filter((c) => c.type === 'down').map((c) => c.t - tl.start - cutBefore(c.t))
  writeAudio(audio, duration, clickTimes)
  console.log(`Rendering ${total} frames…`)

  const ff = spawn(
    ffmpegPath,
    ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${OUT_W}x${OUT_H}`, '-r', String(FPS), '-i', '-', '-i', audio,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', file],
    { stdio: ['pipe', 'ignore', 'inherit'] },
  )

  let fi = 0
  let cache = { file: '', data: null, info: null }
  for (let i = 0; i < total; i++) {
    const t = sourceTime(i / FPS)
    while (fi + 1 < tl.frames.length && tl.frames[fi + 1].t <= t) fi++
    const frame = tl.frames[fi]
    if (cache.file !== frame.file) {
      const { data, info } = await sharp(path.join(FRAMES, frame.file)).raw().toBuffer({ resolveWithObject: true })
      cache = { file: frame.file, data, info }
    }
    const { info } = cache
    const density = info.width / W

    const cam = cameraAt(tl.camera, t)
    const cw = W / cam.scale
    const ch = H / cam.scale
    const left = clamp(cam.x - cw / 2, 0, W - cw)
    const top = clamp(cam.y - ch / 2, 0, H - ch)
    const k = OUT_W / cw
    const crop = {
      left: clamp(Math.round(left * density), 0, info.width - 1),
      top: clamp(Math.round(top * density), 0, info.height - 1),
    }
    crop.width = Math.min(Math.round(cw * density), info.width - crop.left)
    crop.height = Math.min(Math.round(ch * density), info.height - crop.top)

    const img = await sharp(cache.data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .extract(crop)
      .resize(OUT_W, OUT_H, { kernel: 'lanczos3', fit: 'fill' })
      .composite(await overlays(tl, t, left, top, k))
      .removeAlpha()
      .raw()
      .toBuffer()
    if (!ff.stdin.write(img)) await once(ff.stdin, 'drain')
    if (i % 300 === 0) console.log(`  ${((i / total) * 100).toFixed(0)}%`)
  }
  ff.stdin.end()
  const [code] = await once(ff, 'close')
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}`)
  console.log(`Done: ${file}`)
}

function cameraAt(keys, t) {
  let cur = { scale: 1, x: W / 2, y: H / 2 }
  for (let i = 0; i < keys.length && keys[i].t <= t; i++) {
    const k = keys[i]
    // A move interrupted by the next one stops where it got to.
    const until = Math.min(t, keys[i + 1]?.t ?? Infinity)
    const p = k.dur > 0 ? ease(clamp((until - k.t) / k.dur, 0, 1)) : 1
    cur = { scale: lerp(cur.scale, k.scale, p), x: lerp(cur.x, k.x, p), y: lerp(cur.y, k.y, p) }
  }
  return cur
}

function mouseAt(samples, t) {
  if (t <= samples[0].t) return samples[0]
  let lo = 0
  let hi = samples.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  const a = samples[lo]
  const b = samples[lo + 1]
  if (!b) return a
  const p = (t - a.t) / (b.t - a.t || 1)
  return { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) }
}

const cursorCache = new Map()
function cursorPng(size) {
  if (!cursorCache.has(size)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
      <filter id="s" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="0.8" stdDeviation="0.9" flood-opacity="0.35"/></filter>
      <path filter="url(#s)" d="M5 3 L19.5 10.6 L13 12.4 L10.1 18.8 Z" fill="#141414" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
    </svg>`
    cursorCache.set(size, sharp(Buffer.from(svg)).png().toBuffer())
  }
  return cursorCache.get(size)
}

/** The cursor and any click ripples for time t, in output pixels. */
async function overlays(tl, t, left, top, k) {
  const out = []
  const place = (x, y, size) => ({ left: Math.round(clamp(x, 0, OUT_W - size)), top: Math.round(clamp(y, 0, OUT_H - size)) })

  for (const c of tl.clicks) {
    const age = t - c.t
    if (c.type !== 'down' || age < 0 || age > 0.5) continue
    const p = age / 0.5
    const r = (10 + 26 * ease(p)) * k
    const size = Math.ceil(r * 2 + 4)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="#f7c948" fill-opacity="${0.45 * (1 - p)}" stroke="#f7c948" stroke-opacity="${0.9 * (1 - p)}" stroke-width="${1.5 * k}"/>
    </svg>`
    out.push({ input: Buffer.from(svg), ...place((c.x - left) * k - size / 2, (c.y - top) * k - size / 2, size) })
  }

  const m = mouseAt(tl.mouse, t)
  const last = tl.clicks.filter((c) => c.t <= t).at(-1)
  const pressed = last?.type === 'down'
  const size = Math.round(30 * Math.min(k, 2.2) * (pressed ? 0.86 : 1))
  // The arrow's tip sits at (5, 3) in its 24-unit viewBox.
  const x = (m.x - left) * k - (5 / 24) * size
  const y = (m.y - top) * k - (3 / 24) * size
  out.push({ input: await cursorPng(size), ...place(x, y, size) })
  return out
}

// Entry point last, so every declaration above is initialized before it runs.
if (!process.argv.includes('--render-only')) await capture()
await render()
