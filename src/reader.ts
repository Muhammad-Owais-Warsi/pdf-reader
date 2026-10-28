import { TextLayer, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist'
import * as db from './db'
import type { Color, DocMeta, Highlight, Note, Rect } from './db'
import { openPdf } from './pdf'
import { themeButton } from './theme'
import { clamp, debounce, h, icon, store, timeAgo, uid } from './util'

const COLORS: Color[] = ['amber', 'sage', 'rose', 'sky']
const SWATCH: Record<Color, string> = {
  amber: 'bg-hl-amber',
  sage: 'bg-hl-sage',
  rose: 'bg-hl-rose',
  sky: 'bg-hl-sky',
}
const MIN_SCALE = 0.4
const MAX_SCALE = 4
const ZOOM_STEP = 1.15
/** Measure every page up front for docs this size or smaller; larger ones assume page 1's size. */
const MEASURE_LIMIT = 300
/** Pages rendered at once. PDF.js paints on the main thread, so more than this makes scrolling stutter. */
const MAX_RENDERING = 2
/** Rendered pages kept around so scrolling back is instant; the farthest are dropped beyond this. */
const KEEP_RENDERED = 16
/** Scrolling counts as stopped after this long without a scroll event. */
const SCROLL_IDLE_MS = 150
/** While scrolling, pages render at this pixel ratio first and are sharpened once scrolling stops. */
const DRAFT_RATIO = 0.75

interface PageView {
  index: number
  el: HTMLDivElement
  layer: HTMLDivElement
  /** Size at scale 1, in CSS px. */
  w: number
  h: number
  canvas?: HTMLCanvasElement
  text?: HTMLDivElement
  links?: HTMLDivElement
  task?: RenderTask
  /** The zoom generation this page was last rendered at, or -1. */
  rendered: number
  /** The rendered canvas is a low-resolution draft. */
  draft: boolean
  busy: boolean
  /** Within the observer's margin around the viewport. */
  near: boolean
}

interface Selection {
  text: string
  rects: Rect[]
}

export async function openReader(root: HTMLElement, id: string) {
  const [meta, blob] = await Promise.all([db.getDoc(id), db.getFile(id)])
  if (!meta || !blob) {
    location.hash = ''
    return () => {}
  }
  const reader = new Reader(root, meta)
  await reader.load(blob)
  return () => reader.destroy()
}

class Reader {
  private meta: DocMeta
  private pdf?: PDFDocumentProxy
  private highlights: Highlight[] = []
  private pages: PageView[] = []
  private scale = 1
  private gen = 0
  private current = 0
  private activeId: string | null = null
  private pending: Selection | null = null
  private color: Color = store.get('color', 'amber')
  private sidebarOpen = store.get('sidebar', true)
  private drafts = new Map<string, string>()
  /** Highlight cards showing their full text, notes and editor. */
  private expanded = new Set<string>()
  private editingNote: string | null = null
  private down: { x: number; y: number } | null = null
  private raf = 0
  private rendering = 0
  private lastScroll = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private dead = false
  private off: (() => void)[] = []
  private io: IntersectionObserver

  private scroller: HTMLDivElement
  private pagesEl: HTMLDivElement
  private sidebar: HTMLElement
  private list: HTMLDivElement
  private count: HTMLSpanElement
  private pageInput: HTMLInputElement
  private pageTotal: HTMLSpanElement
  private zoomLabel: HTMLButtonElement
  private toolbar: HTMLDivElement

  constructor(root: HTMLElement, meta: DocMeta) {
    this.meta = meta

    const btn = 'grid size-8 place-items-center rounded-lg text-muted transition hover:bg-ink/5 hover:text-ink'
    const divider = () => h('div', { class: 'mx-1.5 h-5 w-px bg-line' })

    this.pageInput = h('input', {
      class: 'w-10 rounded-md bg-transparent py-1 text-right tabular-nums text-ink outline-none focus:bg-surface focus:ring-1 focus:ring-line-strong',
      value: '1',
      inputmode: 'numeric',
      'aria-label': 'Page',
      onchange: () => this.goTo(Number(this.pageInput.value) - 1),
      onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && this.pageInput.blur(),
      onfocus: () => this.pageInput.select(),
    })
    this.pageTotal = h('span', { class: 'tabular-nums' })
    this.zoomLabel = h('button', {
      class: 'w-12 rounded-md py-1 text-center tabular-nums text-muted transition hover:bg-ink/5 hover:text-ink',
      title: 'Fit to width (0)',
      onclick: () => this.fit(),
    })

    const header = h(
      'header',
      { class: 'relative z-20 flex h-12 shrink-0 items-center gap-0.5 border-b border-line bg-paper px-2' },
      h('a', { href: '#', class: btn, title: 'Library' }, icon('back')),
      h('h1', { class: 'min-w-0 flex-1 truncate px-2 font-serif text-[17px] text-ink' }, meta.name),
      h('div', { class: 'hidden items-center gap-1 text-[13px] text-muted sm:flex' }, this.pageInput, '/', this.pageTotal),
      divider(),
      h(
        'div',
        { class: 'flex items-center text-[13px]' },
        h('button', { class: btn, title: 'Zoom out (−)', onclick: () => this.zoom(1 / ZOOM_STEP) }, icon('minus')),
        this.zoomLabel,
        h('button', { class: btn, title: 'Zoom in (+)', onclick: () => this.zoom(ZOOM_STEP) }, icon('plus')),
      ),
      divider(),
      themeButton(btn),
      h('button', { class: btn, title: 'Highlights (])', onclick: () => this.toggleSidebar() }, icon('panel')),
    )

    this.count = h('span', { class: 'text-xs tabular-nums text-muted' })
    this.list = h('div', { class: 'flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-8' })
    this.sidebar = h(
      'aside',
      { class: 'absolute inset-y-0 right-0 z-10 flex w-full flex-col border-l border-line bg-paper sm:w-[360px] md:static' },
      h(
        'div',
        { class: 'flex h-12 shrink-0 items-center justify-between px-5' },
        h('h2', { class: 'text-[13px] font-medium text-ink' }, 'Highlights'),
        this.count,
      ),
      this.list,
    )

    this.pagesEl = h(
      'div',
      { class: 'flex w-max min-w-full flex-col items-center gap-6 px-6 py-10' },
      h('p', { class: 'py-24 text-sm text-muted' }, 'Opening…'),
    )
    this.scroller = h('div', { class: 'relative flex-1 overflow-auto' }, this.pagesEl)

    this.toolbar = h(
      'div',
      {
        class: 'fixed z-50 hidden items-center gap-1 rounded-full bg-ink p-1.5 text-paper shadow-xl shadow-black/15',
        onpointerdown: (e: PointerEvent) => e.preventDefault(),
      },
      COLORS.map((c) =>
        h('button', {
          class: `size-6 rounded-full ${SWATCH[c]} ring-paper/70 transition hover:scale-110 hover:ring-2`,
          title: `Highlight ${c}`,
          onclick: () => this.createFromSelection(c),
        }),
      ),
      h('span', { class: 'mx-1 h-4 w-px bg-paper/20' }),
      h(
        'button',
        {
          class: 'flex items-center gap-1.5 rounded-full py-1 pl-2 pr-2.5 text-xs font-medium transition hover:bg-paper/10',
          title: 'Highlight and add a note (n)',
          onclick: () => this.createFromSelection(this.color, true),
        },
        icon('note', 'size-3.5'),
        'Note',
      ),
    )

    root.replaceChildren(
      h(
        'div',
        { class: 'flex h-dvh flex-col bg-paper text-ink' },
        header,
        h('div', { class: 'relative flex min-h-0 flex-1' }, this.scroller, this.sidebar),
      ),
      this.toolbar,
    )
    this.applySidebar()

    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const pv = this.pages[Number((e.target as HTMLElement).dataset.page)]
          pv.near = e.isIntersecting
          // A page scrolled away mid-render isn't worth finishing.
          if (!pv.near) pv.task?.cancel()
        }
        this.schedule()
      },
      { root: this.scroller, rootMargin: '100% 0px' },
    )
  }

  async load(blob: Blob) {
    const [pdf, highlights] = await Promise.all([openPdf(await blob.arrayBuffer()), db.listHighlights(this.meta.id)])
    if (this.dead) return void pdf.loadingTask.destroy()
    this.pdf = pdf
    this.highlights = highlights

    const n = pdf.numPages
    const measure = (i: number) => pdf.getPage(i + 1).then((p) => p.getViewport({ scale: 1 }))
    const sizes = n <= MEASURE_LIMIT ? await Promise.all(Array.from({ length: n }, (_, i) => measure(i))) : [await measure(0)]
    if (this.dead) return

    this.pages = Array.from({ length: n }, (_, index) => {
      const size = sizes[index] ?? sizes[0]
      const layer = h('div', { class: 'hl-layer' })
      const el = h(
        'div',
        { class: 'page relative shrink-0 bg-white shadow-page', 'data-page': index },
        h('span', { class: 'absolute inset-0 grid place-items-center font-serif text-2xl text-black/10 select-none' }, String(index + 1)),
        layer,
      )
      return { index, el, layer, w: size.width, h: size.height, rendered: -1, draft: false, busy: false, near: false }
    })
    this.pageTotal.textContent = String(n)
    this.pagesEl.replaceChildren(...this.pages.map((p) => p.el))

    this.scale = this.meta.zoom ?? this.fitScale()
    for (const pv of this.pages) {
      this.applySize(pv)
      this.paint(pv)
    }
    this.updateZoomLabel()
    this.renderSidebar()

    const last = this.meta.lastPage != null ? this.pages[this.meta.lastPage] : undefined
    if (last) {
      this.scroller.scrollTop = last.el.offsetTop + (this.meta.lastOffset ?? 0) * last.el.offsetHeight
      this.updateCurrent()
    }

    this.meta = { ...this.meta, pages: n, openedAt: Date.now() }
    void db.putDoc(this.meta)

    for (const pv of this.pages) this.io.observe(pv.el)
    this.bind()
  }

  destroy() {
    this.dead = true
    this.saveProgress.flush()
    this.io.disconnect()
    for (const f of this.off) f()
    for (const pv of this.pages) pv.task?.cancel()
    cancelAnimationFrame(this.raf)
    clearTimeout(this.idleTimer)
    void this.pdf?.loadingTask.destroy()
  }

  // Events

  private bind() {
    const on = (target: EventTarget, type: string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn, opts)
      this.off.push(() => target.removeEventListener(type, fn, opts))
    }

    on(this.scroller, 'scroll', () => {
      this.hideToolbar()
      this.lastScroll = performance.now()
      clearTimeout(this.idleTimer)
      // Once scrolling stops, sharpen drafts and fill in text layers.
      this.idleTimer = setTimeout(() => this.schedule(), SCROLL_IDLE_MS + 10)
      if (!this.raf) {
        this.raf = requestAnimationFrame(() => {
          this.raf = 0
          this.updateCurrent()
          this.schedule()
        })
      }
    }, { passive: true })

    on(this.scroller, 'wheel', (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      this.zoom(Math.exp(-e.deltaY * 0.0025), e)
    }, { passive: false })

    on(this.pagesEl, 'pointerdown', (e: PointerEvent) => {
      this.down = { x: e.clientX, y: e.clientY }
      this.hideToolbar()
    })
    on(document, 'pointerup', (e: PointerEvent) => this.onPointerUp(e))
    on(this.pagesEl, 'mousemove', (e: MouseEvent) => {
      if (!e.buttons) this.pagesEl.classList.toggle('over-hl', !!this.hitTest(e))
    })
    on(document, 'selectionchange', () => {
      if (getSelection()?.isCollapsed) {
        this.pending = null
        this.hideToolbar()
      }
    })
    on(document, 'keydown', (e: KeyboardEvent) => this.onKey(e))
    on(window, 'resize', debounce(() => {
      if (this.meta.zoom == null) this.setScale(this.fitScale())
    }, 150))
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.down) return
    const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y)
    this.down = null
    // Let the browser finish updating the selection first.
    setTimeout(() => {
      const sel = this.captureSelection()
      if (sel) {
        this.pending = sel
        this.showToolbar()
      } else if (moved < 4) {
        const hit = this.hitTest(e)
        this.setActive(hit?.id ?? null, { reveal: !!hit })
      }
    })
  }

  private onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, [contenteditable]')) {
      if (e.key === 'Escape') target.blur()
      return
    }
    if ((e.ctrlKey || e.metaKey) && ['=', '+', '-', '0'].includes(e.key)) {
      e.preventDefault()
      if (e.key === '0') this.fit()
      else this.zoom(e.key === '-' ? 1 / ZOOM_STEP : ZOOM_STEP)
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return

    switch (e.key) {
      case 'Escape':
        if (this.pending) getSelection()?.removeAllRanges()
        else this.setActive(null)
        break
      case 'h':
        if (!this.pending) return
        this.createFromSelection(this.color)
        break
      case 'n':
        if (!this.pending) return
        this.createFromSelection(this.color, true)
        break
      case ']':
        this.toggleSidebar()
        break
      case '+':
      case '=':
        this.zoom(ZOOM_STEP)
        break
      case '-':
        this.zoom(1 / ZOOM_STEP)
        break
      case '0':
        this.fit()
        break
      default:
        return
    }
    e.preventDefault()
  }

  // Rendering

  private applySize(pv: PageView) {
    pv.el.style.width = `${Math.floor(pv.w * this.scale)}px`
    pv.el.style.height = `${Math.floor(pv.h * this.scale)}px`
    pv.el.style.setProperty('--total-scale-factor', String(this.scale))
  }

  private isScrolling() {
    return performance.now() - this.lastScroll < SCROLL_IDLE_MS
  }

  /** Renders the pages nearest the middle of the viewport first, a couple at a time. */
  private schedule() {
    if (this.dead || !this.pdf) return
    const scrolling = this.isScrolling()
    const top = this.scroller.scrollTop
    const bottom = top + this.scroller.clientHeight
    const center = (top + bottom) / 2

    while (this.rendering < MAX_RENDERING) {
      let best: PageView | undefined
      let bestDist = Infinity
      for (const pv of this.pages) {
        if (!pv.near || pv.busy) continue
        if (pv.rendered === this.gen && !(pv.draft && !scrolling)) continue
        const y = pv.el.offsetTop
        const height = pv.el.offsetHeight
        // While scrolling, spend nothing on pages that aren't on screen yet.
        if (scrolling && (y > bottom || y + height < top)) continue
        const dist = Math.abs(y + height / 2 - center)
        if (dist < bestDist) {
          best = pv
          bestDist = dist
        }
      }
      if (!best) return
      this.rendering++
      void this.render(best, scrolling).finally(() => {
        this.rendering--
        this.evict()
        this.schedule()
      })
    }
  }

  private async render(pv: PageView, draft: boolean) {
    pv.busy = true
    const gen = this.gen
    try {
      const page = await this.pdf!.getPage(pv.index + 1)
      if (gen !== this.gen || !pv.near) return

      const base = page.getViewport({ scale: 1 })
      if (base.width !== pv.w || base.height !== pv.h) {
        pv.w = base.width
        pv.h = base.height
        this.applySize(pv)
      }

      const viewport = page.getViewport({ scale: this.scale })
      const dpr = window.devicePixelRatio || 1
      const ratio = draft ? Math.min(dpr, DRAFT_RATIO) : Math.min(dpr, 3)
      const canvas = h('canvas', { class: 'absolute inset-0 size-full' })
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      pv.task = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
      await pv.task.promise
      if (gen !== this.gen) return
      // Swap only once the new canvas is ready, so zooming and sharpening never flash blank.
      pv.canvas?.remove()
      pv.layer.before(canvas)
      pv.canvas = canvas
      pv.rendered = gen
      pv.draft = draft
      // Text and links are only needed once the reader stops on a page.
      if (draft) return

      if (!pv.links) await this.renderLinks(pv, page)
      const text = h('div', { class: 'textLayer' })
      await new TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport }).render()
      if (gen !== this.gen) return
      pv.text?.remove()
      pv.layer.after(text)
      pv.text = text
    } catch (err) {
      if ((err as Error)?.name !== 'RenderingCancelledException') console.error(err)
    } finally {
      pv.busy = false
      pv.task = undefined
    }
  }

  private unrender(pv: PageView) {
    pv.task?.cancel()
    pv.canvas?.remove()
    pv.text?.remove()
    pv.links?.remove()
    pv.canvas = pv.text = pv.links = undefined
    pv.rendered = -1
    pv.draft = false
  }

  /** Drops the rendered pages farthest from view once more than KEEP_RENDERED are held. */
  private evict() {
    const kept = this.pages.filter((pv) => pv.canvas && !pv.busy && !pv.near)
    const total = this.pages.reduce((n, pv) => n + (pv.canvas ? 1 : 0), 0)
    if (total <= KEEP_RENDERED) return
    const center = this.scroller.scrollTop + this.scroller.clientHeight / 2
    const dist = (pv: PageView) => Math.abs(pv.el.offsetTop + pv.el.offsetHeight / 2 - center)
    kept.sort((a, b) => dist(b) - dist(a))
    for (const pv of kept.slice(0, total - KEEP_RENDERED)) this.unrender(pv)
  }

  private rerender = debounce(() => this.schedule(), 150)

  // Links

  private async renderLinks(pv: PageView, page: PDFPageProxy) {
    const annotations = await page.getAnnotations({ intent: 'display' })
    const base = page.getViewport({ scale: 1 })
    const pct = (n: number) => `${n * 100}%`
    const layer = h('div', { class: 'link-layer' })
    for (const a of annotations) {
      if (a.subtype !== 'Link' || !Array.isArray(a.rect)) continue
      const [x1, y1] = base.convertToViewportPoint(a.rect[0], a.rect[1])
      const [x2, y2] = base.convertToViewportPoint(a.rect[2], a.rect[3])
      const style = {
        left: pct(Math.min(x1, x2) / base.width),
        top: pct(Math.min(y1, y2) / base.height),
        width: pct(Math.abs(x2 - x1) / base.width),
        height: pct(Math.abs(y2 - y1) / base.height),
      }
      if (typeof a.url === 'string' && /^(https?|mailto):/i.test(a.url)) {
        layer.append(h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', title: a.url, style }))
      } else if (a.dest) {
        layer.append(
          h('a', {
            href: '#',
            style,
            onclick: (e: MouseEvent) => {
              e.preventDefault()
              void this.goToDest(a.dest)
            },
          }),
        )
      }
    }
    pv.links?.remove()
    if (!layer.childElementCount) return
    pv.el.append(layer)
    pv.links = layer
  }

  /** Jumps to an internal link target: a named destination or an explicit [pageRef, mode, ...args] array. */
  private async goToDest(dest: unknown) {
    const pdf = this.pdf
    if (!pdf) return
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
    if (!Array.isArray(explicit)) return
    const [ref, mode, ...args] = explicit
    const index = typeof ref === 'object' && ref ? await pdf.getPageIndex(ref) : Number(ref)
    const pv = this.pages[index]
    if (!pv) return

    // XYZ is [left, top, zoom]; FitH and FitBH are [top]. Other modes show the whole page.
    const name = mode?.name
    const top = name === 'XYZ' ? args[1] : name === 'FitH' || name === 'FitBH' ? args[0] : null
    let y = 0
    if (typeof top === 'number') {
      const base = (await pdf.getPage(index + 1)).getViewport({ scale: 1 })
      y = clamp(base.convertToViewportPoint(0, top)[1] / base.height, 0, 1)
    }
    this.scroller.scrollTop = pv.el.offsetTop + y * pv.el.offsetHeight - 16
  }

  // Zoom and navigation

  private fitScale() {
    const w = this.pages[0]?.w ?? 612
    // Leave room for padding and a vertical scrollbar; cap the width so lines stay readable.
    return clamp(Math.min(this.scroller.clientWidth - 80, 1000) / w, MIN_SCALE, 2)
  }

  private fit() {
    this.meta.zoom = undefined
    this.setScale(this.fitScale())
    this.saveProgress()
  }

  private zoom(factor: number, anchor?: { clientX: number; clientY: number }) {
    this.setScale(this.scale * factor, anchor)
    this.meta.zoom = this.scale
    this.saveProgress()
  }

  private setScale(next: number, anchor?: { clientX: number; clientY: number }) {
    next = clamp(next, MIN_SCALE, MAX_SCALE)
    if (!this.pages.length || Math.abs(next - this.scale) < 0.001) return

    // Keep the point under the cursor (or the viewport center) fixed while zooming.
    const sc = this.scroller
    const box = sc.getBoundingClientRect()
    const ax = anchor ? anchor.clientX - box.left : sc.clientWidth / 2
    const ay = anchor ? anchor.clientY - box.top : sc.clientHeight / 2
    const pv = this.pageAt(sc.scrollTop + ay)
    const fy = (sc.scrollTop + ay - pv.el.offsetTop) / pv.el.offsetHeight
    const fx = (sc.scrollLeft + ax) / sc.scrollWidth

    this.scale = next
    this.gen++
    for (const p of this.pages) {
      p.task?.cancel()
      this.applySize(p)
    }
    sc.scrollTop = pv.el.offsetTop + fy * pv.el.offsetHeight - ay
    sc.scrollLeft = fx * sc.scrollWidth - ax

    this.updateZoomLabel()
    this.hideToolbar()
    this.rerender()
  }

  private updateZoomLabel() {
    this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`
  }

  private pageAt(y: number) {
    let lo = 0
    let hi = this.pages.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.pages[mid].el.offsetTop <= y) lo = mid
      else hi = mid - 1
    }
    return this.pages[lo]
  }

  private updateCurrent() {
    const pv = this.pageAt(this.scroller.scrollTop + this.scroller.clientHeight * 0.3)
    this.current = pv.index
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(pv.index + 1)
    this.saveProgress()
  }

  private goTo(index: number) {
    const pv = this.pages[clamp(Math.round(index) || 0, 0, this.pages.length - 1)]
    if (pv) this.scroller.scrollTop = pv.el.offsetTop - 16
    this.pageInput.value = String(this.current + 1)
  }

  private saveProgress = debounce(() => {
    const pv = this.pages[this.current]
    if (!pv) return
    this.meta.lastPage = pv.index
    this.meta.lastOffset = (this.scroller.scrollTop - pv.el.offsetTop) / pv.el.offsetHeight
    void db.putDoc(this.meta)
  }, 400)

  // Selection

  private captureSelection(): Selection | null {
    const sel = getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null
    const range = sel.getRangeAt(0)
    if (!this.pagesEl.contains(range.commonAncestorContainer)) return null
    const text = sel.toString().replace(/\s+/g, ' ').trim()
    if (!text) return null

    const pageOf = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>('[data-page]')
    const start = pageOf(range.startContainer)
    const end = pageOf(range.endContainer)
    const lo = start ? Number(start.dataset.page) : 0
    const hi = end ? Number(end.dataset.page) : this.pages.length - 1
    const boxes = this.pages.slice(lo, hi + 1).map((pv) => ({ index: pv.index, box: pv.el.getBoundingClientRect() }))

    const rects: Rect[] = []
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const hit = boxes.find(({ box: b }) => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom)
      // Very tall boxes are layout containers swept into the range, not text.
      if (!hit || r.height > hit.box.height * 0.15) continue
      const b = hit.box
      rects.push({
        page: hit.index,
        x: (r.left - b.left) / b.width,
        y: (r.top - b.top) / b.height,
        w: r.width / b.width,
        h: r.height / b.height,
      })
    }
    return rects.length ? { text, rects: mergeRects(rects) } : null
  }

  private showToolbar() {
    const sel = this.pending
    if (!sel) return
    const first = sel.rects[0]
    const last = sel.rects[sel.rects.length - 1]
    const b1 = this.pages[first.page].el.getBoundingClientRect()
    const b2 = this.pages[last.page].el.getBoundingClientRect()

    const tb = this.toolbar
    tb.classList.replace('hidden', 'flex')
    const above = b1.top + first.y * b1.height - tb.offsetHeight - 10
    const below = b2.top + (last.y + last.h) * b2.height + 10
    const cx = b1.left + (first.x + first.w / 2) * b1.width
    tb.style.top = `${above > 56 ? above : below}px`
    tb.style.left = `${clamp(cx - tb.offsetWidth / 2, 8, innerWidth - tb.offsetWidth - 8)}px`
  }

  private hideToolbar() {
    this.toolbar.classList.replace('flex', 'hidden')
  }

  private hitTest(e: MouseEvent) {
    const pageEl = (e.target as Element | null)?.closest<HTMLElement>('[data-page]')
    if (!pageEl) return null
    const page = Number(pageEl.dataset.page)
    const b = pageEl.getBoundingClientRect()
    const x = (e.clientX - b.left) / b.width
    const y = (e.clientY - b.top) / b.height
    let best: Highlight | null = null
    for (const hl of this.highlights) {
      if (best && hl.createdAt < best.createdAt) continue
      if (hl.rects.some((r) => r.page === page && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) best = hl
    }
    return best
  }

  // Highlights

  private createFromSelection(color: Color, withNote = false) {
    const sel = this.pending
    if (!sel) return
    const hl: Highlight = {
      id: uid(),
      docId: this.meta.id,
      text: sel.text,
      color,
      rects: sel.rects,
      notes: [],
      createdAt: Date.now(),
    }
    this.highlights.push(hl)
    void db.putHighlight(hl)
    this.setColor(color)
    getSelection()?.removeAllRanges()
    this.pending = null
    this.hideToolbar()
    this.paintFor(hl)
    if (withNote) this.setActive(hl.id, { focus: true })
    else this.renderSidebar()
  }

  private recolor(hl: Highlight, color: Color) {
    hl.color = color
    void db.putHighlight(hl)
    this.setColor(color)
    this.paintFor(hl)
    this.renderSidebar()
  }

  private remove(hl: Highlight) {
    if (hl.notes.length && !confirm('Delete this highlight and its notes?')) return
    this.highlights = this.highlights.filter((x) => x !== hl)
    void db.deleteHighlight(hl.id)
    this.expanded.delete(hl.id)
    if (this.activeId === hl.id) this.activeId = null
    this.paintFor(hl)
    this.renderSidebar()
  }

  private addNote(hl: Highlight, body: string) {
    hl.notes.push({ id: uid(), body, createdAt: Date.now() })
    this.drafts.delete(hl.id)
    void db.putHighlight(hl)
    this.renderSidebar()
    this.list.querySelector<HTMLTextAreaElement>(`[data-id="${hl.id}"] textarea`)?.focus()
  }

  /** Saves an edited note; clearing all its text deletes it. */
  private updateNote(hl: Highlight, note: Note, body: string) {
    if (!body) return this.deleteNote(hl, note.id)
    if (body !== note.body) {
      note.body = body
      void db.putHighlight(hl)
    }
    this.renderSidebar()
  }

  private deleteNote(hl: Highlight, noteId: string) {
    hl.notes = hl.notes.filter((n) => n.id !== noteId)
    void db.putHighlight(hl)
    this.renderSidebar()
  }

  private setColor(color: Color) {
    this.color = color
    store.set('color', color)
  }

  private find(id: string | null) {
    return id ? this.highlights.find((x) => x.id === id) : undefined
  }

  private setActive(id: string | null, opts: { reveal?: boolean; focus?: boolean; scroll?: boolean } = {}) {
    const prev = this.find(this.activeId)
    const next = this.find(id)
    this.activeId = next?.id ?? null
    if (next) this.expanded.add(next.id)
    if (prev) this.paintFor(prev)
    if (next && next !== prev) this.paintFor(next)
    this.renderSidebar()
    if (!next) return

    if ((opts.reveal || opts.focus) && !this.sidebarOpen) this.toggleSidebar(true)
    const card = this.list.querySelector<HTMLElement>(`[data-id="${next.id}"]`)
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    if (opts.focus) card?.querySelector('textarea')?.focus()
    if (opts.scroll) this.scrollTo(next)
  }

  private scrollTo(hl: Highlight) {
    const r = hl.rects[0]
    const pv = this.pages[r.page]
    const sc = this.scroller
    const top = clamp(pv.el.offsetTop + r.y * pv.el.offsetHeight - sc.clientHeight * 0.3, 0, sc.scrollHeight - sc.clientHeight)

    const flash = () => {
      for (const el of this.pagesEl.querySelectorAll<HTMLElement>(`.hl[data-id="${hl.id}"]`)) {
        el.classList.remove('flash')
        void el.offsetWidth
        el.classList.add('flash')
      }
    }
    if (Math.abs(top - sc.scrollTop) < 2) return void setTimeout(flash, 50)

    // Flash once the scroll lands, so it's seen even after a jump of several pages.
    let done = false
    const land = () => {
      if (done) return
      done = true
      sc.removeEventListener('scrollend', land)
      flash()
    }
    sc.addEventListener('scrollend', land)
    setTimeout(land, 1500)
    sc.scrollTo({ top, behavior: 'smooth' })
  }

  private paint(pv: PageView) {
    const pct = (n: number) => `${n * 100}%`
    const els: HTMLElement[] = []
    for (const hl of this.highlights) {
      for (const r of hl.rects) {
        if (r.page !== pv.index) continue
        els.push(
          h('div', {
            class: hl.id === this.activeId ? 'hl active' : 'hl',
            'data-id': hl.id,
            'data-color': hl.color,
            style: { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) },
          }),
        )
      }
    }
    pv.layer.replaceChildren(...els)
  }

  private paintFor(hl: Highlight) {
    for (const page of new Set(hl.rects.map((r) => r.page))) this.paint(this.pages[page])
  }

  // Sidebar

  private toggleSidebar(open = !this.sidebarOpen) {
    this.sidebarOpen = open
    store.set('sidebar', open)
    this.applySidebar()
    if (this.meta.zoom == null && this.pages.length) this.setScale(this.fitScale())
  }

  private applySidebar() {
    this.sidebar.classList.toggle('hidden', !this.sidebarOpen)
    this.sidebar.classList.toggle('flex', this.sidebarOpen)
  }

  private renderSidebar() {
    const n = this.highlights.length
    this.count.textContent = n ? String(n) : ''
    if (!n) {
      const kbd = (k: string) => h('kbd', { class: 'rounded border border-line bg-surface px-1.5 py-0.5 font-sans text-[11px] text-ink' }, k)
      this.list.replaceChildren(
        h(
          'div',
          { class: 'px-6 py-20 text-center' },
          h('p', { class: 'font-serif text-xl text-ink' }, 'Nothing highlighted yet'),
          h(
            'p',
            { class: 'mt-3 text-[13px] leading-relaxed text-muted' },
            'Select text on the page, then press ', kbd('h'), ' to highlight or ', kbd('n'), ' to add a note.',
          ),
        ),
      )
      return
    }
    const sorted = [...this.highlights].sort((a, b) => {
      const ra = a.rects[0]
      const rb = b.rects[0]
      return ra.page - rb.page || ra.y - rb.y || ra.x - rb.x
    })
    this.list.replaceChildren(...sorted.map((hl) => this.card(hl)))
  }

  /** A note, or the editor for it while it is being edited. */
  private noteView(hl: Highlight, note: Note) {
    const box = 'relative mt-2 ml-[15px] rounded-lg border bg-surface text-[13.5px] leading-relaxed text-ink'

    if (this.editingNote === note.id) {
      let done = false
      const finish = (save: boolean) => {
        if (done) return
        done = true
        this.editingNote = null
        if (save) this.updateNote(hl, note, ta.value.trim())
        else this.renderSidebar()
      }
      const grow = () => growToFit(ta)
      const ta = h('textarea', {
        class: `${box} block w-[calc(100%-15px)] resize-none overflow-hidden border-line-strong px-3 py-2 outline-none`,
        value: note.body,
        rows: 1,
        'aria-label': 'Edit note',
        onclick: (e: MouseEvent) => e.stopPropagation(),
        oninput: grow,
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            finish(false)
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            finish(true)
          }
        },
        // Switching to another window isn't "clicking away": keep editing until focus moves within the page.
        onblur: () => document.hasFocus() && finish(true),
      })
      return ta
    }

    const action = (name: 'pencil' | 'x', title: string, run: () => void) =>
      h(
        'button',
        {
          class: 'grid size-6 place-items-center rounded-md text-muted transition hover:bg-ink/5 hover:text-ink',
          title,
          onclick: (e: MouseEvent) => {
            e.stopPropagation()
            run()
          },
        },
        icon(name, 'size-3.5'),
      )

    return h(
      'div',
      {
        class: `group/note ${box} cursor-text border-line px-3 py-2 pr-16 whitespace-pre-wrap break-words`,
        title: 'Click to edit',
        onclick: (e: MouseEvent) => {
          e.stopPropagation()
          this.editNote(note.id)
        },
      },
      note.body,
      h(
        'div',
        { class: 'absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 transition group-hover/note:opacity-100' },
        action('pencil', 'Edit note', () => this.editNote(note.id)),
        action('x', 'Delete note', () => this.deleteNote(hl, note.id)),
      ),
    )
  }

  private editNote(id: string) {
    this.editingNote = id
    this.renderSidebar()
    // Focus right away (not on the next frame), so clicking elsewhere always saves via blur.
    const ta = this.list.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit note"]')
    if (!ta) return
    growToFit(ta)
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
  }

  private toggleExpanded(hl: Highlight) {
    if (!this.expanded.delete(hl.id)) this.expanded.add(hl.id)
    this.renderSidebar()
  }

  private card(hl: Highlight) {
    const active = hl.id === this.activeId
    const open = this.expanded.has(hl.id)

    const quote = h(
      'div',
      { class: 'flex items-start gap-3' },
      h('span', { class: `w-[3px] shrink-0 self-stretch rounded-full ${SWATCH[hl.color]}` }),
      h('p', { class: `min-w-0 flex-1 font-serif text-[15px] leading-[1.5] text-ink ${open ? '' : 'truncate'}` }, hl.text),
      h(
        'button',
        {
          class: 'grid size-6 shrink-0 place-items-center rounded-md text-muted transition hover:bg-ink/5 hover:text-ink',
          title: open ? 'Collapse' : 'Expand',
          'aria-expanded': String(open),
          onclick: (e: MouseEvent) => {
            e.stopPropagation()
            this.toggleExpanded(hl)
          },
        },
        icon('chevron', `size-4 transition-transform ${open ? 'rotate-180' : ''}`),
      ),
    )

    const notes = hl.notes.map((note) => this.noteView(hl, note))

    let editor: HTMLElement | null = null
    if (open) {
      const grow = () => {
        ta.style.height = 'auto'
        ta.style.height = `${ta.scrollHeight}px`
      }
      const ta = h('textarea', {
        rows: 1,
        placeholder: hl.notes.length ? 'Add another note…' : 'Add a note…',
        class: 'block w-full resize-none bg-transparent px-3 py-2 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-muted',
        value: this.drafts.get(hl.id) ?? '',
        oninput: () => {
          this.drafts.set(hl.id, ta.value)
          grow()
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key !== 'Enter' || e.shiftKey) return
          e.preventDefault()
          const body = ta.value.trim()
          if (body) this.addNote(hl, body)
        },
      })
      requestAnimationFrame(grow)

      editor = h(
        'div',
        { class: 'mt-2 ml-[15px]' },
        h('div', { class: 'rounded-lg border border-line bg-surface transition focus-within:border-line-strong' }, ta),
        h(
          'div',
          { class: 'mt-2.5 flex items-center gap-2' },
          COLORS.map((c) =>
            h('button', {
              class: `size-3.5 rounded-full ${SWATCH[c]} transition ${c === hl.color ? 'ring-2 ring-muted/50 ring-offset-2 ring-offset-paper' : 'opacity-60 hover:opacity-100'}`,
              title: c,
              onclick: (e: MouseEvent) => {
                e.stopPropagation()
                this.recolor(hl, c)
              },
            }),
          ),
          h('span', { class: 'flex-1' }),
          h(
            'button',
            {
              class: 'flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted transition hover:bg-ink/5 hover:text-ink',
              onclick: (e: MouseEvent) => {
                e.stopPropagation()
                this.remove(hl)
              },
            },
            icon('trash', 'size-3.5'),
            'Delete',
          ),
        ),
      )
    }

    const details = [`p. ${hl.rects[0].page + 1}`, timeAgo(hl.createdAt)]
    if (!open && hl.notes.length) details.push(`${hl.notes.length} note${hl.notes.length > 1 ? 's' : ''}`)
    const footer = h('div', { class: 'mt-2 pl-[15px] text-[11px] text-muted' }, details.join(' · '))

    return h(
      'article',
      {
        'data-id': hl.id,
        class: `cursor-pointer rounded-xl p-3 transition ${active ? 'bg-ink/[0.04]' : 'hover:bg-ink/[0.025]'}`,
        onclick: (e: MouseEvent) => {
          if ((e.target as Element).closest('textarea')) return
          this.setActive(hl.id, { scroll: true })
        },
      },
      quote,
      open && notes,
      editor,
      footer,
    )
  }
}

/** Sizes a textarea to its content, borders included, so it never shows a scrollbar. */
function growToFit(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto'
  ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`
}

/** Collapses the per-span boxes of a selection into one box per line. */
function mergeRects(rects: Rect[]): Rect[] {
  const gap = 0.015
  const out: Rect[] = []
  for (const r of [...rects].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)) {
    const m = out.find(
      (o) =>
        o.page === r.page &&
        Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y) > 0.5 * Math.min(o.h, r.h) &&
        r.x <= o.x + o.w + gap &&
        r.x + r.w >= o.x - gap,
    )
    if (!m) {
      out.push({ ...r })
      continue
    }
    const x = Math.min(m.x, r.x)
    const y = Math.min(m.y, r.y)
    m.w = Math.max(m.x + m.w, r.x + r.w) - x
    m.h = Math.max(m.y + m.h, r.y + r.h) - y
    m.x = x
    m.y = y
  }
  const round = (n: number) => Math.round(n * 1e5) / 1e5
  return out.map((r) => ({ page: r.page, x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) }))
}
