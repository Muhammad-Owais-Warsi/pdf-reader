import { h, icon, store } from './util'

type Theme = 'system' | 'light' | 'dark'

const ORDER: Theme[] = ['system', 'light', 'dark']
const ICON = { system: 'monitor', light: 'sun', dark: 'moon' } as const
const LABEL = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' }

const media = matchMedia('(prefers-color-scheme: dark)')
let theme = store.get<Theme>('theme', 'system')
const buttons = new Set<HTMLButtonElement>()

function paint(b: HTMLButtonElement) {
  b.replaceChildren(icon(ICON[theme]))
  b.title = LABEL[theme]
}

function apply() {
  const dark = theme === 'dark' || (theme === 'system' && media.matches)
  document.documentElement.classList.toggle('dark', dark)
  for (const b of buttons) {
    // Buttons from views that have since been replaced.
    if (!b.isConnected) buttons.delete(b)
    else paint(b)
  }
}

media.addEventListener('change', apply)
apply()

/** A button that cycles system → light → dark. */
export function themeButton(cls: string) {
  const b = h('button', {
    class: cls,
    onclick: () => {
      theme = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]
      store.set('theme', theme)
      apply()
    },
  })
  buttons.add(b)
  paint(b)
  return b
}
