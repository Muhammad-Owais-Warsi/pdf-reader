import * as db from './db'
import type { DocMeta } from './db'
import { ensureThumb } from './pdf'
import { themeButton } from './theme'
import { h, icon, timeAgo } from './util'

export function renderLibrary(root: HTMLElement, open: (files: File[]) => void) {
  const urls: string[] = []
  const objectUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob)
    urls.push(url)
    return url
  }

  const input = h('input', {
    type: 'file',
    accept: 'application/pdf,.pdf',
    class: 'hidden',
    onchange: () => input.files && open([...input.files]),
  })
  const browse = () => input.click()

  const grid = h('div', { class: 'mt-8 grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-4' })
  const count = h('span', { class: 'text-[13px] text-muted' })
  const recent = h(
    'section',
    { class: 'hidden pb-24' },
    h(
      'div',
      { class: 'flex items-baseline justify-between border-t border-line pt-10' },
      h('h2', { class: 'font-serif text-[28px] tracking-tight text-ink' }, 'Continue reading'),
      count,
    ),
    grid,
  )

  root.replaceChildren(
    h(
      'div',
      { class: 'library-glow min-h-dvh' },
      h(
        'div',
        { class: 'mx-auto max-w-6xl px-6' },
        nav(browse),
        hero(browse),
        recent,
        footer(),
      ),
      input,
    ),
  )

  void (async () => {
    const docs = await db.listDocs()
    const counts = await Promise.all(docs.map((d) => db.countHighlights(d.id)))
    const update = () => {
      const n = grid.childElementCount
      recent.classList.toggle('hidden', !n)
      count.textContent = `${n} document${n === 1 ? '' : 's'}`
    }
    grid.replaceChildren(
      ...docs.map((doc, i) =>
        cover(doc, counts[i], objectUrl, async () => {
          if (!confirm(`Remove “${doc.name}” and all its highlights?`)) return
          await db.deleteDoc(doc.id)
          grid.querySelector(`[data-id="${doc.id}"]`)?.remove()
          update()
        }),
      ),
    )
    update()

    // Documents added before covers existed get one now, one at a time.
    for (const doc of docs) {
      if (doc.thumb) continue
      const thumb = await ensureThumb(doc.id).catch(() => undefined)
      const img = grid.querySelector<HTMLImageElement>(`[data-id="${doc.id}"] img`)
      if (thumb && img) {
        img.src = objectUrl(thumb)
        img.classList.remove('hidden')
      }
    }
  })()

  return () => urls.forEach((u) => URL.revokeObjectURL(u))
}

function logo() {
  return h('img', { src: '/icon-192.png', alt: '', class: 'size-8' })
}

function nav(browse: () => void) {
  return h(
    'nav',
    { class: 'flex h-20 items-center justify-between' },
    h('a', { href: '#', class: 'flex items-center gap-2.5' }, logo(), h('span', { class: 'font-serif text-[22px] tracking-tight text-ink' }, 'Reader')),
    h(
      'div',
      { class: 'flex items-center gap-1' },
      h(
        'button',
        {
          class: 'rounded-full px-4 py-2 text-[13px] font-medium text-ink transition hover:bg-ink/5',
          onclick: browse,
        },
        'Open a PDF',
      ),
      themeButton('grid size-9 place-items-center rounded-full text-muted transition hover:bg-ink/5 hover:text-ink'),
    ),
  )
}

function hero(browse: () => void) {
  const point = (text: string) =>
    h('li', { class: 'flex items-center gap-2' }, h('span', { class: 'size-1 rounded-full bg-muted/60' }), text)

  return h(
    'section',
    { class: 'grid items-center gap-16 pt-10 pb-24 md:grid-cols-[1.05fr_1fr] md:pt-16 md:pb-32' },
    h(
      'div',
      {},
      h(
        'h1',
        { class: 'font-serif text-[52px] leading-[1.02] tracking-[-0.02em] text-ink sm:text-[68px]' },
        'Read slowly.',
        h('br'),
        h('em', { class: 'marker' }, 'Keep what matters.'),
      ),
      h(
        'p',
        { class: 'mt-7 max-w-md text-[17px] leading-relaxed text-muted' },
        'A calm, distraction-free PDF reader. Highlight passages, gather your thoughts in notes, and pick up exactly where you left off.',
      ),
      h(
        'div',
        { class: 'mt-10 flex flex-wrap items-center gap-x-5 gap-y-3' },
        h(
          'button',
          {
            class: 'group inline-flex items-center gap-2.5 rounded-full bg-ink py-3 pr-6 pl-5 text-[15px] font-medium text-paper shadow-lg shadow-ink/10 transition hover:-translate-y-px hover:shadow-xl hover:shadow-ink/15 active:translate-y-0',
            onclick: browse,
          },
          icon('upload', 'size-[18px] transition group-hover:-translate-y-0.5'),
          'Open a PDF',
        ),
        h('span', { class: 'text-sm text-muted' }, 'or drop one anywhere'),
      ),
      h(
        'ul',
        { class: 'mt-12 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-muted' },
        point('No account'),
        point('Nothing uploaded'),
        point('Highlights saved automatically'),
      ),
    ),
    illustration(),
  )
}

