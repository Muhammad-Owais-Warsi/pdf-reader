import './style.css'
import { renderLibrary } from './library'
import { importPdf } from './pdf'
import { openReader } from './reader'
import { h } from './util'

const app = document.getElementById('app')!
let dispose: (() => void) | undefined

async function route() {
  dispose?.()
  dispose = undefined
  const match = location.hash.match(/^#\/doc\/(\w+)/)
  dispose = match ? await openReader(app, match[1]) : renderLibrary(app, open)
}

async function open(files: File[]) {
  const file = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name))
  if (!file) return
  try {
    const id = await importPdf(file)
    if (location.hash === `#/doc/${id}`) void route()
    else location.hash = `#/doc/${id}`
  } catch (err) {
    console.error(err)
    alert(`Couldn't open “${file.name}”. Is it a valid PDF?`)
  }
}

// Drop a PDF anywhere, in the library or while reading.
const root = document.documentElement
document.body.append(
  h(
    'div',
    { class: 'pointer-events-none fixed inset-3 z-[100] hidden place-items-center rounded-3xl border-2 border-dashed border-ink/25 bg-paper/85 backdrop-blur-sm in-[.dragging]:grid' },
    h(
      'div',
      { class: 'text-center' },
      h('p', { class: 'font-serif text-4xl text-ink' }, 'Drop to open'),
      h('p', { class: 'mt-2 text-sm text-muted' }, 'It stays on this device'),
    ),
  ),
)
addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  root.classList.add('dragging')
})
addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) root.classList.remove('dragging')
})
addEventListener('drop', (e) => {
  e.preventDefault()
  root.classList.remove('dragging')
  void open([...(e.dataTransfer?.files ?? [])])
})

addEventListener('hashchange', route)
void route()
