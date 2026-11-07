// Draws the ledger as a shareable receipt image ("4a": a wide, two-column
// receipt in IBM Plex Mono).
//
// Deliberately not a screenshot of the table: this renders only what a payer
// needs to see (who owes what, and why), leaving out the Remove buttons,
// headcount inputs and horizontal scrollbar that a DOM capture would include.
//
// Left column: what the session cost and how the base rate was worked out,
// then extras, credits and the group fund. Right column: per-player amounts,
// with everyone who owes the exact same figure folded into one entry.

import { money } from './calc'

const C = {
  paper: '#FFFDF8',
  ink: '#1A1A18',
  soft: '#5E5A52',
  line: '#4A473F',
  rule: '#B9B3A6',
  ruleLight: '#D5CFC2',
  owe: '#B3261E',
  back: '#1E7A3E',
}

const FONT = "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace"

const W = 840
const PAD_X = 36
const PAD_TOP = 36
const PAD_BOTTOM = 28
const COL_GAP = 36
const SCALE = 2
const LH = 21 // 14px × 1.5
const LH_BIG = 22.5 // 15px × 1.5

/** ₱1,234.00 / −₱1,234.00 (a true minus sign, as on the design). */
const S = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100
  return (v < 0 ? '−' : '') + '₱' + money(Math.abs(v))
}
const P = (n) => '₱' + money(Math.abs(Number(n) || 0))
const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005
const nonZero = (n) => !near(n, 0)

/** Make sure the receipt font is ready before the canvas draws with it. */
export async function loadLedgerFonts() {
  if (typeof document === 'undefined' || !document.fonts?.load) return
  try {
    await Promise.all(
      ['400', '500', '600'].map((w) => document.fonts.load(`${w} 14px 'IBM Plex Mono'`, '₱0'))
    )
  } catch {
    // fall back to the system monospace; the layout still holds
  }
}

/**
 * Fold rows that owe exactly the same thing into one entry; everyone with
 * their own costs or credits gets a full breakdown instead.
 */
function buildPeople(d) {
  const groups = new Map()
  const specials = []

  for (const r of d.rows) {
    const guest = r.status === 'guest'
    const mixed = r.status === 'mixed'
    const hasOwn = (r.direct || []).length > 0

    if (hasOwn || mixed) {
      const lines = [
        {
          label: r.headcount > 1 ? `Base ${r.headcount} × ${P(d.baseUnit)}` : 'Base (court + shuttles)',
          amount: r.base,
        },
      ]
      if (nonZero(r.guestFee)) lines.push({ label: 'Guest fee → fund', amount: r.guestFee })
      if (nonZero(r.splitShare)) lines.push({ label: 'Shared costs', amount: r.splitShare })
      for (const x of r.direct) lines.push({ label: x.label, amount: x.amount })
      specials.push({ name: r.name, sub: r.sub, guest, mixed, paid: r.paid, partPaid: r.partPaid, lines, total: r.amount })
      continue
    }

    const key = `${guest ? 'g' : 'r'}${r.headcount}:${r.amount.toFixed(2)}`
    if (!groups.has(key)) {
      groups.set(key, { guest, headcount: r.headcount, each: r.amount, splitShare: r.splitShare, names: [] })
    }
    const who = r.sub || r.name
    groups.get(key).names.push(r.paid ? `${who} ✓` : who)
  }

  const rank = (g) => (g.guest ? 2 : 0) + (g.headcount > 1 ? 1 : 0)
  const list = [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.headcount - b.headcount)

  return {
    specials,
    groups: list.map((g) => {
      const n = g.names.length
      let title
      if (g.headcount === 1) title = g.guest ? 'GUESTS' : 'REGULARS'
      else {
        const kind = g.headcount === 2 ? 'PAIRS' : 'GROUPS'
        title = `${g.guest ? 'GUEST ' : ''}${kind} · ${g.headcount} PAX`
      }
      title += ` (${n})`

      let formula
      if (g.headcount === 1) {
        formula = g.guest
          ? `Flat ${P(d.guestRate)} = ${P(d.baseUnit)} base + ${S(d.guestRate - d.baseUnit)} to fund`
          : d.shuttleUnit
            ? `${P(d.courtUnit)} court + ${P(d.shuttleUnit)} shuttles`
            : `${P(d.courtUnit)} court`
      } else {
        formula = `${g.headcount} × ${P(g.guest ? d.guestRate : d.baseUnit)}${g.guest ? ' flat' : ''}`
      }
      if (nonZero(g.splitShare)) {
        formula += ` ${g.splitShare < 0 ? '−' : '+'} ${P(g.splitShare)} shared`
      }

      return { title, each: g.each, formula, names: g.names.join(', ') }
    }),
  }
}

