import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export type Color = 'amber' | 'sage' | 'rose' | 'sky'

export interface DocMeta {
  id: string
  name: string
  size: number
  pages: number
  addedAt: number
  openedAt: number
  lastPage?: number
  /** Scroll offset within lastPage, as a fraction of its height. */
  lastOffset?: number
  /** Set only when the user zoomed manually; otherwise the page fits the width. */
  zoom?: number
  /** A small image of page 1, shown as the cover in the library. */
  thumb?: Blob
}

/** A box on a page, normalized to 0–1 of the page size so it survives zooming. */
export interface Rect {
  page: number
  x: number
  y: number
  w: number
  h: number
}

export interface Note {
  id: string
  body: string
  createdAt: number
}

export interface Highlight {
  id: string
  docId: string
  text: string
  color: Color
  rects: Rect[]
  notes: Note[]
  createdAt: number
}

interface Schema extends DBSchema {
  docs: { key: string; value: DocMeta }
  files: { key: string; value: { id: string; blob: Blob } }
  highlights: { key: string; value: Highlight; indexes: { byDoc: string } }
}

let conn: Promise<IDBPDatabase<Schema>> | undefined

const db = () =>
  (conn ??= openDB<Schema>('reader', 1, {
    upgrade(d) {
      d.createObjectStore('docs', { keyPath: 'id' })
      d.createObjectStore('files', { keyPath: 'id' })
      d.createObjectStore('highlights', { keyPath: 'id' }).createIndex('byDoc', 'docId')
    },
  }))

export async function listDocs() {
  const docs = await (await db()).getAll('docs')
  return docs.sort((a, b) => b.openedAt - a.openedAt)
}

export const getDoc = async (id: string) => (await db()).get('docs', id)

export const putDoc = async (doc: DocMeta) => void (await (await db()).put('docs', doc))

export const getFile = async (id: string) => (await (await db()).get('files', id))?.blob

export async function addDoc(doc: DocMeta, blob: Blob) {
  const tx = (await db()).transaction(['docs', 'files'], 'readwrite')
  await Promise.all([tx.objectStore('docs').put(doc), tx.objectStore('files').put({ id: doc.id, blob }), tx.done])
}

export async function deleteDoc(id: string) {
  const tx = (await db()).transaction(['docs', 'files', 'highlights'], 'readwrite')
  const hs = tx.objectStore('highlights')
  const keys = await hs.index('byDoc').getAllKeys(id)
  await Promise.all([
    tx.objectStore('docs').delete(id),
    tx.objectStore('files').delete(id),
    ...keys.map((k) => hs.delete(k)),
    tx.done,
  ])
}

export const listHighlights = async (docId: string) => (await db()).getAllFromIndex('highlights', 'byDoc', docId)

export const countHighlights = async (docId: string) => (await db()).countFromIndex('highlights', 'byDoc', docId)

export const putHighlight = async (hl: Highlight) => void (await (await db()).put('highlights', hl))

export const deleteHighlight = async (id: string) => (await db()).delete('highlights', id)
