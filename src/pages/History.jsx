import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { calcSessionTotals, money } from '../lib/calc'

/**
 * A session only belongs in History once something was actually recorded against
 * it. Opening the app on a fresh date creates an empty session row so the common
 * flow stays one-click — those placeholders must not show up as past sessions.
 */
function hasRecord(session) {
  return (
    (session.payment_groups || []).length > 0 ||
    (session.extra_costs || []).length > 0 ||
    gamesPlayed(session) > 0
  )
}

const gamesPlayed = (session) => (session.matches || []).filter((m) => m.status === 'done').length

const pad = (n) => String(n).padStart(2, '0')
// Local calendar date, not UTC (see SessionPage).
const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function History() {
  const [rows, setRows] = useState([])
  const [opening, setOpening] = useState({ balance: 0, asOf: null })
  const [withdrawals, setWithdrawals] = useState([])
  const [loading, setLoading] = useState(true)

  const [wAmount, setWAmount] = useState('')
  const [wNote, setWNote] = useState('')
  const [wDate, setWDate] = useState(todayStr)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function loadWithdrawals() {
    const { data } = await supabase
      .from('fund_withdrawals')
      .select('*')
      .order('withdrawn_on', { ascending: false })
      .order('created_at', { ascending: false })
    setWithdrawals(data || [])
  }

  useEffect(() => {
    async function load() {
      const { data: sessions } = await supabase
        .from('sessions')
        .select('*, payment_groups(*), extra_costs(*), matches(status)')
        .order('session_date', { ascending: false })
        .order('created_at', { ascending: true }) // morning before evening within a day

      const withTotals = (sessions || []).filter(hasRecord).map((s) => ({
        ...s,
        totals: calcSessionTotals(s, s.payment_groups || [], s.extra_costs || []),
      }))
      setRows(withTotals)

      // Funds already in the kitty before the first session this app tracks.
      const { data: settings } = await supabase
        .from('fund_settings')
        .select('opening_balance, opening_as_of')
        .maybeSingle()
      setOpening({
        balance: Number(settings?.opening_balance) || 0,
        asOf: settings?.opening_as_of || null,
      })

      await loadWithdrawals()
      setLoading(false)
    }
    load()
  }, [])

  async function addWithdrawal(e) {
    e.preventDefault()
    const amount = Math.round(Number(wAmount) * 100) / 100
    if (!(amount > 0)) {
      setError('Enter an amount greater than zero.')
      return
    }
    setError('')
    setSaving(true)
    const { error: err } = await supabase
      .from('fund_withdrawals')
      .insert({ amount, note: wNote.trim(), withdrawn_on: wDate || todayStr() })
    setSaving(false)
    if (err) {
      setError(`Couldn't save: ${err.message}`)
      return
    }
    setWAmount('')
    setWNote('')
    setWDate(todayStr())
    await loadWithdrawals()
  }

  async function deleteWithdrawal(w) {
    const what = w.note ? `"${w.note}"` : 'this withdrawal'
    if (!window.confirm(`Remove ${what} (₱${money(w.amount)})? It goes back into the total.`)) return
    const { error: err } = await supabase.from('fund_withdrawals').delete().eq('id', w.id)
    if (err) {
      setError(`Couldn't remove: ${err.message}`)
      return
    }
    await loadWithdrawals()
  }

  const generated = rows.reduce((sum, r) => sum + r.totals.totalFunds, 0)
  const withdrawn = withdrawals.reduce((sum, w) => sum + Number(w.amount), 0)
  const accumulated = opening.balance + generated - withdrawn

  // Sessions and withdrawals in one newest-first ledger. On the same day the
  // withdrawal sits above the sessions (it usually comes out of that day's take).
  const ledger = [
    ...rows.map((r) => ({ kind: 'session', date: r.session_date, r })),
    ...withdrawals.map((w) => ({ kind: 'withdrawal', date: w.withdrawn_on, w })),
  ].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    if (a.kind !== b.kind) return a.kind === 'withdrawal' ? -1 : 1
    return 0
  })

  if (loading) return <p>Loading history…</p>

  return (
    <div>
      <div className="panel">
        <div className="summary-row">
          <div className="summary-card gold">
            <div className="label">Total accumulated funds (all time)</div>
            <div className="value">₱{money(accumulated)}</div>
            {withdrawn > 0 && (
              <div className="sub-note">after ₱{money(withdrawn)} taken out</div>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Take money out of the funds</h2>
        <form onSubmit={addWithdrawal}>
          <div className="field-row withdraw-row">
            <div className="field">
              <label>Amount (₱)</label>
              <input
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={wAmount}
                onChange={(e) => setWAmount(e.target.value)}
                placeholder="e.g. 500"
              />
            </div>
            <div className="field" style={{ flex: 2 }}>
              <label>What for</label>
              <input
                value={wNote}
                onChange={(e) => setWNote(e.target.value)}
                placeholder="e.g. New tube of shuttles"
              />
            </div>
            <div className="field">
              <label>Date</label>
              <input type="date" value={wDate} onChange={(e) => setWDate(e.target.value)} />
            </div>
          </div>
          {error && <p className="form-error">{error}</p>}
          <button className="primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Subtract from funds'}
          </button>
        </form>
      </div>

      <div className="panel">
        <h2>Past sessions</h2>
        {ledger.length === 0 && opening.balance === 0 ? (
          <div className="empty-state">No sessions recorded yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="num">Players covered</th>
                  <th className="num">Games</th>
                  <th className="num">Total collected</th>
                  <th className="num">Funds generated</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((item) =>
                  item.kind === 'withdrawal' ? (
                    <tr key={`w-${item.w.id}`} className="withdrawal-row">
                      <td>
                        {item.w.withdrawn_on}
                        <div className="sub-note">
                          Taken out{item.w.note ? ` — ${item.w.note}` : ''}
                          {' · '}
                          <button className="danger-link" onClick={() => deleteWithdrawal(item.w)}>
                            Remove
                          </button>
                        </div>
                      </td>
                      <td className="num">—</td>
                      <td className="num">—</td>
                      <td className="num">—</td>
                      <td className="num withdrawal-amount">−₱{money(item.w.amount)}</td>
                    </tr>
                  ) : (
                    <tr key={item.r.id}>
                      <td>
                        <Link to={`/session/${item.r.session_date}`}>{item.r.session_date}</Link>
                        {item.r.label?.trim() && <div className="sub-note">{item.r.label}</div>}
                      </td>
                      <td className="num">
                        {(item.r.payment_groups || []).reduce((n, g) => n + g.headcount, 0)}
                      </td>
                      <td className="num">
                        {gamesPlayed(item.r) > 0 ? (
                          <Link to={`/queue/${item.r.session_date}`}>{gamesPlayed(item.r)}</Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="num">₱{money(item.r.totals.totalCollected)}</td>
                      <td className="num">₱{money(item.r.totals.totalFunds)}</td>
                    </tr>
                  )
                )}
                {opening.balance !== 0 && (
                  <tr>
                    <td>
                      Carried forward
                      {opening.asOf && <div className="sub-note">as of {opening.asOf}</div>}
                    </td>
                    <td className="num">—</td>
                    <td className="num">—</td>
                    <td className="num">—</td>
                    <td className="num">₱{money(opening.balance)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
