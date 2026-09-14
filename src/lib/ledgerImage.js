// Draws the ledger as a shareable receipt image.
//
// Deliberately not a screenshot of the table: this renders only what a payer
// needs to see (who owes what), leaving out the Remove buttons, headcount
// inputs and horizontal scrollbar that a DOM capture would include.

const C = {
  paper: '#fbfaf6',
  panel: '#ffffff',
  ink: '#1a2420',
  inkSoft: '#4d5a54',
  border: '#d8ddd7',
  green: '#1b5e42',
  gold: '#d4a13d',
  guestTint: '#fdf3e3',
  credit: '#1b5e42',
}

const DISPLAY = "'Fraunces', Georgia, 'Times New Roman', serif"
const BODY = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif"

const W = 720
const PAD = 32
const SCALE = 2

function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text
  let s = text
  while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1)
  return s + '…'
}

function rowHeight(r) {
  return r.sub || r.note ? 46 : 32
}

/**
 * @param {Object} d
 * @param {string} d.dateLine     - "Mon, Sep 8, 2026 · Evening"
 * @param {string} d.rateLine     - per-person rate summary
 * @param {Array}  d.rows         - { name, sub, note, status, paid, partPaid, headcount, amount }
 * @param {Array}  d.adjustments  - { label, scope, amount } itemised costs/credits
 * @param {number} d.totalCollected
 * @param {number|null} [d.outstanding] - still owed by unpaid rows; null hides the line
 * @param {number} d.totalFunds
 * @param {number} [d.totalAccumulated] - all-time guest surplus, this session included
 * @param {(n:number)=>string} d.fmt - peso formatter
 * @returns {HTMLCanvasElement}
 */
