import { useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import {
  calcGroup,
  calcSessionTotals,
  resolveRates,
  extrasSummary,
  totalHeadcount,
  money,
  peso,
} from '../lib/calc'

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// Local calendar date, not UTC — toISOString() would roll the date back for
// anyone east of Greenwich during the early hours.
const todayStr = () => ymd(new Date())

const shiftDate = (dateStr, delta) => {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + delta)
  return ymd(dt)
}

const prettyDate = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

const CAN_SHARE = (() => {
  try {
    return (
      typeof navigator !== 'undefined' &&
      typeof File !== 'undefined' &&
      !!navigator.canShare?.({ files: [new File([''], 'x.png', { type: 'image/png' })] })
    )
  } catch {
    return false
  }
})()

const TEMP = 'tmp:'
const isTemp = (id) => typeof id === 'string' && id.startsWith(TEMP)

function StatusBadge({ status }) {
  return (
    <span className={`badge ${status === 'regular' ? 'badge-regular' : 'badge-guest'}`}>
      {status === 'regular' ? 'Regular' : 'Guest'}
    </span>
  )
}

function PlayerChip({ name, status, on, onClick }) {
  return (
    <button type="button" className={`roster-chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={onClick}>
      <span className="roster-check" aria-hidden="true">{on ? '✓' : '+'}</span>
      <span className="roster-name">{name}</span>
      <StatusBadge status={status} />
    </button>
  )
}

// Holds its own text while focused so typing never fights the saved value:
// clearing the box to retype no longer snaps to 0, and a late server echo
// can't overwrite what you're in the middle of entering.
function NumberField({ label, value, onCommit, step = '0.01', min }) {
  const [text, setText] = useState(() => String(value ?? 0))
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setText(String(value ?? 0))
  }, [value])

  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        step={step}
        min={min}
        inputMode="decimal"
        value={text}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; setText(String(value ?? 0)) }}
        onChange={(e) => {
          setText(e.target.value)
          onCommit(e.target.value === '' ? 0 : Number(e.target.value))
        }}
      />
    </div>
  )
}

// Module-level so the <input> keeps focus while typing (a component defined
// inside the page would be a new type every render and remount the input).
function HeadcountCell({ row, setGroups, commit }) {
  return (
    <input
      className="hc-input"
      type="number"
      min="1"
      inputMode="numeric"
      value={row.headcount}
      onChange={(e) =>
        setGroups((prev) => prev.map((x) => (x.id === row.id ? { ...x, headcount: e.target.value } : x)))
      }
      onBlur={(e) => commit(row, Math.max(1, Math.floor(Number(e.target.value) || 1)))}
    />
  )
}

// `partial` is for a couple where only one of them has paid so far; tapping it
// marks the rest as paid too.
function PaidToggle({ paid, partial, onChange }) {
  return (
    <button
      type="button"
      className={`paid-toggle ${paid ? 'on' : partial ? 'partial' : ''}`}
      aria-pressed={paid}
      title={paid ? 'Mark as not paid' : 'Mark as paid'}
      onClick={() => onChange(!paid)}
    >
      <span className="paid-check" aria-hidden="true">{paid ? '✓' : partial ? '–' : ''}</span>
      {paid ? 'Paid' : partial ? 'Part paid' : 'Unpaid'}
    </button>
  )
}

export default function SessionPage() {
  // "/" means today; "/session/<yyyy-mm-dd>" is any other day.
  const { date: dateParam } = useParams()
  const navigate = useNavigate()
  const date = dateParam || todayStr()
  const isToday = date === todayStr()
  const goToDate = (d) => navigate(d === todayStr() ? '/' : `/session/${d}`)

  const [daySessions, setDaySessions] = useState([]) // every session on this date
  const [session, setSessionRow] = useState(null)    // the one being edited
  const [groups, setGroups] = useState([])
  const [extras, setExtras] = useState([])
  const [players, setPlayers] = useState([])
  const [playerGroups, setPlayerGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(() => new Set())
  const [syncing, setSyncing] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [exporting, setExporting] = useState('') // '' | 'share' | 'download'

  // Everything the all-time fund balance needs that isn't the session on screen:
  // the balance carried in before the app, plus each other session's funds.
  // The session being edited is deliberately excluded — its live total is added
  // in below, so the running balance tracks edits without waiting for a save.
  const [fundHistory, setFundHistory] = useState({ opening: 0, bySession: {} })

  // "covering others" form state
  const [payerId, setPayerId] = useState('')
  const [headcount, setHeadcount] = useState(2)
  const [members, setMembers] = useState('')

  // new additional-cost form state
  const [costLabel, setCostLabel] = useState('')
  const [costAmount, setCostAmount] = useState('')
  const [costKind, setCostKind] = useState('charge') // 'charge' adds, 'credit' subtracts
  const [costTarget, setCostTarget] = useState('') // '' = split among everyone, else payment_group id

  // ── Deferred writes ──────────────────────────────────────────────
  // Roster taps update local state instantly and queue the real insert/delete.
  // A debounce batches a burst of taps into one round-trip, and nothing
  // re-reads the session row, so the settings above are never clobbered.
  const sessionIdRef = useRef(null)
  const idByPayer = useRef(new Map())    // payer_id -> real payment_group id
  const pendingAdds = useRef(new Map())  // payer_id -> optimistic row awaiting insert
  const pendingDels = useRef(new Map())  // payer_id -> real row awaiting delete
  const flushTimer = useRef(null)
  const flushChain = useRef(Promise.resolve())
  const sessionTimers = useRef({})

  useEffect(() => { sessionIdRef.current = session?.id ?? null }, [session])

  async function createSessionFor(dateStr) {
    const { data, error } = await supabase
      .from('sessions')
      .insert({ session_date: dateStr })
      .select()
      .single()
    if (error) {
      setSaveError(error.message)
      return null
    }
    return data
  }

  function clearSessionRows() {
    setGroups([])
    setExtras([])
    idByPayer.current = new Map()
  }

  // Everything belonging to one session (not the whole day).
  async function loadSessionRows(sessionRowId) {
    const { data: groupsData } = await supabase
      .from('payment_groups')
      .select('*, players(name, group_id)')
      .eq('session_id', sessionRowId)
      .order('created_at')
    setGroups(groupsData || [])
    idByPayer.current = new Map((groupsData || []).map((g) => [g.payer_id, g.id]))

    const { data: extrasData } = await supabase
      .from('extra_costs')
      .select('*')
      .eq('session_id', sessionRowId)
      .order('created_at')
    setExtras(extrasData || [])
  }

  function activate(row) {
    setSessionRow(row)
    sessionIdRef.current = row.id
  }

  // Switch between two sessions on the same day (e.g. morning → evening).
  async function selectSession(row) {
    if (row.id === session?.id) return
    await flushRoster()
    setLoading(true)
    activate(row)
    clearSessionRows()
    await loadSessionRows(row.id)
    setLoading(false)
  }

  // A second (or third) block on the same date.
  async function addSession() {
    await flushRoster()
    const created = await createSessionFor(date)
    if (!created) return
    setDaySessions((prev) => [...prev, created])
    activate(created)
    clearSessionRows()
  }

  async function startSessionHere() {
    const created = await createSessionFor(date)
    if (!created) return
    setDaySessions([created])
    activate(created)
    clearSessionRows()
  }

  async function loadEverything(dateStr) {
    setLoading(true)
    setSaveError('')
    const { data: playersData } = await supabase
      .from('players')
      .select('id, name, status, group_id')
      .eq('active', true)
      .order('name')
    setPlayers(playersData || [])

    const { data: pgroups } = await supabase.from('player_groups').select('*')
    setPlayerGroups(pgroups || [])

    // A date can hold several sessions — oldest first, so "Session 1" is the
    // one that was started first.
    const { data: sessionsData } = await supabase
      .from('sessions')
      .select('*')
      .eq('session_date', dateStr)
      .order('created_at')

    let list = sessionsData || []

    // Today gets one created on sight so the common flow stays one-click. Any
    // other date waits for an explicit "Start a session" so browsing back
    // through the calendar doesn't litter History with empty rows.
    if (list.length === 0 && dateStr === todayStr()) {
      const created = await createSessionFor(dateStr)
      if (created) list = [created]
    }

    setDaySessions(list)

    if (list.length === 0) {
      setSessionRow(null)
      sessionIdRef.current = null
      clearSessionRows()
      setLoading(false)
      return
    }

    activate(list[0])
    await loadSessionRows(list[0].id)
    setLoading(false)
  }

  // Reload whenever the date changes, saving anything still queued for the day
  // we're leaving before we swap sessions underneath it.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await flushRoster()
      if (!cancelled) await loadEverything(date)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date])

  // All-time fund figures, refreshed whenever the day changes.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: settings } = await supabase
        .from('fund_settings')
        .select('opening_balance')
        .maybeSingle()

      const { data: all } = await supabase
        .from('sessions')
        .select('id, court_fee_mode, court_fee_per_slot, court_fee_total, shuttle_count, shuttle_price_each, guest_fixed_rate, payment_groups(*), extra_costs(*)')

      if (cancelled) return
      const bySession = {}
      for (const s of all || []) {
        bySession[s.id] = calcSessionTotals(s, s.payment_groups || [], s.extra_costs || []).totalFunds
      }
      setFundHistory({ opening: Number(settings?.opening_balance) || 0, bySession })
    })()
    return () => { cancelled = true }
  }, [date])

  // Never leave queued roster changes unsaved.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushRoster() }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      flushRoster()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function doFlush() {
    const adds = Array.from(pendingAdds.current.values())
    const dels = Array.from(pendingDels.current.values())
    if (adds.length === 0 && dels.length === 0) return
    pendingAdds.current = new Map()
    pendingDels.current = new Map()

    setSyncing(true)
    try {
      if (dels.length) {
        const { error } = await supabase
          .from('payment_groups')
          .delete()
          .in('id', dels.map((r) => r.id))
        if (error) throw error
        dels.forEach((r) => idByPayer.current.delete(r.payer_id))
      }
      if (adds.length) {
        const { data, error } = await supabase
          .from('payment_groups')
          .insert(
            adds.map((t) => ({
              // the session this row was queued against, not whichever date is
              // on screen by the time the debounce fires
              session_id: t.session_id,
              payer_id: t.payer_id,
              payer_status_snapshot: t.payer_status_snapshot,
              headcount: Math.max(1, Math.floor(Number(t.headcount) || 1)),
              paid_at: t.paid_at ?? null,
            }))
          )
          .select('*, players(name, group_id)')
        if (error) throw error
        const real = new Map((data || []).map((r) => [r.payer_id, r]))
        real.forEach((r, payerId) => idByPayer.current.set(payerId, r.id))
        setGroups((prev) =>
          prev.map((g) => (isTemp(g.id) && real.has(g.payer_id) ? real.get(g.payer_id) : g))
        )
      }
      setSaveError('')
    } catch (err) {
      setSaveError(err?.message || String(err))
      // roll the failed additions back out of the view
      setGroups((prev) => prev.filter((g) => !adds.some((a) => a.id === g.id)))
    } finally {
      setSyncing(false)
    }
  }

  function flushRoster() {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
    flushChain.current = flushChain.current.then(doFlush, doFlush)
    return flushChain.current
  }

  function scheduleFlush() {
    if (flushTimer.current) clearTimeout(flushTimer.current)
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null
      flushRoster()
    }, 600)
  }

  // ── Session settings ─────────────────────────────────────────────
  // Local state is the truth while you type; the write is debounced and the
  // response is deliberately NOT fed back into state.
  function updateSessionField(field, value) {
    setSessionRow((prev) => (prev ? { ...prev, [field]: value } : prev))
    // capture the row now — switching dates or sessions before the debounce
    // fires must not redirect this write onto a different session
    const targetId = sessionIdRef.current
    // keep the tab strip in step (it reads the label from this list)
    setDaySessions((prev) => prev.map((s) => (s.id === targetId ? { ...s, [field]: value } : s)))
    clearTimeout(sessionTimers.current[field])
    sessionTimers.current[field] = setTimeout(async () => {
      const { error } = await supabase
        .from('sessions')
        .update({ [field]: value })
        .eq('id', targetId)
      setSaveError(error ? `Couldn't save ${field.replace(/_/g, ' ')} — ${error.message}` : '')
    }, 500)
  }

  // ── Roster ───────────────────────────────────────────────────────
  function optimisticRow(p) {
    return {
      id: TEMP + p.id,
      session_id: sessionIdRef.current,
      payer_id: p.id,
      payer_status_snapshot: p.status,
      headcount: 1,
      members: null,
      paid_at: null,
      players: { name: p.name, group_id: p.group_id },
    }
  }

  function queueAdd(p) {
    // re-adding someone whose delete hasn't gone out yet just cancels the delete
    const revived = pendingDels.current.get(p.id)
    if (revived) {
      pendingDels.current.delete(p.id)
      return revived
    }
    const row = optimisticRow(p)
    pendingAdds.current.set(p.id, row)
    return row
  }

  function queueRemove(row) {
    if (isTemp(row.id)) pendingAdds.current.delete(row.payer_id)
    else pendingDels.current.set(row.payer_id, row)
  }

  function togglePlayer(p) {
    const existing = groups.find((g) => g.payer_id === p.id)
    if (existing) {
      const hc = Number(existing.headcount) || 1
      if (existing.paid_at) {
        if (!window.confirm(`${p.name} is marked as paid. Remove from the session?`)) return
      } else if (hc > 1 || existing.members) {
        const detail = existing.members ? ` (${existing.members})` : ''
        if (!window.confirm(`${p.name} is covering a headcount of ${hc}${detail}. Remove from the session?`)) return
      }
      queueRemove(existing)
      setGroups((prev) => prev.filter((g) => g.id !== existing.id))
    } else {
      const row = queueAdd(p)
      setGroups((prev) => [...prev, row])
    }
    scheduleFlush()
  }

  function addAll() {
    const missing = players.filter((p) => !groups.some((g) => g.payer_id === p.id))
    if (missing.length === 0) return
    const rows = missing.map(queueAdd)
    setGroups((prev) => [...prev, ...rows])
    scheduleFlush()
  }

  function removeRows(rows) {
    if (rows.length === 0) return
    rows.forEach(queueRemove)
    const ids = new Set(rows.map((r) => r.id))
    setGroups((prev) => prev.filter((g) => !ids.has(g.id)))
    scheduleFlush()
  }

  async function commitHeadcount(row, value) {
    setGroups((prev) => prev.map((g) => (g.id === row.id ? { ...g, headcount: value } : g)))
    if (isTemp(row.id)) {
      // not inserted yet — let the queued insert carry the new value
      const queued = pendingAdds.current.get(row.payer_id)
      if (queued) queued.headcount = value
      return
    }
    const { error } = await supabase
      .from('payment_groups')
      .update({ headcount: value })
      .eq('id', row.id)
    if (error) setSaveError(error.message)
  }

  // Paid is stored as a timestamp (when the money came in); null = still owes.
  // Rows are matched by payer, since a temp row swaps its id once inserted.
  async function setPaid(rows, paid) {
    const paidAt = paid ? new Date().toISOString() : null
    const before = new Map(rows.map((r) => [r.payer_id, r.paid_at ?? null]))
    const apply = (valueFor) =>
      setGroups((prev) =>
        prev.map((g) => (before.has(g.payer_id) ? { ...g, paid_at: valueFor(g.payer_id) } : g))
      )
    apply(() => paidAt)

    // not inserted yet — let the queued insert carry the flag
    const unqueued = rows.filter((r) => {
      const queued = isTemp(r.id) && pendingAdds.current.get(r.payer_id)
      if (queued) queued.paid_at = paidAt
      return !queued
    })
    if (unqueued.length === 0) return

    // an insert already on its way would land unpaid — wait for it, then update
    if (unqueued.some((r) => isTemp(r.id))) {
      await flushChain.current
      apply(() => paidAt)
    }
    const ids = unqueued.map((r) => idByPayer.current.get(r.payer_id)).filter(Boolean)
    if (ids.length === 0) return
    const { error } = await supabase.from('payment_groups').update({ paid_at: paidAt }).in('id', ids)
    if (error) {
      setSaveError(error.message)
      apply((payerId) => before.get(payerId))
    }
  }

  async function addCoveringGroup(e) {
    e.preventDefault()
    if (!payerId) return
    await flushRoster()
    const payer = players.find((p) => p.id === payerId)
    const { data, error } = await supabase
      .from('payment_groups')
      .insert({
        session_id: sessionIdRef.current,
        payer_id: payerId,
        payer_status_snapshot: payer.status,
        headcount: Number(headcount) || 1,
        members: members.trim() || null,
      })
      .select('*, players(name, group_id)')
      .single()
    if (error) {
      setSaveError(error.message)
      return
    }
    idByPayer.current.set(data.payer_id, data.id)
    setGroups((prev) => [...prev, data])
    setPayerId('')
    setHeadcount(2)
    setMembers('')
  }

  // ── Additional costs ─────────────────────────────────────────────
  async function addExtra(e) {
    e.preventDefault()
    if (!costLabel.trim() || costAmount === '' || Number.isNaN(Number(costAmount))) return
    await flushRoster()
    let target = costTarget || null
    if (target && isTemp(target)) {
      target = idByPayer.current.get(target.slice(TEMP.length)) || null
    }
    const { data, error } = await supabase
      .from('extra_costs')
      .insert({
        session_id: sessionIdRef.current,
        label: costLabel.trim(),
        // the toggle owns the sign, so a stray minus in the box can't flip a
        // charge into a credit behind your back
        amount: Math.abs(Number(costAmount) || 0) * (costKind === 'credit' ? -1 : 1),
        payment_group_id: target,
      })
      .select()
      .single()
    if (error) {
      setSaveError(error.message)
      return
    }
    setExtras((prev) => [...prev, data])
    setCostLabel('')
    setCostAmount('')
    setCostKind('charge')
    setCostTarget('')
  }

  async function removeExtra(id) {
    setExtras((prev) => prev.filter((x) => x.id !== id))
    const { error } = await supabase.from('extra_costs').delete().eq('id', id)
    if (error) setSaveError(error.message)
  }

  function toggleExpanded(key) {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const groupByPayer = useMemo(() => {
    const m = new Map()
    groups.forEach((g) => m.set(g.payer_id, g))
    return m
  }, [groups])

  const pgName = (id) => playerGroups.find((g) => g.id === id)?.name

  const errorBanner = saveError && (
    <div className="save-error">
      <span>{saveError}</span>
      <button className="link-btn" onClick={() => setSaveError('')}>Dismiss</button>
    </div>
  )

  const dateBar = (
    <div className="panel date-bar">
      <div className="date-controls">
        <button className="ghost" onClick={() => goToDate(shiftDate(date, -1))} aria-label="Previous day">‹</button>
        <input
          type="date"
          className="date-input"
          value={date}
          onChange={(e) => e.target.value && goToDate(e.target.value)}
        />
        <button className="ghost" onClick={() => goToDate(shiftDate(date, 1))} aria-label="Next day">›</button>
      </div>
      <div className="date-label">
        <strong>{prettyDate(date)}</strong>
        {isToday ? (
          <span className="badge badge-regular">Today</span>
        ) : (
          <button className="link-btn" onClick={() => goToDate(todayStr())}>Back to today</button>
        )}
      </div>
    </div>
  )

  const sessionName = (s, i) => s.label?.trim() || `Session ${i + 1}`

  // Only worth showing once the day actually has a session; a single unlabelled
  // one still gets the strip so "+ Add session" is reachable.
  const sessionTabs = daySessions.length > 0 && (
    <div className="session-tabs">
      {daySessions.map((s, i) => (
        <button
          key={s.id}
          type="button"
          className={`session-tab ${s.id === session?.id ? 'on' : ''}`}
          onClick={() => selectSession(s)}
        >
          {sessionName(s, i)}
        </button>
      ))}
      <button type="button" className="session-tab add" onClick={addSession}>
        + Add session
      </button>
    </div>
  )

  if (loading) return <div>{errorBanner}{dateBar}{sessionTabs}<p>Loading session…</p></div>

  if (!session) {
    return (
      <div>
        {errorBanner}
        {dateBar}
        <div className="panel">
          <div className="empty-state">
            <p>No session recorded for {prettyDate(date)}.</p>
            <button className="primary" onClick={startSessionHere}>
              Start a session for this date
            </button>
          </div>
        </div>
      </div>
    )
  }

  const headTotal = totalHeadcount(groups)
  const rates = resolveRates(session, headTotal)
  const exSummary = extrasSummary(extras, headTotal)
  const splitMode = session.court_fee_mode === 'split'
  const totals = calcSessionTotals(session, groups, extras)
  const notYetIn = players.filter((p) => !groupByPayer.has(p.id))

  // Who has settled up so far, and what is still owed.
  const payStatus = groups.reduce(
    (acc, g) => {
      const amount = calcGroup(session, g, headTotal, extras).amountToPay
      if (g.paid_at) {
        acc.paidCount += 1
        acc.collected += amount
      } else {
        acc.outstanding += amount
      }
      return acc
    },
    { paidCount: 0, collected: 0, outstanding: 0 }
  )

  // Every guest surplus ever banked: the carried-in balance, every other
  // session, and this one live as it's edited.
  const accumulatedFunds =
    fundHistory.opening +
    Object.entries(fundHistory.bySession)
      .filter(([id]) => id !== session.id)
      .reduce((sum, [, funds]) => sum + funds, 0) +
    totals.totalFunds

  // Roster picker: one flat wrap of per-player chips. Members of the same group
  // (2+ playing) sit adjacent inside a tinted pair so they read as one unit,
  // but each person is still toggled individually.
  const pairable = new Map()
  playerGroups.forEach((pg) => {
    const mem = players.filter((p) => p.group_id === pg.id)
    if (mem.length >= 2) pairable.set(pg.id, { name: pg.name, members: mem })
  })
  const rosterUnits = []
  const placed = new Set()
  for (const p of players) {
    if (placed.has(p.id)) continue
    const pair = p.group_id ? pairable.get(p.group_id) : null
    if (pair) {
      pair.members.forEach((m) => placed.add(m.id))
      rosterUnits.push({ type: 'pair', key: p.group_id, ...pair })
    } else {
      placed.add(p.id)
      rosterUnits.push({ type: 'solo', key: p.id, player: p })
    }
  }

  const targetName = (gid) => groups.find((g) => g.id === gid)?.players?.name || 'Unknown'

  // Ledger rows: bucket payment groups by the payer's player-group so couples bill as one line.
  const byPlayerGroup = new Map()
  groups.forEach((g) => {
    const gid = g.players?.group_id
    if (!gid) return
    if (!byPlayerGroup.has(gid)) byPlayerGroup.set(gid, [])
    byPlayerGroup.get(gid).push(g)
  })
  const done = new Set()
  const ledgerRows = []
  for (const g of groups) {
    if (done.has(g.id)) continue
    const gid = g.players?.group_id
    const mates = gid ? byPlayerGroup.get(gid) : null
    if (mates && mates.length >= 2) {
      mates.forEach((m) => done.add(m.id))
      const parts = mates.map((m) => ({ row: m, calc: calcGroup(session, m, headTotal, extras) }))
      const sum = (fn) => parts.reduce((s, p) => s + fn(p), 0)
      ledgerRows.push({
        type: 'group',
        key: gid,
        title: pgName(gid) || parts.map((p) => p.row.players?.name).filter(Boolean).join(' & '),
        names: parts.map((p) => p.row.players?.name).filter(Boolean),
        parts,
        headcount: sum((p) => Number(p.row.headcount) || 0),
        paidCount: parts.filter((p) => p.row.paid_at).length,
        allPaid: parts.every((p) => p.row.paid_at),
        allGuest: parts.every((p) => p.row.payer_status_snapshot === 'guest'),
        anyGuest: parts.some((p) => p.row.payer_status_snapshot === 'guest'),
        extrasTotal: sum((p) => p.calc.extrasTotal),
        actualCost: sum((p) => p.calc.actualCost),
        amountToPay: sum((p) => p.calc.amountToPay),
        fundsGenerated: sum((p) => p.calc.fundsGenerated),
      })
    } else {
      done.add(g.id)
      ledgerRows.push({ type: 'solo', key: g.id, row: g, calc: calcGroup(session, g, headTotal, extras) })
    }
  }

  // Grouped regulars (couples) first, then ungrouped regulars, then guests.
  // A couple that is entirely guests belongs with the guests, not the couples.
  // Array.sort is stable, so within a band rows keep the order they were added.
  const statusRank = (lr) => {
    if (lr.type === 'group') {
      if (lr.allGuest) return 3
      return lr.anyGuest ? 1 : 0 // all-regular couples, then mixed ones
    }
    return lr.row.payer_status_snapshot === 'guest' ? 3 : 2
  }
  ledgerRows.sort((a, b) => statusRank(a) - statusRank(b))

  // Build the receipt from the same rows the ledger renders, so the image can
  // never drift from what is on screen.
  // mode: 'share' hands the PNG to the OS share sheet (Messenger, WhatsApp,
  // Mail…); 'download' saves it to the device.
  async function exportLedger(mode) {
    setExporting(mode)
    try {
      if (document.fonts?.ready) await document.fonts.ready // canvas needs the webfonts loaded
      const { drawLedgerCanvas, shareCanvas, downloadCanvas } = await import('../lib/ledgerImage')

      const label = session.label?.trim()
      const idx = daySessions.findIndex((s) => s.id === session.id)
      const sessionName = label || (daySessions.length > 1 ? `Session ${idx + 1}` : '')

      const canvas = drawLedgerCanvas({
        dateLine: prettyDate(date) + (sessionName ? ` · ${sessionName}` : ''),
        rateLine:
          `${peso(rates.courtUnitCost)} court + ${peso(rates.shuttleUnitCost)} shuttle per person` +
          ` · ${headTotal} player${headTotal === 1 ? '' : 's'}`,
        rows: ledgerRows.map((lr) =>
          lr.type === 'solo'
            ? {
                name: lr.row.players?.name || 'Unknown',
                sub: lr.row.members ? `+ ${lr.row.members}` : '',
                note: lr.calc.extrasTotal !== 0 ? `${peso(lr.calc.extrasTotal)} adj.` : '',
                status: lr.row.payer_status_snapshot,
                paid: !!lr.row.paid_at,
                headcount: lr.row.headcount,
                amount: lr.calc.amountToPay,
              }
            : {
                name: lr.title,
                sub: lr.names.join(' + '),
                note: lr.extrasTotal !== 0 ? `${peso(lr.extrasTotal)} adj.` : '',
                status: lr.allGuest ? 'guest' : lr.anyGuest ? 'mixed' : 'regular',
                paid: lr.allPaid,
                partPaid: lr.paidCount > 0 && !lr.allPaid,
                headcount: lr.headcount,
                amount: lr.amountToPay,
              }
        ),
        adjustments: extras.map((x) => ({
          label: x.label,
          scope: x.payment_group_id ? targetName(x.payment_group_id) : 'split among everyone',
          amount: Number(x.amount) || 0,
        })),
        totalCollected: totals.totalCollected,
        // only once someone has paid — before that it would just repeat the total
        outstanding: payStatus.paidCount > 0 ? payStatus.outstanding : null,
        totalFunds: totals.totalFunds,
        totalAccumulated: accumulatedFunds,
        fmt: peso,
      })

      const suffix = sessionName ? `-${sessionName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''
      const filename = `court-split-${date}${suffix}.png`
      if (mode === 'share') await shareCanvas(canvas, filename, `Court Split — ${date}`)
      else await downloadCanvas(canvas, filename)
    } catch (err) {
      setSaveError(err?.message || 'Could not export the ledger image')
    } finally {
      setExporting('')
    }
  }

  return (
    <div>
      {errorBanner}
      {dateBar}
      {sessionTabs}

      <div className="panel">
        <h2>Session settings</h2>

        <div className="field-row">
          <div className="field">
            <label>Court fee — how it's split</label>
            <select
              value={session.court_fee_mode || 'per_person'}
              onChange={(e) => updateSessionField('court_fee_mode', e.target.value)}
            >
              <option value="per_person">Fixed amount per person</option>
              <option value="split">Total court fee ÷ all players</option>
            </select>
          </div>
          {splitMode ? (
            <NumberField
              label="Total court fee (whole session)"
              value={session.court_fee_total ?? 0}
              onCommit={(v) => updateSessionField('court_fee_total', v)}
            />
          ) : (
            <NumberField
              label="Court fee per person"
              value={session.court_fee_per_slot}
              onCommit={(v) => updateSessionField('court_fee_per_slot', v)}
            />
          )}
          <NumberField
            label="Guest fixed rate (per person)"
            value={session.guest_fixed_rate}
            onCommit={(v) => updateSessionField('guest_fixed_rate', v)}
          />
        </div>

        <div className="field-row">
          <NumberField
            label="Shuttles used this session"
            step="1"
            min="0"
            value={session.shuttle_count ?? 0}
            onCommit={(v) => updateSessionField('shuttle_count', v)}
          />
          <NumberField
            label="Price per shuttle"
            step="0.01"
            min="0"
            value={session.shuttle_price_each ?? 0}
            onCommit={(v) => updateSessionField('shuttle_price_each', v)}
          />
          <div className="field">
            <label>Label (optional)</label>
            <input
              value={session.label ?? ''}
              onChange={(e) => updateSessionField('label', e.target.value)}
              placeholder="e.g. Morning, Evening"
            />
          </div>
        </div>

        <div className="rate-readout">
          <div className="rate-chip">
            <span className="rate-label">Players so far</span>
            <span className="rate-value">{headTotal || '—'}</span>
          </div>
          <div className="rate-chip">
            <span className="rate-label">Shuttle cost / person</span>
            <span className="rate-value">
              ₱{money(rates.shuttleUnitCost)}
              {headTotal > 0 && (
                <small>
                  {' '}
                  = ₱{money(rates.shuttleTotalCost)} ÷ {headTotal}
                </small>
              )}
            </span>
          </div>
          <div className="rate-chip">
            <span className="rate-label">Court fee / person</span>
            <span className="rate-value">
              ₱{money(rates.courtUnitCost)}
              {splitMode && headTotal > 0 && (
                <small>
                  {' '}
                  = ₱{money(rates.courtFeeTotal)} ÷ {headTotal}
                </small>
              )}
            </span>
          </div>
        </div>
        {splitMode && headTotal === 0 && (
          <p className="hint">Per-person amounts appear once you add players below.</p>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Who's playing today</h2>
          <span className="muted">
            {syncing && <span className="sync-dot" title="Saving…" />}
            {groups.length} of {players.length} selected
            {notYetIn.length > 0 && (
              <>
                {' · '}
                <button type="button" className="link-btn" onClick={addAll}>Add all</button>
              </>
            )}
          </span>
        </div>
        {players.length === 0 ? (
          <div className="empty-state">No active players. Add some on the Players tab.</div>
        ) : (
          <div className="roster-picker">
            {rosterUnits.map((u) =>
              u.type === 'solo' ? (
                <PlayerChip
                  key={u.key}
                  name={u.player.name}
                  status={u.player.status}
                  on={groupByPayer.has(u.player.id)}
                  onClick={() => togglePlayer(u.player)}
                />
              ) : (
                <div className="roster-pair" key={u.key} title={u.name}>
                  {u.members.map((m, i) => (
                    <Fragment key={m.id}>
                      {i > 0 && <span className="pair-link" aria-hidden="true">⁃</span>}
                      <PlayerChip
                        name={m.name}
                        status={m.status}
                        on={groupByPayer.has(m.id)}
                        onClick={() => togglePlayer(m)}
                      />
                    </Fragment>
                  ))}
                </div>
              )
            )}
          </div>
        )}

        <details className="covering">
          <summary>Someone covering others?</summary>
          <form onSubmit={addCoveringGroup}>
            <div className="field-row">
              <div className="field" style={{ flex: 2 }}>
                <label>Who's paying</label>
                <select value={payerId} onChange={(e) => setPayerId(e.target.value)}>
                  <option value="">Select a player…</option>
                  {notYetIn.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.status === 'regular' ? 'Regular' : 'Guest'})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Headcount</label>
                <input
                  type="number"
                  min="1"
                  inputMode="numeric"
                  value={headcount}
                  onChange={(e) => setHeadcount(e.target.value)}
                />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Who's covered (note, optional)</label>
                <input value={members} onChange={(e) => setMembers(e.target.value)} placeholder="e.g. wife + 3 friends" />
              </div>
            </div>
            <button className="primary" type="submit" disabled={!payerId}>Add group</button>
          </form>
          {notYetIn.length === 0 && (
            <p className="hint">Everyone on the roster is already in — adjust headcount in the ledger below.</p>
          )}
        </details>
      </div>

      <div className="panel">
        <h2>Costs &amp; credits</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          <strong>Charges</strong> add — water, penalties, parking, snacks.{' '}
          <strong>Credits</strong> subtract — someone who bought the shuttles for the group, or is
          carrying an overpayment forward. Either can hit one payer or be split across everyone by headcount.
        </p>

        {extras.length > 0 && (
          <ul className="extra-list">
            {extras.map((x) => {
              const credit = Number(x.amount) < 0
              return (
                <li key={x.id} className={credit ? 'is-credit' : ''}>
                  <span className="extra-name">{x.label}</span>
                  <span className="extra-target">
                    {credit ? 'credit ' : ''}
                    {x.payment_group_id ? `→ ${targetName(x.payment_group_id)}` : '→ split among everyone'}
                  </span>
                  <span className="extra-amount">{peso(x.amount)}</span>
                  <button className="danger-link" onClick={() => removeExtra(x.id)}>Remove</button>
                </li>
              )
            })}
          </ul>
        )}

        <form onSubmit={addExtra}>
          <div className="field-row">
            <div className="field">
              <label>Type</label>
              <select value={costKind} onChange={(e) => setCostKind(e.target.value)}>
                <option value="charge">Charge (adds)</option>
                <option value="credit">Credit (subtracts)</option>
              </select>
            </div>
            <div className="field" style={{ flex: 2 }}>
              <label>Name</label>
              <input
                value={costLabel}
                onChange={(e) => setCostLabel(e.target.value)}
                placeholder={
                  costKind === 'credit' ? 'e.g. Bought shuttles, Overpaid last time' : 'e.g. Water, Late penalty, Parking'
                }
              />
            </div>
            <div className="field">
              <label>Amount</label>
              <input
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                value={costAmount}
                onChange={(e) => setCostAmount(e.target.value)}
              />
            </div>
          </div>
          <div className="field-row">
            <div className="field" style={{ flex: 2 }}>
              <label>Applies to</label>
              <select value={costTarget} onChange={(e) => setCostTarget(e.target.value)}>
                <option value="">Split among everyone</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.players?.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" />
          </div>
          <button className="primary" type="submit">
            {costKind === 'credit' ? 'Add credit' : 'Add charge'}
          </button>
        </form>

        {exSummary.splitTotal !== 0 && (
          <p className="hint">
            Split {exSummary.splitTotal < 0 ? 'credits' : 'costs'} total {peso(exSummary.splitTotal)} —{' '}
            {headTotal > 0
              ? `${peso(exSummary.splitUnit)} per person`
              : 'per-person share shows once players are added'}
            .
          </p>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Ledger</h2>
          <div className="row-actions">
            {CAN_SHARE && (
              <button
                type="button"
                className="ghost"
                onClick={() => exportLedger('share')}
                disabled={!!exporting || groups.length === 0}
                title="Send the bill to Messenger, WhatsApp, Mail…"
              >
                {exporting === 'share' ? 'Preparing…' : 'Share'}
              </button>
            )}
            <button
              type="button"
              className="ghost"
              onClick={() => exportLedger('download')}
              disabled={!!exporting || groups.length === 0}
            >
              {exporting === 'download' ? 'Preparing…' : 'Download image'}
            </button>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          Couples &amp; groups show one combined total — expand a row to see or edit each person.
        </p>
        {groups.length === 0 ? (
          <div className="empty-state">No one added yet. Pick players above.</div>
        ) : (
          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Payer</th>
                  <th>Status</th>
                  <th className="num">Headcount</th>
                  <th className="num">Extras</th>
                  <th className="num">Actual cost</th>
                  <th className="num">Amount to pay</th>
                  <th>Paid</th>
                  <th className="num">Funds</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {ledgerRows.map((lr) => {
                  if (lr.type === 'solo') {
                    const { row: g, calc: r } = lr
                    return (
                      <tr
                        key={g.id}
                        className={[g.payer_status_snapshot === 'guest' && 'row-guest', g.paid_at && 'row-paid']
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <td>
                          {g.players?.name}
                          {g.members && <div className="sub-note">+ {g.members}</div>}
                        </td>
                        <td><StatusBadge status={g.payer_status_snapshot} /></td>
                        <td className="num">
                          <HeadcountCell row={g} setGroups={setGroups} commit={commitHeadcount} />
                        </td>
                        <td className="num">{r.extrasTotal !== 0 ? peso(r.extrasTotal) : '—'}</td>
                        <td className="num">{peso(r.actualCost)}</td>
                        <td className="num"><strong>{peso(r.amountToPay)}</strong></td>
                        <td><PaidToggle paid={!!g.paid_at} onChange={(v) => setPaid([g], v)} /></td>
                        <td className="num">{r.fundsGenerated > 0 ? `₱${money(r.fundsGenerated)}` : '—'}</td>
                        <td>
                          <button className="danger-link" onClick={() => removeRows([g])}>Remove</button>
                        </td>
                      </tr>
                    )
                  }

                  const isOpen = expanded.has(lr.key)
                  return (
                    <Fragment key={lr.key}>
                      <tr className={[lr.allGuest && 'row-guest', lr.allPaid && 'row-paid'].filter(Boolean).join(' ')}>
                        <td>
                          <button
                            type="button"
                            className="disclosure"
                            aria-expanded={isOpen}
                            onClick={() => toggleExpanded(lr.key)}
                          >
                            <span className="disclosure-caret">{isOpen ? '▾' : '▸'}</span>
                            {lr.title}
                          </button>
                          <div className="sub-note">{lr.names.join(' + ')}</div>
                        </td>
                        <td>
                          {lr.allGuest ? (
                            <StatusBadge status="guest" />
                          ) : lr.anyGuest ? (
                            <span className="badge badge-mixed">Mixed</span>
                          ) : (
                            <StatusBadge status="regular" />
                          )}
                        </td>
                        <td className="num">{lr.headcount}</td>
                        <td className="num">{lr.extrasTotal !== 0 ? peso(lr.extrasTotal) : '—'}</td>
                        <td className="num">{peso(lr.actualCost)}</td>
                        <td className="num"><strong>{peso(lr.amountToPay)}</strong></td>
                        <td>
                          <PaidToggle
                            paid={lr.allPaid}
                            partial={lr.paidCount > 0}
                            onChange={(v) => setPaid(lr.parts.map((p) => p.row), v)}
                          />
                        </td>
                        <td className="num">{lr.fundsGenerated > 0 ? `₱${money(lr.fundsGenerated)}` : '—'}</td>
                        <td>
                          <button
                            className="danger-link"
                            onClick={() => removeRows(lr.parts.map((p) => p.row))}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                      {isOpen &&
                        lr.parts.map(({ row: g, calc: r }) => (
                          <tr key={g.id} className={`subrow ${g.paid_at ? 'row-paid' : ''}`}>
                            <td>
                              ↳ {g.players?.name}
                              {g.members && <span className="muted"> · + {g.members}</span>}
                            </td>
                            <td><StatusBadge status={g.payer_status_snapshot} /></td>
                            <td className="num">
                              <HeadcountCell row={g} setGroups={setGroups} commit={commitHeadcount} />
                            </td>
                            <td className="num">{r.extrasTotal !== 0 ? peso(r.extrasTotal) : '—'}</td>
                            <td className="num">{peso(r.actualCost)}</td>
                            <td className="num">{peso(r.amountToPay)}</td>
                            <td><PaidToggle paid={!!g.paid_at} onChange={(v) => setPaid([g], v)} /></td>
                            <td className="num">{r.fundsGenerated > 0 ? `₱${money(r.fundsGenerated)}` : '—'}</td>
                            <td>
                              <button className="danger-link" onClick={() => removeRows([g])}>Remove</button>
                            </td>
                          </tr>
                        ))}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {groups.length > 0 && (
          <p className="paid-progress">
            <strong>{payStatus.paidCount} of {groups.length}</strong> paid
            {' · '}{peso(payStatus.collected)} in
            {' · '}
            {payStatus.outstanding > 0.005 ? (
              <><strong>{peso(payStatus.outstanding)}</strong> still to collect</>
            ) : (
              <strong>all settled</strong>
            )}
          </p>
        )}

        <div className="summary-row">
          <div className="summary-card">
            <div className="label">Total collected today</div>
            <div className="value">₱{money(totals.totalCollected)}</div>
          </div>
          <div className="summary-card gold">
            <div className="label">Funds generated today</div>
            <div className="value">₱{money(totals.totalFunds)}</div>
          </div>
          <div className="summary-card gold">
            <div className="label">Total accumulated funds (all time)</div>
            <div className="value">₱{money(accumulatedFunds)}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