/**
 * @param {Object} d
 * @param {string} d.dateLine    - "Fri, Nov 6, 2026 · Evening"
 * @param {number} d.players     - total headcount
 * @param {number} d.courtTotal
 * @param {number} d.courtUnit
 * @param {Array}  d.shuttles    - { name, count, cost } one per shuttle type used
 * @param {number} d.shuttleTotal
 * @param {number} d.shuttleCount
 * @param {number} d.shuttleUnit
 * @param {number} d.baseUnit    - court + shuttles per player
 * @param {number} d.guestRate   - flat guest rate per head
 * @param {Array}  d.rows        - { name, sub, status, paid, partPaid, headcount,
 *                                   base, guestFee, splitShare, direct:[{label, amount}], amount }
 * @param {Array}  d.extras      - { label, amount, scope } every cost/credit line
 * @param {Object} [d.fund]      - { previous, guestFees, guestHeads, out, balance }
 * @returns {HTMLCanvasElement}
 */
export function drawLedgerCanvas(d) {
  const { groups, specials } = buildPeople(d)
  const colW = (W - PAD_X * 2 - COL_GAP) / 2
  const leftX = PAD_X
  const rightX = PAD_X + colW + COL_GAP

  // Same extras label (e.g. "Dinner" charged to several people) reads as one
  // item with who-owes-what underneath, like the design.
  const byLabel = (items) => {
    const m = new Map()
    for (const x of items) {
      const k = x.label.trim().toLowerCase()
      if (!m.has(k)) m.set(k, { label: x.label.trim(), total: 0, parts: [] })
      const e = m.get(k)
      e.total += x.amount
      e.parts.push(x)
    }
    return [...m.values()]
  }
  const charges = byLabel(d.extras.filter((x) => x.amount > 0))
  const credits = d.extras.filter((x) => x.amount < 0)

  const chargeDetail = (e) => {
    const split = e.parts.filter((p) => !p.scope)
    const direct = e.parts.filter((p) => p.scope)
    const bits = []
    if (split.length && d.players) {
      const sum = split.reduce((s, p) => s + p.amount, 0)
      bits.push(`Split ${d.players} ways · ${P(sum / d.players)} ea`)
    }
    if (direct.length) {
      // "Erik, Mavi ₱1,156 · Charles ₱716"
      const amt = new Map()
      for (const p of direct) {
        const k = p.amount.toFixed(2)
        if (!amt.has(k)) amt.set(k, { amount: p.amount, names: [] })
        amt.get(k).names.push(p.scope)
      }
      const byCount = [...amt.values()].sort((a, b) => b.names.length - a.names.length)
      bits.push(byCount.map((a) => `${a.names.join(', ')} ${P(a.amount)}`).join(' · '))
    }
    return bits.join(' · ')
  }

  const guestFeeEach = d.guestRate - d.baseUnit
  const hasGuests = d.rows.some((r) => r.status !== 'regular')
  const footer = hasGuests
    ? `Guests pay a flat ${P(d.guestRate)}. The ${S(guestFeeEach)} above base goes to the fund.`
    : ''

  // Two passes: measure (paint = false) to size the canvas, then draw.
  let ctx
  let paint = false

  const setFont = (weight, size) => {
    ctx.font = `${weight} ${size}px ${FONT}`
  }
  const text = (s, x, y, { weight = 400, size = 14, color = C.ink, align = 'left', spacing = 0 } = {}) => {
    setFont(weight, size)
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`
    if (paint) {
      ctx.fillStyle = color
      ctx.textAlign = align
      ctx.fillText(s, x, y)
    }
    const w = ctx.measureText(s).width
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'
    return w
  }
  const width = (s, weight = 400, size = 14) => {
    setFont(weight, size)
    return ctx.measureText(s).width
  }
  const ellipsize = (s, max, weight = 400, size = 14) => {
    if (width(s, weight, size) <= max) return s
    let t = s
    while (t.length > 1 && width(t + '…', weight, size) > max) t = t.slice(0, -1)
    return t + '…'
  }
  const wrap = (s, max, weight = 400, size = 14) => {
    const words = s.split(' ')
    const out = []
    let cur = ''
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w
      if (width(next, weight, size) <= max) cur = next
      else {
        if (cur) out.push(cur)
        cur = width(w, weight, size) <= max ? w : ellipsize(w, max, weight, size)
      }
    }
    if (cur) out.push(cur)
    return out
  }
  const hline = (x1, x2, y, { color = C.ink, w = 1, dash = null } = {}) => {
    if (!paint) return
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = w
    if (dash) ctx.setLineDash(dash)
    ctx.beginPath()
    ctx.moveTo(x1, y)
    ctx.lineTo(x2, y)
    ctx.stroke()
    ctx.restore()
  }

  /** label …… amount on one 21px line; returns the y below it. */
  const row = (x, w, y, label, amount, { color = C.ink, weight = 400, size = 14, indent = false } = {}) => {
    const lh = size === 15 ? LH_BIG : LH
    const base = y + lh * 0.72
    const aw = amount ? width(amount, weight, size) : 0
    const lx = x + (indent ? width('  ', weight, size) : 0)
    text(ellipsize(label, w - aw - 12 - (lx - x), weight, size), lx, base, { color, weight, size })
    if (amount) text(amount, x + w, base, { color, weight, size, align: 'right' })
    return y + lh
  }
  const para = (x, w, y, s, { color = C.ink, indent = false, size = 14 } = {}) => {
    const lx = x + (indent ? width('  ') : 0)
    for (const line of wrap(s, w - (lx - x), 400, size)) {
      text(line, lx, y + LH * 0.72, { color, size })
      y += LH
    }
    return y
  }
  const heading = (x, y, s) => {
    text(s, x, y + LH * 0.72, { weight: 600, spacing: 0.84 })
    return y + LH
  }

  // ── left column ──────────────────────────────────────────────
  const drawLeft = (x, w, y0) => {
    let y = y0
    const G = 6

    // WHAT WE PAID FOR
    y = heading(x, y, 'WHAT WE PAID FOR') + G
    y = row(x, w, y, 'Court rental', P(d.courtTotal)) + G
    y = row(x, w, y, `÷ ${d.players} player${d.players === 1 ? '' : 's'}`, `${P(d.courtUnit)} ea`, { color: C.soft, indent: true })
    if (d.shuttleCount) {
      y += G + 6
      y = row(x, w, y, `Shuttles used · ${d.shuttleCount} pc${d.shuttleCount === 1 ? '' : 's'}`, P(d.shuttleTotal))
      if (d.shuttles.length > 1 || d.shuttles[0]?.name) {
        for (const s of d.shuttles) {
          y += G
          y = row(x, w, y, `${s.name} · ${s.count} pc${s.count === 1 ? '' : 's'}`, P(s.cost), { color: C.soft, indent: true })
        }
      }
      y += G
      y = row(x, w, y, `÷ ${d.players} player${d.players === 1 ? '' : 's'}`, `${P(d.shuttleUnit)} ea`, { color: C.soft, indent: true })
    }
    y += G + 6
    hline(x, x + w, y + 0.5)
    y += 6
    y = row(x, w, y, 'BASE PER PLAYER', P(d.baseUnit), { weight: 600 })

    // EXTRAS
    if (charges.length) {
      y += 24
      y = heading(x, y, 'EXTRAS')
      for (const e of charges) {
        y += G
        y = row(x, w, y, e.label, P(e.total))
        const det = chargeDetail(e)
        if (det) y = para(x, w, y + G, det, { color: C.soft, indent: true })
      }
    }

    // CREDITS
    if (credits.length) {
      y += 24
      y = heading(x, y, 'CREDITED TO PLAYERS')
      for (const c of credits) {
        y += G
        y = row(x, w, y, c.scope ? `${c.label} (${c.scope})` : c.label, S(c.amount))
        if (!c.scope && d.players) {
          y = para(x, w, y + G, `Split ${d.players} ways · ${S(c.amount / d.players)} ea`, { color: C.soft, indent: true })
        }
      }
    }

    // GROUP FUND
    if (d.fund) {
      const f = d.fund
      y += 24
      const top = y
      const ix = x + 15.5
      const iw = w - 31
      y += 15.5
      y = heading(ix, y, 'GROUP FUND') + G
      y = row(ix, iw, y, 'Previous balance', S(f.previous)) + G
      const fee = f.guestHeads ? `+ Guest fees (${f.guestHeads} × ${S(guestFeeEach)})` : '+ Guest fees'
      y = row(ix, iw, y, fee, S(f.guestFees)) + G
      y = row(ix, iw, y, '− Out this session', P(f.out)) + G
      hline(ix, ix + iw, y + 0.5)
      y += 6
      y = row(ix, iw, y, 'NEW BALANCE', S(f.balance), { weight: 600 })
      y += 15.5
      if (paint) {
        ctx.save()
        ctx.strokeStyle = C.ink
        ctx.lineWidth = 1.5
        ctx.strokeRect(x + 0.75, top + 0.75, w - 1.5, y - top - 1.5)
        ctx.restore()
      }
    }
    return y
  }

  // ── right column ─────────────────────────────────────────────
  const tag = (label, x, base, color) => {
    setFont(500, 11)
    const tw = ctx.measureText(label).width
    if (paint) {
      ctx.save()
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.strokeRect(x + 0.5, base - 11.5, tw + 10, 16)
      ctx.restore()
    }
    text(label, x + 5, base, { weight: 500, size: 11, color })
    return tw + 10
  }

  const drawRight = (x, w, y0) => {
    let y = heading(x, y0, 'PER PLAYER')
    const entryEnd = (yy) => {
      yy += 14
      hline(x, x + w, yy + 0.5, { color: C.ruleLight, dash: [4, 3] })
      return yy + 1
    }

    for (const g of groups) {
      y += 16
      const amt = `${P(g.each)} ea`
      const aw = width(amt, 600, 15)
      const base = y + LH_BIG * 0.72
      text(ellipsize(g.title, w - aw - 8, 600, 15), x, base, { weight: 600, size: 15 })
      text(amt, x + w, base, { weight: 600, size: 15, color: C.owe, align: 'right' })
      y += LH_BIG + 3
      y = para(x, w, y, g.formula, { color: C.soft })
      y = para(x, w, y + 7, g.names)
      y = entryEnd(y)
    }

    for (const p of specials) {
      y += 16
      const base = y + LH_BIG * 0.72
      const tags = []
      if (p.guest) tags.push(['GUEST', C.ink])
      if (p.mixed) tags.push(['MIXED', C.ink])
      if (p.paid) tags.push(['✓ PAID', C.back])
      else if (p.partPaid) tags.push(['PART PAID', C.back])
      const tagsW = tags.reduce((s, [t]) => s + width(t, 500, 11) + 18, 0)
      const nw = text(ellipsize(p.name, w - tagsW, 600, 15), x, base, { weight: 600, size: 15 })
      let tx = x + nw + 8
      for (const [t, col] of tags) tx += tag(t, tx, base - 1, col) + 6
      y += LH_BIG
      if (p.sub) y = para(x, w, y, p.sub, { color: C.soft })
      for (const l of p.lines) {
        y += 3
        y = row(x, w, y, l.label, S(l.amount), { color: C.line })
      }
      y += 7
      const owes = p.total >= 0
      y = row(x, w, y, owes ? 'Pays' : 'Receives', P(p.total), {
        weight: 600,
        size: 15,
        color: owes ? C.owe : C.back,
      })
      y = entryEnd(y)
    }
    return y
  }

  // ── whole page ───────────────────────────────────────────────
  const layout = () => {
    let y = PAD_TOP
    // header
    const titleBase = y + 30
    text('COURT SPLIT', PAD_X, titleBase, { weight: 600, size: 26, spacing: 1.04 })
    const playersLine = `${d.players} player${d.players === 1 ? '' : 's'}`
    text(ellipsize(`${d.dateLine} · ${playersLine}`, W - PAD_X * 2 - 240), W - PAD_X, titleBase, {
      color: C.soft,
      align: 'right',
    })
    y += 39 + 24
    hline(PAD_X, W - PAD_X, y + 0.75, { color: C.rule, w: 1.5, dash: [5, 4] })
    y += 1.5 + 24

    const colsEnd = Math.max(drawLeft(leftX, colW, y), drawRight(rightX, colW, y))
    y = colsEnd + 24

    if (footer) {
      hline(PAD_X, W - PAD_X, y + 0.75, { color: C.rule, w: 1.5, dash: [5, 4] })
      y += 1.5 + 14
      text(footer, W / 2, y + 13, { size: 12, color: C.soft, align: 'center' })
      y += 18
    }
    return y + PAD_BOTTOM
  }

  // measuring pass
  ctx = document.createElement('canvas').getContext('2d')
  paint = false
  const H = Math.ceil(layout())

  const canvas = document.createElement('canvas')
  canvas.width = W * SCALE
  canvas.height = H * SCALE
  ctx = canvas.getContext('2d')
  ctx.scale(SCALE, SCALE)
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = C.paper
  ctx.fillRect(0, 0, W, H)
  paint = true
  layout()

  return canvas
}

function toBlob(canvas) {
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not render the image'))), 'image/png')
  )
}

/**
 * Whether this browser can hand a PNG to the OS share sheet (Messenger,
 * WhatsApp, Mail…). True on Android/iOS and Chrome on Windows; false on most
 * desktop Firefox/Safari, where Download is the only route.
 */
export function canShareImageFiles() {
  try {
    if (typeof navigator === 'undefined' || !navigator.canShare || typeof File === 'undefined') {
      return false
    }
    return navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] })
  } catch {
    return false
  }
}

/** Hand the image to the OS share sheet. Returns 'shared' or 'cancelled'. */
export async function shareCanvas(canvas, filename, title) {
  const file = new File([await toBlob(canvas)], filename, { type: 'image/png' })
  if (!navigator.canShare?.({ files: [file] })) {
    throw new Error('This browser cannot share files — use Download instead.')
  }
  try {
    await navigator.share({ files: [file], title })
    return 'shared'
  } catch (err) {
    if (err?.name === 'AbortError') return 'cancelled'
    throw err
  }
}

/** Save the image to the device. */
export async function downloadCanvas(canvas, filename) {
  const url = URL.createObjectURL(await toBlob(canvas))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  return 'downloaded'
}