export function drawLedgerCanvas(d) {
  const fmt = d.fmt
  const adj = d.adjustments || []
  const rowsH = d.rows.reduce((h, r) => h + rowHeight(r), 0)
  const adjH = adj.length ? 26 + adj.length * 20 + 10 : 0
  const showFunds = d.totalFunds > 0
  const showAccum = Number(d.totalAccumulated) > 0
  const showOutstanding = d.outstanding != null
  const extraRows = (showFunds ? 1 : 0) + (showAccum ? 1 : 0) + (showOutstanding ? 1 : 0)
  const H = PAD + 34 + 20 + 22 + 18 + 26 + rowsH + adjH + 18 + 58 + extraRows * 26 + 22 + PAD

  const canvas = document.createElement('canvas')
  canvas.width = W * SCALE
  canvas.height = H * SCALE
  const ctx = canvas.getContext('2d')
  ctx.scale(SCALE, SCALE)
  ctx.textBaseline = 'alphabetic'

  // card
  ctx.fillStyle = C.paper
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = C.panel
  ctx.fillRect(PAD / 2, PAD / 2, W - PAD, H - PAD)
  ctx.strokeStyle = C.border
  ctx.lineWidth = 1
  ctx.strokeRect(PAD / 2 + 0.5, PAD / 2 + 0.5, W - PAD - 1, H - PAD - 1)

  const L = PAD + 12
  const R = W - PAD - 12
  let y = PAD + 34

  // header
  ctx.fillStyle = C.ink
  ctx.font = `600 26px ${DISPLAY}`
  ctx.textAlign = 'left'
  ctx.fillText('Court Split', L, y)

  ctx.fillStyle = C.inkSoft
  ctx.font = `400 13px ${BODY}`
  ctx.textAlign = 'right'
  ctx.fillText(d.dateLine, R, y)
  y += 20

  ctx.fillStyle = C.inkSoft
  ctx.font = `400 12px ${BODY}`
  ctx.textAlign = 'left'
  ctx.fillText(ellipsize(ctx, d.rateLine, R - L), L, y)
  y += 22

  // rule
  ctx.strokeStyle = C.green
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(L, y)
  ctx.lineTo(R, y)
  ctx.stroke()
  y += 18

  // column headers
  ctx.fillStyle = C.inkSoft
  ctx.font = `600 10px ${BODY}`
  ctx.textAlign = 'left'
  ctx.fillText('PAYER', L, y)
  ctx.textAlign = 'right'
  ctx.fillText('PAX', R - 130, y)
  ctx.fillText('AMOUNT', R, y)
  y += 8

  // rows
  for (const r of d.rows) {
    const h = rowHeight(r)
    if (r.status === 'guest') {
      ctx.fillStyle = C.guestTint
      ctx.fillRect(L - 8, y, R - L + 16, h)
    }
    const baseline = y + 20

    ctx.textAlign = 'left'
    ctx.fillStyle = C.ink
    ctx.font = `600 14px ${BODY}`
    const nameMax = R - L - 190
    // leave room for the tags so they never run into the PAX column
    const tagRoom = (r.status !== 'regular' ? 45 : 0) + (r.paid || r.partPaid ? 65 : 0)
    const name = ellipsize(ctx, r.name, nameMax - tagRoom)
    ctx.fillText(name, L, baseline)

    // status + paid tags after the name
    let tagX = L + ctx.measureText(name).width + 8
    ctx.font = `700 9px ${BODY}`
    if (r.status !== 'regular') {
      const tag = r.status === 'guest' ? 'GUEST' : 'MIXED'
      ctx.fillStyle = r.status === 'guest' ? '#7a5a12' : C.inkSoft
      ctx.fillText(tag, tagX, baseline - 1)
      tagX += ctx.measureText(tag).width + 8
    }
    if (r.paid || r.partPaid) {
      ctx.fillStyle = C.green
      ctx.fillText(r.paid ? '✓ PAID' : 'PART PAID', tagX, baseline - 1)
    }

    if (r.sub) {
      ctx.font = `400 11px ${BODY}`
      ctx.fillStyle = C.inkSoft
      ctx.fillText(ellipsize(ctx, r.sub, nameMax), L, baseline + 15)
    }
    if (r.note) {
      ctx.font = `400 11px ${BODY}`
      ctx.fillStyle = r.note.startsWith('-') ? C.credit : C.inkSoft
      ctx.textAlign = 'right'
      ctx.fillText(r.note, R, baseline + 15)
    }

    ctx.textAlign = 'right'
    ctx.fillStyle = C.inkSoft
    ctx.font = `400 13px ${BODY}`
    ctx.fillText(String(r.headcount), R - 130, baseline)

    ctx.fillStyle = r.amount < 0 ? C.credit : C.ink
    ctx.font = `600 15px ${BODY}`
    ctx.fillText(fmt(r.amount), R, baseline)

    y += h
    ctx.strokeStyle = C.border
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(L, y - 0.5)
    ctx.lineTo(R, y - 0.5)
    ctx.stroke()
  }

  // itemised costs & credits, so a payer can see what the "adj." on their
  // line was actually for
  if (adj.length) {
    y += 16
    ctx.fillStyle = C.inkSoft
    ctx.font = `600 10px ${BODY}`
    ctx.textAlign = 'left'
    ctx.fillText('COSTS & CREDITS', L, y)
    y += 14

    const scopeX = L + 250
    for (const a of adj) {
      ctx.textAlign = 'left'
      ctx.font = `500 12px ${BODY}`
      ctx.fillStyle = C.ink
      ctx.fillText(ellipsize(ctx, a.label, 235), L, y + 10)

      ctx.font = `400 11px ${BODY}`
      ctx.fillStyle = C.inkSoft
      ctx.fillText(ellipsize(ctx, a.scope, R - 110 - scopeX), scopeX, y + 10)

      ctx.textAlign = 'right'
      ctx.font = `600 12px ${BODY}`
      ctx.fillStyle = a.amount < 0 ? C.credit : C.ink
      ctx.fillText(fmt(a.amount), R, y + 10)
      y += 20
    }
    y += 10
  }

  y += 18

  // totals
  ctx.fillStyle = C.green
  const boxH = 48 + extraRows * 26
  ctx.fillRect(L, y, R - L, boxH)

  // One line per figure, stacked inside the green box.
  const lines = [{ label: 'TOTAL COLLECTED', amount: d.totalCollected, lead: true }]
  if (showOutstanding) lines.push({ label: 'STILL TO COLLECT', amount: d.outstanding })
  if (showFunds) lines.push({ label: 'FUNDS GENERATED', amount: d.totalFunds })
  if (showAccum) {
    lines.push({ label: 'TOTAL ACCUMULATED FUNDS', amount: d.totalAccumulated })
  }

  lines.forEach((line, i) => {
    const top = y + i * 26
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.font = `400 11px ${BODY}`
    ctx.textAlign = 'left'
    ctx.fillText(line.label, L + 14, top + 20)

    ctx.fillStyle = line.lead ? '#ffffff' : C.gold
    ctx.font = `600 ${line.lead ? 20 : 16}px ${DISPLAY}`
    ctx.textAlign = 'right'
    ctx.fillText(fmt(line.amount), R - 14, top + 23)
  })

  y += boxH + 20

  ctx.fillStyle = C.inkSoft
  ctx.font = `400 10px ${BODY}`
  ctx.textAlign = 'center'
  ctx.fillText('Couples and groups are shown as one combined total.', W / 2, y)

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
