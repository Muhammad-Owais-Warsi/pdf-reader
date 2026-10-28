import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import * as db from './db'
import { sha256 } from './util'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** PDF.js takes ownership of the buffer it is given, so callers pass a copy if they still need theirs. */
export const openPdf = (data: ArrayBuffer) => pdfjs.getDocument({ data: new Uint8Array(data) }).promise

/** Renders page 1 into a small image for the library. */
async function makeThumb(pdf: PDFDocumentProxy, width = 360) {
  const page = await pdf.getPage(1)
  const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  await page.render({ canvas, viewport }).promise
  return new Promise<Blob | undefined>((resolve) => canvas.toBlob((b) => resolve(b ?? undefined), 'image/webp', 0.85))
}

/** Stores a PDF (deduplicated by content hash) and returns its id. */
export async function importPdf(file: File) {
  const buf = await file.arrayBuffer()
  const id = (await sha256(buf)).slice(0, 32)
  const existing = await db.getDoc(id)
  if (existing) {
    await db.putDoc({ ...existing, openedAt: Date.now() })
    return id
  }
  const pdf = await openPdf(buf)
  const pages = pdf.numPages
  const thumb = await makeThumb(pdf).catch(() => undefined)
  await pdf.loadingTask.destroy()
  const now = Date.now()
  await db.addDoc({ id, name: file.name.replace(/\.pdf$/i, ''), size: file.size, pages, addedAt: now, openedAt: now, thumb }, file)
  return id
}

/** Creates the cover for a document stored before covers existed. */
export async function ensureThumb(id: string) {
  const blob = await db.getFile(id)
  if (!blob) return
  const pdf = await openPdf(await blob.arrayBuffer())
  try {
    const thumb = await makeThumb(pdf)
    // Re-read so a cover never overwrites newer reading progress.
    const latest = await db.getDoc(id)
    if (thumb && latest) await db.putDoc({ ...latest, thumb })
    return thumb
  } finally {
    await pdf.loadingTask.destroy()
  }
}
