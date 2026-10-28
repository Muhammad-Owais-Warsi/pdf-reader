// Renders art/og.html to public/og.png, the 1200×630 link preview image.
// Captured at 2x and downscaled, so text edges stay smooth.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import sharp from 'sharp'

const here = path.dirname(fileURLToPath(import.meta.url))
const BROWSER = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

const browser = await chromium.launch({ executablePath: BROWSER, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 })
  await page.goto(pathToFileURL(path.join(here, 'og.html')).href, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const shot = await page.screenshot({ type: 'png' })
  const out = path.join(here, '..', 'public', 'og.png')
  await sharp(shot).resize(1200, 630, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(out)
  console.log(`Wrote ${out}`)
} finally {
  await browser.close()
}