/** A page mid-read: highlighted lines, the selection toolbar and a note. */
function illustration() {
  const line = (w: string, hl?: 'amber' | 'sage' | 'rose') =>
    h('div', {
      class: hl ? `illo-hl illo-hl-${hl} relative h-2 rounded-full bg-black/[0.14]` : 'h-2 rounded-full bg-black/[0.09]',
      style: { width: w },
    })

  const sheet = h(
    'div',
    { class: 'illo-sheet absolute top-4 left-1/2 w-[300px] -translate-x-1/2 -rotate-[1.5deg] rounded-[3px] bg-white px-8 pt-9 pb-10 shadow-page' },
    h('div', { class: 'h-3.5 w-36 rounded-full bg-black/80' }),
    h('div', { class: 'mt-2 h-2 w-20 rounded-full bg-black/20' }),
    h(
      'div',
      { class: 'mt-7 space-y-[11px]' },
      line('100%'), line('94%'), line('97%'), line('62%'),
    ),
    h(
      'div',
      { class: 'mt-6 space-y-[11px]' },
      line('96%'), line('100%', 'amber'), line('88%', 'amber'), line('97%'), line('91%'), line('45%'),
    ),
    h(
      'div',
      { class: 'mt-6 space-y-[11px]' },
      line('99%'), line('93%'), line('72%', 'sage'), line('95%'), line('58%'),
    ),
  )

  const back = h('div', { class: 'absolute top-9 left-1/2 h-[440px] w-[300px] -translate-x-[42%] rotate-[4deg] rounded-[3px] bg-surface shadow-page' })

  const toolbar = h(
    'div',
    { class: 'illo-float absolute top-[148px] left-[calc(50%-120px)] flex items-center gap-1 rounded-full bg-ink p-1.5 shadow-xl shadow-black/20' },
    ['bg-hl-amber', 'bg-hl-sage', 'bg-hl-rose', 'bg-hl-sky'].map((c) => h('span', { class: `size-5 rounded-full ${c}` })),
    h('span', { class: 'mx-1 h-3.5 w-px bg-paper/25' }),
    h('span', { class: 'flex items-center gap-1 pr-1.5 pl-0.5 text-[11px] font-medium text-paper' }, icon('note', 'size-3'), 'Note'),
  )

  const note = h(
    'div',
    { class: 'illo-float-late absolute right-0 bottom-6 w-[220px] rounded-xl border border-line bg-surface p-4 shadow-xl shadow-black/[0.08] sm:right-2' },
    h(
      'div',
      { class: 'flex gap-2.5' },
      h('span', { class: 'w-[3px] shrink-0 rounded-full bg-hl-amber' }),
      h('p', { class: 'font-serif text-[13px] leading-snug text-muted italic' }, '“…the habit of attention is the whole of reading.”'),
    ),
    h('p', { class: 'mt-3 rounded-lg border border-line bg-paper px-3 py-2 text-[12.5px] leading-relaxed text-ink' }, 'Come back to this before chapter 4.'),
  )

  return h('div', { class: 'relative mx-auto hidden h-[500px] w-full max-w-[460px] sm:block', 'aria-hidden': 'true' }, back, sheet, toolbar, note)
}

function cover(doc: DocMeta, highlights: number, objectUrl: (b: Blob) => string, remove: () => void) {
  const page = (doc.lastPage ?? 0) + 1
  const progress = doc.pages ? page / doc.pages : 0
  const started = doc.lastPage != null && (doc.lastPage > 0 || (doc.lastOffset ?? 0) > 0.05)
  const details = [started ? `Page ${page} of ${doc.pages}` : `${doc.pages} pages`]
  if (highlights) details.push(`${highlights} highlight${highlights === 1 ? '' : 's'}`)

  return h(
    'a',
    { href: `#/doc/${doc.id}`, 'data-id': doc.id, class: 'group block' },
    h(
      'div',
      { class: 'relative aspect-[3/4] overflow-hidden rounded-[4px] bg-white shadow-page transition duration-300 group-hover:-translate-y-1 group-hover:shadow-xl group-hover:shadow-black/10' },
      h(
        'div',
        { class: 'absolute inset-0 grid place-items-center text-black/15' },
        icon('file', 'size-8'),
      ),
      h('img', {
        class: `relative size-full object-cover object-top ${doc.thumb ? '' : 'hidden'}`,
        src: doc.thumb ? objectUrl(doc.thumb) : null,
        alt: '',
        loading: 'lazy',
      }),
      started &&
        h('div', { class: 'absolute inset-x-0 bottom-0 h-1 bg-black/10' }, h('div', { class: 'h-full bg-hl-amber', style: { width: `${Math.max(progress, 0.02) * 100}%` } })),
      h(
        'button',
        {
          class: 'absolute top-2 right-2 grid size-8 place-items-center rounded-full bg-white/90 text-black/60 opacity-0 shadow-sm backdrop-blur transition group-hover:opacity-100 hover:text-black focus:opacity-100',
          title: 'Remove',
          onclick: (e: MouseEvent) => {
            e.preventDefault()
            remove()
          },
        },
        icon('trash', 'size-[15px]'),
      ),
    ),
    h('p', { class: 'mt-4 line-clamp-2 font-serif text-[17px] leading-snug text-ink' }, doc.name),
    h('p', { class: 'mt-1 text-xs text-muted' }, details.join(' · ')),
    h('p', { class: 'mt-0.5 text-xs text-muted/70' }, `Opened ${timeAgo(doc.openedAt)}`),
  )
}

function footer() {
  const key = (k: string, label: string) =>
    h(
      'span',
      { class: 'flex items-center gap-2' },
      h('kbd', { class: 'rounded-md border border-line bg-surface px-1.5 py-0.5 font-sans text-[11px] text-ink' }, k),
      label,
    )
  return h(
    'footer',
    { class: 'flex flex-col gap-4 border-t border-line py-8 text-xs text-muted sm:flex-row sm:items-center sm:justify-between' },
    h('div', { class: 'flex flex-wrap gap-x-5 gap-y-2' }, key('h', 'Highlight'), key('n', 'Note'), key(']', 'Sidebar'), key('Ctrl + scroll', 'Zoom')),
    h('p', {}, 'Stored locally in your browser'),
  )
}
