# Reader demo storyboard

About 50 seconds at 1080p and 60 fps, with a calm original soundtrack and a soft click on every click
(both synthesized in `demo/audio.mjs`, so they are free to use anywhere).
The camera stays at full view, apart from two short zooms marked below.

| # | On screen | Camera | Suggested voiceover |
|---|-----------|--------|---------------------|
| 1 | Landing page in light mode. The highlighter sweeps under "Keep what matters." | Full view | "Reader is a calm PDF reader that lives in your browser." |
| 2 | The cursor glides to **Open a PDF** and clicks. The essay opens (the loading moment is cut). | Full view | "Open any PDF. Nothing gets uploaded." |
| 3 | Click **III. Marginalia** in the table of contents. The view jumps to that section. | Full view | "Links work, including the ones inside the document." |
| 4 | Drag-select a sentence. The toolbar pops up, the cursor picks **amber**, and the highlight appears. | **Zoom 1:** 1.5× on the sentence, about 3 s | "Select a passage and highlight it." |
| 5 | Select a longer passage, click **Note**, and type "This is why I keep a pencil nearby." Enter. | **Zoom 2:** 1.4× on the note while typing | "Add notes, as many as you like." |
| 6 | Collapse and expand the long highlight in the sidebar. | Full view | "Long passages fold away to keep things tidy." |
| 7 | Scroll back up to the first page, then click the first highlight in the sidebar. The view glides three pages down and the highlight flashes. | Full view | "Every highlight is one click away, wherever it is." |
| 8 | Click the theme toggle. Everything turns dark. | Full view | "Light or dark, whichever you like." |
| 9 | Back to the library. A cover with a progress bar and "2 highlights" appears. | Full view | "Everything is saved, and you pick up right where you left off." |
| 10 | The cursor eases away. Hold. | Full view | "Reader. Read slowly, keep what matters." |

## Re-recording

```bash
npm run demo
```

The recorder starts its own dev server and a fresh browser profile, so every take starts from an empty library.
It writes `demo/out/reader-demo.mp4`. To change only the rendering (cursor, sound) without re-recording, run
`node demo/record.mjs --render-only`.
