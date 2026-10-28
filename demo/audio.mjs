// The demo's soundtrack, synthesized from scratch so it is free to use anywhere:
// a calm ambient loop in D major (soft pads, a kalimba-like arpeggio, a warm bass, reverb)
// plus a soft wooden "tock" at every click.

import fs from 'node:fs'

const SR = 48000
const TAU = Math.PI * 2
const BPM = 70
const BEAT = 60 / BPM
const BAR = BEAT * 4

const midi = (m) => 440 * 2 ** ((m - 69) / 12)

/** One bar each: Dmaj7 – Bm7 – Gmaj7 – A6. */
const CHORDS = [
  { bass: 50, pad: [62, 66, 69, 73], arp: [74, 78, 81, 85] },
  { bass: 47, pad: [59, 62, 66, 69], arp: [71, 74, 78, 81] },
  { bass: 43, pad: [55, 59, 62, 66], arp: [67, 71, 74, 78] },
  { bass: 45, pad: [57, 61, 64, 66], arp: [69, 73, 76, 78] },
]
/** Which eighth notes of a bar play, and which chord tone each one takes. */
const ARP_HITS = [1, 0, 1, 1, 0, 1, 0, 1]
const ARP_ORDER = [0, 2, 1, 3, 2, 1, 3, 2]

/**
 * Writes a 48 kHz stereo WAV of `duration` seconds, with a click at each time in `clicks` (seconds).
 */
export function writeAudio(file, duration, clicks) {
  const n = Math.ceil(duration * SR)
  const dry = [new Float32Array(n), new Float32Array(n)]
  const send = [new Float32Array(n), new Float32Array(n)]

  for (let b = 0; b * BAR < duration; b++) {
    const chord = CHORDS[b % CHORDS.length]
    const t0 = b * BAR
    chord.pad.forEach((m, i) => pad(send, t0, midi(m), i % 2 ? 0.3 : -0.3))
    bass(dry, t0, midi(chord.bass - 12))
    // Let the arpeggio enter after the first two bars.
    if (b < 2) continue
    ARP_HITS.forEach((hit, i) => {
      if (!hit) return
      const note = chord.arp[ARP_ORDER[i]]
      pluck(send, t0 + (i * BEAT) / 2, midi(note), 0.07 + 0.02 * (i % 3), Math.sin(i * 1.7) * 0.5)
    })
  }

  for (const t of clicks) {
    tock(dry, t, 0.32)
    tock(send, t, 0.06)
  }

  const wet = reverb(send)
  const out = [new Float32Array(n), new Float32Array(n)]
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < n; i++) out[c][i] = dry[c][i] + send[c][i] * 0.75 + wet[c][i] * 0.45
  }
  master(out, duration)
  fs.writeFileSync(file, wav(out))
}

function add(buf, i, v, pan) {
  // Equal-power pan, -1 (left) to 1 (right).
  const a = ((pan + 1) * Math.PI) / 4
  buf[0][i] += v * Math.cos(a)
  buf[1][i] += v * Math.sin(a)
}

/** A slow, soft swell held for the bar, fading into the next. */
function pad(buf, t0, f, pan) {
  const attack = 1.6
  const release = 1.8
  const len = BAR + release
  const start = Math.round(t0 * SR)
  for (let i = 0; i < len * SR && start + i < buf[0].length; i++) {
    const t = i / SR
    const env = Math.min(1, t / attack) * (t > BAR ? Math.max(0, 1 - (t - BAR) / release) : 1)
    const wobble = 1 + 0.04 * Math.sin(TAU * 0.3 * t)
    const v =
      Math.sin(TAU * f * 0.998 * t) + Math.sin(TAU * f * 1.002 * t) + 0.12 * Math.sin(TAU * f * 3 * t)
    add(buf, start + i, v * env * wobble * 0.018, pan)
  }
}

/** A short, bell-like pluck that decays naturally. */
function pluck(buf, t0, f, amp, pan) {
  const start = Math.round(t0 * SR)
  for (let i = 0; i < 2.4 * SR && start + i < buf[0].length; i++) {
    const t = i / SR
    const env = (1 - Math.exp(-t / 0.004)) * Math.exp(-t / 0.6)
    const v =
      Math.sin(TAU * f * t) +
      0.3 * Math.sin(TAU * f * 2 * t) * Math.exp(-t / 0.25) +
      0.1 * Math.sin(TAU * f * 4.2 * t) * Math.exp(-t / 0.08)
    add(buf, start + i, v * env * amp, pan)
  }
}

function bass(buf, t0, f) {
  const start = Math.round(t0 * SR)
  for (let i = 0; i < (BAR + 0.6) * SR && start + i < buf[0].length; i++) {
    const t = i / SR
    const env = Math.min(1, t / 0.25) * Math.exp(-t / 2.2) * (t > BAR ? Math.max(0, 1 - (t - BAR) / 0.6) : 1)
    const v = Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * f * 2 * t)
    add(buf, start + i, v * env * 0.11, 0)
  }
}

/** A soft wooden click: two damped tones and a breath of noise. */
function tock(buf, t0, amp) {
  const start = Math.round(t0 * SR)
  let seed = 7
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  for (let i = 0; i < 0.12 * SR && start + i < buf[0].length; i++) {
    const t = i / SR
    const v =
      0.6 * Math.sin(TAU * 1050 * t) * Math.exp(-t / 0.011) +
      0.5 * Math.sin(TAU * 520 * t) * Math.exp(-t / 0.024) +
      0.12 * noise() * Math.exp(-t / 0.002)
    add(buf, start + i, v * amp, 0)
  }
}

/** A small Schroeder reverb: parallel damped combs into series allpasses, one set per channel. */
function reverb([l, r]) {
  const process = (input, spread) => {
    const out = new Float32Array(input.length)
    for (const len of [1557, 1617, 1491, 1422, 1277, 1356]) {
      const d = Math.round(((len + spread) * SR) / 44100)
      const line = new Float32Array(d)
      let idx = 0
      let low = 0
      for (let i = 0; i < input.length; i++) {
        const y = line[idx]
        low = y * 0.7 + low * 0.3
        line[idx] = input[i] + low * 0.86
        out[i] += y / 6
        idx = (idx + 1) % d
      }
    }
    for (const len of [556, 441, 341]) {
      const d = Math.round(((len + spread) * SR) / 44100)
      const line = new Float32Array(d)
      let idx = 0
      for (let i = 0; i < out.length; i++) {
        const y = line[idx]
        line[idx] = out[i] + y * 0.5
        out[i] = y - out[i] * 0.5
        idx = (idx + 1) % d
      }
    }
    return out
  }
  return [process(l, 0), process(r, 23)]
}

/** Fades in and out, then normalizes to a comfortable peak. */
function master(out, duration) {
  const n = out[0].length
  let peak = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const fade = Math.min(1, t / 1.5) * Math.min(1, (duration - t) / 3)
    for (const ch of out) {
      ch[i] *= fade
      peak = Math.max(peak, Math.abs(ch[i]))
    }
  }
  const gain = peak > 0 ? 0.85 / peak : 1
  for (const ch of out) for (let i = 0; i < n; i++) ch[i] *= gain
}

function wav([l, r]) {
  const n = l.length
  const buf = Buffer.alloc(44 + n * 4)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 4, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 4, 40)
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l[i])) * 32767), 44 + i * 4)
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r[i])) * 32767), 46 + i * 4)
  }
  return buf
}
