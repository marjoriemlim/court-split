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
  return r.sub ? 46 : 32
}

/**
 * @param {Object} d
 * @param {string} d.dateLine     - "Mon, Sep 8, 2026 · Evening"
 * @param {string} d.rateLine     - per-person rate summary
 * @param {Array}  [d.shuttles]  - { name, count, cost } one per shuttle type used
 * @param {number} [d.shuttleTotal] - combined cost of every shuttle type
 * @param {Array}  d.rows        - { name, sub, status, paid, partPaid, headcount,
 *                                  adj (costs/credits on this line), funds (guest earnings), amount }
 * @param {Array}  [d.adjustments] - { label, scope, amount } itemised costs/credits
 * @param {number} d.totalFunds
 * @param {number} [d.totalAccumulated] - all-time guest surplus, this session included
 * @param {(n:number)=>string} d.fmt - peso formatter
 * @returns {HTMLCanvasElement}
 */
export function drawLedgerCanvas(d) {
  const fmt = d.fmt
  const sh = d.shuttles || []
  const adj = d.adjustments || []
  const adjH = adj.length ? 26 + adj.length * 20 + 10 : 0
  const shuttleH = sh.length ? 6 + sh.length * 20 + (sh.length > 1 ? 28 : 0) + 36 : 0
  const rowsH = d.rows.reduce((h, r) => h + rowHeight(r), 0)
  // Figures for the green box. Collected / still-to-collect are left off the
  // image on purpose — each payer only needs their own line.
  const totals = []
  if (d.totalFunds > 0) totals.push({ label: 'FUNDS GENERATED', amount: d.totalFunds })
  if (Number(d.totalAccumulated) > 0) {
    totals.push({ label: 'TOTAL ACCUMULATED FUNDS', amount: d.totalAccumulated })
  }
  const boxH = totals.length ? 12 + totals.length * 26 : 0
  // gap above the box + the box + gap to the footer line (or just a gap when there's no box)
  const totalsH = boxH ? 18 + boxH + 20 : 28
  const H = PAD + 34 + 20 + 22 + 18 + shuttleH + 26 + rowsH + adjH + totalsH + 12 + PAD

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

  // shuttle cost per type, so payers can see what the shuttle share was made of
  if (sh.length) {
    ctx.fillStyle = C.inkSoft
    ctx.font = `600 10px ${BODY}`
    ctx.textAlign = 'left'
    ctx.fillText('SHUTTLES', L, y)
    y += 6

    const shuttleRow = (name, count, cost, bold) => {
      y += 20
      ctx.textAlign = 'left'
      ctx.font = `${bold ? 600 : 500} 12px ${BODY}`
      ctx.fillStyle = C.ink
      ctx.fillText(ellipsize(ctx, name, R - L - 220), L, y)

      ctx.textAlign = 'right'
      ctx.font = `400 12px ${BODY}`
      ctx.fillStyle = C.inkSoft
      ctx.fillText(`${count} pc${count === 1 ? '' : 's'}`, R - 130, y)

      ctx.font = `600 12px ${BODY}`
      ctx.fillStyle = C.ink
      ctx.fillText(fmt(cost), R, y)
    }

    for (const t of sh) shuttleRow(t.name, t.count, t.cost, false)

    if (sh.length > 1) {
      y += 8
      ctx.strokeStyle = C.border
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(L, y - 0.5)
      ctx.lineTo(R, y - 0.5)
      ctx.stroke()
      shuttleRow('All shuttles', sh.reduce((n, t) => n + t.count, 0), d.shuttleTotal, true)
    }
    y += 36
  }

  // Columns are right-aligned and laid out from the amount inwards; the
  // adjustment and guest-earnings columns only appear when some row has one.
  const nonZero = (n) => Math.abs(Number(n) || 0) > 0.005
  const showAdj = d.rows.some((r) => nonZero(r.adj))
  const showEarn = d.rows.some((r) => nonZero(r.funds))
  let cx = R - 120
  const earnX = showEarn ? cx : null
  if (showEarn) cx -= 105
  const adjX = showAdj ? cx : null
  if (showAdj) cx -= 95
  const paxX = cx - 10
  const nameMax = paxX - 40 - L

  // column headers
  ctx.fillStyle = C.inkSoft
  ctx.font = `600 10px ${BODY}`
  ctx.textAlign = 'left'
  ctx.fillText('PAYER', L, y)
  ctx.textAlign = 'right'
  ctx.fillText('PAX', paxX, y)
  if (showAdj) ctx.fillText('ADJUSTMENTS', adjX, y)
  if (showEarn) ctx.fillText('GUEST EARNINGS', earnX, y)
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
    ctx.textAlign = 'right'
    ctx.fillStyle = C.inkSoft
    ctx.font = `400 13px ${BODY}`
    ctx.fillText(String(r.headcount), paxX, baseline)

    ctx.font = `500 13px ${BODY}`
    if (showAdj && nonZero(r.adj)) {
      ctx.fillStyle = r.adj < 0 ? C.credit : C.inkSoft
      ctx.fillText(fmt(r.adj), adjX, baseline)
    }
    if (showEarn && nonZero(r.funds)) {
      ctx.fillStyle = r.funds < 0 ? '#a3402f' : '#7a5a12'
      ctx.fillText(fmt(r.funds), earnX, baseline)
    }

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

  // itemised costs & credits, so a payer can see what the figure in their
  // ADJUSTMENTS column was actually for
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

  if (boxH) {
    y += 18

    // One line per figure, stacked inside the green box.
    ctx.fillStyle = C.green
    ctx.fillRect(L, y, R - L, boxH)

    totals.forEach((line, i) => {
      const top = y + i * 26
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.font = `400 11px ${BODY}`
      ctx.textAlign = 'left'
      ctx.fillText(line.label, L + 14, top + 22)

      ctx.fillStyle = C.gold
      ctx.font = `600 16px ${DISPLAY}`
      ctx.textAlign = 'right'
      ctx.fillText(fmt(line.amount), R - 14, top + 25)
    })

    y += boxH + 20
  } else {
    y += 28
  }

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
