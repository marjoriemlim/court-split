import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import {
  RANKS,
  rankLabel,
  checkScore,
  toMatch,
  buildHistory,
  busyEntryIds,
  freeCourts,
  queueOrder,
  pickNextMatch,
  describeMatch,
  nightSummary,
  SCORING,
} from '../lib/queue'

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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

const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const minutesSince = (t, now) => Math.max(0, Math.floor((now - new Date(t).getTime()) / 60000))
const minutesUntil = (t, now) => Math.max(0, Math.ceil((new Date(t).getTime() - now) / 60000))

const SIT_OUT_CHOICES = [
  { value: '30', label: 'Rest 30 min' },
  { value: '60', label: 'Rest 1 hour' },
  { value: 'open', label: 'Rest until I bring them back' },
  { value: 'left', label: 'Left for the night' },
]

// A one-tap menu that resets itself after each pick.
function SitOutPicker({ entry, disabled, onPick }) {
  return (
    <select className="inline-select sit-out" value="" disabled={disabled}
      aria-label={`Sit ${entry.display_name} out`}
      onChange={(e) => {
        const v = e.target.value
        if (!v) return
        onPick(entry, v === 'open' || v === 'left' ? v : Number(v))
      }}>
      <option value="">Sit out…</option>
      {SIT_OUT_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
    </select>
  )
}

// "Ben ×2, Cy, Dee": repeats get a count so they stand out.
const peopleList = (people) =>
  people.length === 0
    ? '—'
    : people.map((p, i) => (
        <span key={p.entry.id}>
          {i > 0 && ', '}
          {p.entry.display_name}
          {p.count > 1 && <strong className="repeat-count"> ×{p.count}</strong>}
        </span>
      ))

function RankBadge({ rank }) {
  return <span className={`rank-badge rank-${rank || 'beginner'}`}>{rankLabel(rank)}</span>
}

function TeamLine({ team, byId }) {
  return (
    <div className="team">
      {team.map((id) => {
        const e = byId.get(id)
        return (
          <div className="team-player" key={id}>
            <span>{e?.display_name ?? '?'}</span>
            {e && <RankBadge rank={e.rank} />}
          </div>
        )
      })}
    </div>
  )
}

// Score entry for a game in progress. The winner follows the score, but can
// be overridden for a game that ended early or a tie called by the players.
function ScoreForm({ match, byId, onSave, onCancel }) {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [override, setOverride] = useState(null)
  const result = checkScore(a, b)
  const winner = override ?? result.winner
  const bothEntered = a !== '' && b !== ''
  const names = (team) => team.map((id) => byId.get(id)?.display_name ?? '?').join(' & ')

  return (
    <div className="score-form">
      <div className="score-inputs">
        <label>
          <span>{names(match.teamA)}</span>
          <input type="number" min="0" max={SCORING.cap} inputMode="numeric" value={a}
            onChange={(e) => { setA(e.target.value); setOverride(null) }} />
        </label>
        <span className="score-dash">–</span>
        <label>
          <span>{names(match.teamB)}</span>
          <input type="number" min="0" max={SCORING.cap} inputMode="numeric" value={b}
            onChange={(e) => { setB(e.target.value); setOverride(null) }} />
        </label>
      </div>

      <div className="winner-pick">
        <span className="muted">Winner:</span>
        {['a', 'b'].map((side) => (
          <button key={side} type="button"
            className={`session-tab ${winner === side ? 'on' : ''}`}
            onClick={() => setOverride(side)}>
            {names(side === 'a' ? match.teamA : match.teamB)}
          </button>
        ))}
      </div>

      {bothEntered && !result.valid && result.message && (
        <p className="hint score-warning">{result.message} You can still save it.</p>
      )}

      <div className="row-actions">
        <button className="primary" type="button" disabled={!winner}
          onClick={() => onSave({
            team_a_score: a === '' ? null : Number(a),
            team_b_score: b === '' ? null : Number(b),
            winner,
          })}>
          Save result
        </button>
        <button className="ghost" type="button" onClick={onCancel}>Back</button>
      </div>
    </div>
  )
}

export default function QueuePage() {
  const { date: dateParam } = useParams()
  const navigate = useNavigate()
  const date = dateParam || todayStr()
  const isToday = date === todayStr()
  const goToDate = (d) => navigate(d === todayStr() ? '/queue' : `/queue/${d}`)

  const [daySessions, setDaySessions] = useState([])
  const [session, setSession] = useState(null)
  const [players, setPlayers] = useState([])
  const [payerIds, setPayerIds] = useState([])
  const [entries, setEntries] = useState([])
  const [matchRows, setMatchRows] = useState([])
  const [matchPlayers, setMatchPlayers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)

  const [drafts, setDrafts] = useState({}) // court_no -> { teamA: [id,id], teamB: [id,id] } chosen by hand
  const [editing, setEditing] = useState(null) // court_no whose players are being changed
  const [scoring, setScoring] = useState(null) // match id whose score is being entered

  const [guestName, setGuestName] = useState('')
  const [guestRank, setGuestRank] = useState('beginner')

  // Re-render every 30s so timers, waits and finished rests stay current.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000)
    return () => clearInterval(t)
  }, [])

  async function loadSessionData(sessionId) {
    const [{ data: es }, { data: ms }, { data: pgs }] = await Promise.all([
      supabase.from('queue_entries').select('*').eq('session_id', sessionId).order('created_at'),
      supabase.from('matches').select('*, match_players(*)').eq('session_id', sessionId).order('started_at'),
      supabase.from('payment_groups').select('payer_id').eq('session_id', sessionId),
    ])
    setEntries(es || [])
    setMatchRows((ms || []).map(({ match_players, ...m }) => m))
    setMatchPlayers((ms || []).flatMap((m) => m.match_players || []))
    setPayerIds((pgs || []).map((g) => g.payer_id))
  }

  async function reload() {
    if (session) await loadSessionData(session.id)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      setDrafts({})
      setEditing(null)
      setScoring(null)
      const [{ data: ps }, { data: ss }] = await Promise.all([
        supabase.from('players').select('id, name, rank, status').eq('active', true).order('name'),
        supabase.from('sessions').select('*').eq('session_date', date).order('created_at'),
      ])
      if (cancelled) return
      setPlayers(ps || [])
      setDaySessions(ss || [])
      const first = (ss || [])[0] || null
      setSession(first)
      if (first) await loadSessionData(first.id)
      else {
        setEntries([])
        setMatchRows([])
        setMatchPlayers([])
        setPayerIds([])
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [date])

  async function selectSession(s) {
    if (s.id === session?.id) return
    setLoading(true)
    setDrafts({})
    setEditing(null)
    setScoring(null)
    setSession(s)
    await loadSessionData(s.id)
    setLoading(false)
  }

  async function startSessionHere() {
    const { data, error: err } = await supabase.from('sessions').insert({ session_date: date }).select().single()
    if (err) return setError(err.message)
    setDaySessions([data])
    setSession(data)
    await loadSessionData(data.id)
  }

  // Run a write, show any error, then reload the night.
  async function run(fn) {
    setBusy(true)
    setError('')
    try {
      const err = await fn()
      if (err) setError(err.message || String(err))
    } finally {
      await reload()
      setBusy(false)
    }
  }

  // ── Derived state ────────────────────────────────────────────────
  const matches = useMemo(() => matchRows.map((r) => toMatch(r, matchPlayers)), [matchRows, matchPlayers])
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries])
  const history = useMemo(() => buildHistory(matches), [matches])
  const onCourt = useMemo(() => busyEntryIds(matches), [matches])
  const courtCount = session?.court_count ?? 2

  const now = Date.now()
  const ready = queueOrder(entries, matches, now)
  const readyKey = ready.map((e) => e.id).join(',')
  const readyIds = new Set(ready.map((e) => e.id))

  // One suggestion per free court. Hand-picked drafts are kept as they are and
  // their players are held back from the courts after them. Only recomputed
  // when who's available changes, so a suggestion doesn't shift under your thumb.
  const suggestions = useMemo(() => {
    const out = {}
    const taken = []
    for (const c of freeCourts(courtCount, matches)) {
      const draft = drafts[c]
      if (draft) {
        out[c] = { ...draft, manual: true }
        taken.push(...draft.teamA, ...draft.teamB)
        continue
      }
      const pick = pickNextMatch({ entries, matches, exclude: taken })
      if (!pick) break
      out[c] = { teamA: pick.teamA.map((e) => e.id), teamB: pick.teamB.map((e) => e.id), notes: pick.notes }
      taken.push(...out[c].teamA, ...out[c].teamB)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courtCount, matches, entries, readyKey, drafts])

  const liveByCourt = new Map(matches.filter((m) => m.status === 'in_progress').map((m) => [m.court_no, m]))
  const finished = matches.filter((m) => m.status === 'done').slice().reverse()
  const summary = nightSummary(matches, entries)
  const entryByPlayer = new Map(entries.filter((e) => e.player_id).map((e) => [e.player_id, e]))
  const missingPayers = players.filter((p) => payerIds.includes(p.id) && !entryByPlayer.has(p.id))
  const checkedIn = entries.filter((e) => e.state !== 'left')
  const suggested = new Set(Object.values(suggestions).flatMap((s) => [...s.teamA, ...s.teamB]))
  const unassigned = ready.filter((e) => !suggested.has(e.id)).length
  const resting = entries
    .filter((e) => e.state === 'resting' && !readyIds.has(e.id) && !onCourt.has(e.id))
    .sort((x, y) => (x.resting_until ? new Date(x.resting_until) : Infinity) - (y.resting_until ? new Date(y.resting_until) : Infinity))
  const gone = entries.filter((e) => e.state === 'left')

  // ── Actions ──────────────────────────────────────────────────────
  const setCourtCount = (n) =>
    run(async () => {
      const value = Math.min(20, Math.max(1, n))
      setSession((s) => ({ ...s, court_count: value }))
      setDaySessions((list) => list.map((s) => (s.id === session.id ? { ...s, court_count: value } : s)))
      const { error: err } = await supabase.from('sessions').update({ court_count: value }).eq('id', session.id)
      return err
    })

  const togglePlayer = (p) =>
    run(async () => {
      const entry = entryByPlayer.get(p.id)
      if (!entry) {
        const { error: err } = await supabase.from('queue_entries').insert({
          session_id: session.id, player_id: p.id, display_name: p.name, rank: p.rank || 'beginner',
        })
        return err
      }
      if (entry.state === 'left') {
        const { error: err } = await supabase.from('queue_entries')
          .update({ state: 'waiting', resting_until: null, available_since: new Date().toISOString() })
          .eq('id', entry.id)
        return err
      }
      if (onCourt.has(entry.id)) return new Error(`${p.name} is on court. Finish or cancel that game first.`)
      // Anyone who has played keeps their record; only a mistaken check-in is deleted.
      if (history.gamesPlayed(entry.id) > 0) {
        const { error: err } = await supabase.from('queue_entries').update({ state: 'left' }).eq('id', entry.id)
        return err
      }
      const { error: err } = await supabase.from('queue_entries').delete().eq('id', entry.id)
      return err
    })

  const addPayers = () =>
    run(async () => {
      const rows = missingPayers.map((p) => ({
        session_id: session.id, player_id: p.id, display_name: p.name, rank: p.rank || 'beginner',
      }))
      if (!rows.length) return null
      const { error: err } = await supabase.from('queue_entries').insert(rows)
      return err
    })

  const addGuest = (e) => {
    e.preventDefault()
    const name = guestName.trim()
    if (!name) return
    run(async () => {
      const { error: err } = await supabase.from('queue_entries')
        .insert({ session_id: session.id, display_name: name, rank: guestRank })
      if (!err) setGuestName('')
      return err
    })
  }

  const setEntryRank = (entry, rank) =>
    run(async () => {
      setEntries((list) => list.map((x) => (x.id === entry.id ? { ...x, rank } : x)))
      const { error: err } = await supabase.from('queue_entries').update({ rank }).eq('id', entry.id)
      return err
    })

  const startGame = (court_no, s) =>
    run(async () => {
      const ids = [...s.teamA, ...s.teamB]
      if (new Set(ids).size !== 4) return new Error('Pick 4 different players.')
      const notFree = ids.filter((id) => !readyIds.has(id))
      if (notFree.length) {
        return new Error(`${notFree.map((id) => byId.get(id)?.display_name).join(', ')} isn't free right now.`)
      }
      const { data: m, error: err } = await supabase.from('matches')
        .insert({ session_id: session.id, court_no }).select().single()
      if (err) return err
      const { error: err2 } = await supabase.from('match_players').insert([
        ...s.teamA.map((entry_id) => ({ match_id: m.id, entry_id, team: 'a' })),
        ...s.teamB.map((entry_id) => ({ match_id: m.id, entry_id, team: 'b' })),
      ])
      if (err2) {
        await supabase.from('matches').delete().eq('id', m.id)
        return err2
      }
      // Drop this court's draft, and any other draft that used these players.
      setDrafts((prev) => {
        const next = {}
        for (const [c, d] of Object.entries(prev)) {
          if (Number(c) === court_no) continue
          if ([...d.teamA, ...d.teamB].some((id) => ids.includes(id))) continue
          next[c] = d
        }
        return next
      })
      setEditing(null)
      return null
    })

  const saveResult = (match, result) =>
    run(async () => {
      const ended = new Date().toISOString()
      const { error: err } = await supabase.from('matches')
        .update({ ...result, status: 'done', ended_at: ended }).eq('id', match.id)
      if (err) return err
      // Back of the queue for everyone who just played.
      const { error: err2 } = await supabase.from('queue_entries')
        .update({ available_since: ended }).in('id', [...match.teamA, ...match.teamB])
      setScoring(null)
      return err2
    })

  const cancelGame = (match) => {
    if (!window.confirm('Cancel this game? The players go back to where they were in the queue.')) return
    run(async () => {
      const { error: err } = await supabase.from('matches')
        .update({ status: 'void', ended_at: new Date().toISOString() }).eq('id', match.id)
      return err
    })
  }

  // Forget any hand-picked line-up that includes this player.
  const dropFromDrafts = (id) =>
    setDrafts((prev) => {
      const next = {}
      for (const [c, d] of Object.entries(prev)) {
        if (![...d.teamA, ...d.teamB].includes(id)) next[c] = d
      }
      return next
    })

  // choice: minutes to rest, 'open' to rest until brought back, or 'left'.
  const sitOut = (entry, choice) =>
    run(async () => {
      if (onCourt.has(entry.id)) return new Error(`${entry.display_name} is on court. Finish that game first.`)
      dropFromDrafts(entry.id)
      const update =
        choice === 'left'
          ? { state: 'left', resting_until: null }
          : {
              state: 'resting',
              resting_until: choice === 'open' ? null : new Date(Date.now() + choice * 60000).toISOString(),
            }
      const { error: err } = await supabase.from('queue_entries').update(update).eq('id', entry.id)
      return err
    })

  // Back from a rest (or back after leaving): joins the end of the line.
  const bringBack = (entry) =>
    run(async () => {
      const { error: err } = await supabase.from('queue_entries')
        .update({ state: 'waiting', resting_until: null, available_since: new Date().toISOString() })
        .eq('id', entry.id)
      return err
    })

  const editSlot = (court_no, s, team, idx, id) => {
    const next = { teamA: [...s.teamA], teamB: [...s.teamB] }
    next[team][idx] = id
    setDrafts((prev) => ({ ...prev, [court_no]: next }))
  }

  const resetDraft = (court_no) => {
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[court_no]
      return next
    })
    setEditing(null)
  }

  // ── Render ───────────────────────────────────────────────────────
  const errorBanner = error && (
    <div className="save-error">
      <span>{error}</span>
      <button className="link-btn" onClick={() => setError('')}>Dismiss</button>
    </div>
  )

  const dateBar = (
    <div className="panel date-bar">
      <div className="date-controls">
        <button className="ghost" onClick={() => goToDate(shiftDate(date, -1))} aria-label="Previous day">‹</button>
        <input type="date" className="date-input" value={date}
          onChange={(e) => e.target.value && goToDate(e.target.value)} />
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

  const sessionTabs = daySessions.length > 1 && (
    <div className="session-tabs">
      {daySessions.map((s, i) => (
        <button key={s.id} type="button" className={`session-tab ${s.id === session?.id ? 'on' : ''}`}
          onClick={() => selectSession(s)}>
          {s.label?.trim() || `Session ${i + 1}`}
        </button>
      ))}
    </div>
  )

  if (loading) return <div>{errorBanner}{dateBar}<p>Loading queue…</p></div>

  if (!session) {
    return (
      <div>
        {errorBanner}
        {dateBar}
        <div className="panel">
          <div className="empty-state">
            <p>No session recorded for {prettyDate(date)}.</p>
            <button className="primary" onClick={startSessionHere}>Start a session for this date</button>
          </div>
        </div>
      </div>
    )
  }

  const courtCard = (c) => {
    const live = liveByCourt.get(c)
    if (live) {
      return (
        <div className="court-card live" key={c}>
          <div className="court-card-head">
            <h3>Court {c}</h3>
            <span className="muted">Playing · {minutesSince(live.started_at, now)} min</span>
          </div>
          {scoring === live.id ? (
            <ScoreForm match={live} byId={byId} onCancel={() => setScoring(null)}
              onSave={(result) => saveResult(live, result)} />
          ) : (
            <>
              <TeamLine team={live.teamA} byId={byId} />
              <div className="vs">vs</div>
              <TeamLine team={live.teamB} byId={byId} />
              <div className="row-actions court-actions">
                <button className="primary" disabled={busy} onClick={() => setScoring(live.id)}>Enter score</button>
                <button className="danger-link" disabled={busy} onClick={() => cancelGame(live)}>Cancel game</button>
              </div>
            </>
          )}
        </div>
      )
    }

    const s = suggestions[c]
    if (!s) {
      return (
        <div className="court-card" key={c}>
          <div className="court-card-head"><h3>Court {c}</h3><span className="muted">Free</span></div>
          <p className="muted">Needs 4 free players. Only {unassigned} free right now.</p>
        </div>
      )
    }

    const notes = s.manual
      ? describeMatch(s.teamA.map((id) => byId.get(id)), s.teamB.map((id) => byId.get(id)), history)
      : s.notes
    // Choices for a slot: anyone free who isn't already in this line-up.
    const slotOptions = (current) => {
      const used = new Set([...s.teamA, ...s.teamB])
      return ready.filter((e) => e.id === current || !used.has(e.id))
    }

    return (
      <div className="court-card" key={c}>
        <div className="court-card-head">
          <h3>Court {c}</h3>
          <span className="muted">{s.manual ? 'Your pick' : 'Up next'}</span>
        </div>
        {editing === c ? (
          ['teamA', 'teamB'].map((team, ti) => (
            <div key={team}>
              {ti === 1 && <div className="vs">vs</div>}
              <div className="team">
                {s[team].map((id, idx) => (
                  <select key={idx} className="inline-select" value={id}
                    onChange={(e) => editSlot(c, s, team, idx, e.target.value)}>
                    {slotOptions(id).map((e) => (
                      <option key={e.id} value={e.id}>{e.display_name} ({rankLabel(e.rank)})</option>
                    ))}
                  </select>
                ))}
              </div>
            </div>
          ))
        ) : (
          <>
            <TeamLine team={s.teamA} byId={byId} />
            <div className="vs">vs</div>
            <TeamLine team={s.teamB} byId={byId} />
          </>
        )}
        <ul className="note-list">
          {notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
        <div className="row-actions court-actions">
          <button className="primary" disabled={busy} onClick={() => startGame(c, s)}>Start game</button>
          {editing === c ? (
            <button className="ghost" onClick={() => setEditing(null)}>Done</button>
          ) : (
            <button className="ghost" onClick={() => setEditing(c)}>Change players</button>
          )}
          {s.manual && <button className="link-btn" onClick={() => resetDraft(c)}>Use suggestion</button>}
        </div>
      </div>
    )
  }

  return (
    <div>
      {errorBanner}
      {dateBar}
      {sessionTabs}

      <div className="panel">
        <div className="panel-head">
          <h2>Courts</h2>
          <div className="stepper">
            <button className="ghost" disabled={busy || courtCount <= 1} onClick={() => setCourtCount(courtCount - 1)}
              aria-label="One court fewer">−</button>
            <span>{courtCount} court{courtCount === 1 ? '' : 's'}</span>
            <button className="ghost" disabled={busy || courtCount >= 20} onClick={() => setCourtCount(courtCount + 1)}
              aria-label="One more court">+</button>
          </div>
        </div>
        {checkedIn.length < 4 ? (
          <div className="empty-state">Check in at least 4 players below to start the first game.</div>
        ) : (
          <div className="court-grid">
            {Array.from({ length: courtCount }, (_, i) => courtCard(i + 1))}
            {/* A game still running on a court that was removed from the count */}
            {[...liveByCourt.keys()].filter((c) => c > courtCount).map((c) => courtCard(c))}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>In line</h2>
          <span className="muted">{ready.length} waiting · {onCourt.size} on court</span>
        </div>
        {ready.length === 0 ? (
          <p className="muted">Nobody waiting.</p>
        ) : (
          <ol className="queue-list">
            {ready.map((e) => (
              <li key={e.id}>
                <span className="queue-name">{e.display_name}</span>
                <select className="inline-select" value={e.rank} disabled={busy}
                  onChange={(ev) => setEntryRank(e, ev.target.value)} aria-label={`${e.display_name}'s rank tonight`}>
                  {RANKS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <span className="muted queue-meta">
                  {history.gamesPlayed(e.id)} game{history.gamesPlayed(e.id) === 1 ? '' : 's'} ·
                  waiting {minutesSince(e.waitingSince, now)} min
                  {e.state === 'resting' && ' · back from rest'}
                </span>
                <SitOutPicker entry={e} disabled={busy} onPick={sitOut} />
              </li>
            ))}
          </ol>
        )}

        {resting.length > 0 && (
          <>
            <h3 className="queue-subhead">Sitting out</h3>
            <ul className="queue-list plain">
              {resting.map((e) => (
                <li key={e.id} className="queue-resting">
                  <span className="queue-name">{e.display_name}</span>
                  <RankBadge rank={e.rank} />
                  <span className="muted queue-meta">
                    {e.resting_until
                      ? `Back at ${clock(e.resting_until)} · ${minutesUntil(e.resting_until, now)} min left`
                      : 'Until you bring them back'}
                  </span>
                  <span className="row-actions">
                    <button className="link-btn" disabled={busy} onClick={() => bringBack(e)}>Back now</button>
                    <button className="danger-link" disabled={busy} onClick={() => sitOut(e, 'left')}>Left</button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {gone.length > 0 && (
          <>
            <h3 className="queue-subhead">Left for the night</h3>
            <ul className="queue-list plain">
              {gone.map((e) => (
                <li key={e.id} className="queue-resting">
                  <span className="queue-name">{e.display_name}</span>
                  <span className="muted queue-meta">
                    {history.gamesPlayed(e.id)} game{history.gamesPlayed(e.id) === 1 ? '' : 's'}
                  </span>
                  <span className="row-actions">
                    <button className="link-btn" disabled={busy} onClick={() => bringBack(e)}>Back in</button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {onCourt.size > 0 && (
          <p className="hint">Players on court can sit out once their game is finished.</p>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Check in</h2>
          <span className="muted">
            {checkedIn.length} checked in
            {missingPayers.length > 0 && (
              <>
                {' · '}
                <button type="button" className="link-btn" disabled={busy} onClick={addPayers}>
                  Add tonight's {missingPayers.length} payer{missingPayers.length === 1 ? '' : 's'}
                </button>
              </>
            )}
          </span>
        </div>
        {players.length === 0 ? (
          <div className="empty-state">No active players. Add some on the Players tab.</div>
        ) : (
          <div className="roster-picker">
            {players.map((p) => {
              const entry = entryByPlayer.get(p.id)
              const on = !!entry && entry.state !== 'left'
              return (
                <button key={p.id} type="button" className={`roster-chip ${on ? 'on' : ''}`} aria-pressed={on}
                  disabled={busy} onClick={() => togglePlayer(p)}>
                  <span className="roster-check" aria-hidden="true">{on ? '✓' : '+'}</span>
                  <span className="roster-name">{p.name}</span>
                  <RankBadge rank={entry?.rank ?? p.rank} />
                </button>
              )
            })}
          </div>
        )}

        <form onSubmit={addGuest} className="field-row" style={{ alignItems: 'flex-end', marginTop: 16 }}>
          <div className="field" style={{ flex: 2 }}>
            <label>Someone not on the roster</label>
            <input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="e.g. Carl's friend Mia" />
          </div>
          <div className="field">
            <label>Rank</label>
            <select value={guestRank} onChange={(e) => setGuestRank(e.target.value)}>
              {RANKS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div className="field">
            <button className="primary" type="submit" disabled={busy || !guestName.trim()}>Check in</button>
          </div>
        </form>
        {entries.filter((e) => !e.player_id && e.state !== 'left').length > 0 && (
          <p className="hint">
            Not on the roster:{' '}
            {entries.filter((e) => !e.player_id && e.state !== 'left').map((e) => e.display_name).join(', ')}
          </p>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Tonight's games</h2>
          <span className="muted">{finished.length} played</span>
        </div>
        {finished.length === 0 ? (
          <p className="muted">No games finished yet.</p>
        ) : (
          <ul className="game-list">
            {finished.map((m) => {
              const side = (team, key) => (
                <span className={m.winner === key ? 'winner' : ''}>
                  {team.map((id) => byId.get(id)?.display_name ?? '?').join(' & ')}
                </span>
              )
              return (
                <li key={m.id}>
                  <span className="muted">Court {m.court_no} · {clock(m.ended_at || m.started_at)}</span>
                  <span className="game-line">
                    {side(m.teamA, 'a')}
                    <strong className="game-score">{m.team_a_score ?? '–'}–{m.team_b_score ?? '–'}</strong>
                    {side(m.teamB, 'b')}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {summary.games > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h2>Night summary</h2>
            <span className="muted">
              {summary.games} game{summary.games === 1 ? '' : 's'} · {summary.pairings.distinct} different
              partnership{summary.pairings.distinct === 1 ? '' : 's'}
              {summary.pairings.repeats > 0
                ? ` · ${summary.pairings.repeats} repeat${summary.pairings.repeats === 1 ? '' : 's'}`
                : ' · no repeat partners'}
            </span>
          </div>
          <div className="table-wrap">
            <table className="ledger summary-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th className="num">Games</th>
                  <th className="num">W–L</th>
                  <th className="num">Points</th>
                  <th>Partnered</th>
                  <th>Played against</th>
                </tr>
              </thead>
              <tbody>
                {summary.players.map((r) => (
                  <tr key={r.entry.id}>
                    <td>
                      <strong>{r.entry.display_name}</strong>
                      {r.entry.rank && <div className="sub-note">{rankLabel(r.entry.rank)}</div>}
                    </td>
                    <td className="num">{r.games}</td>
                    <td className="num">{r.wins}–{r.losses}</td>
                    <td className="num">
                      {r.pointsFor}–{r.pointsAgainst}
                      <div className="sub-note">
                        {r.pointsFor - r.pointsAgainst > 0 ? '+' : ''}{r.pointsFor - r.pointsAgainst}
                      </div>
                    </td>
                    <td className="people-cell">{peopleList(r.partners)}</td>
                    <td className="people-cell">{peopleList(r.opponents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="hint">
        Payments for this night are on the <Link to={isToday ? '/' : `/session/${date}`}>Session tab</Link>.
      </p>
    </div>
  )
}
