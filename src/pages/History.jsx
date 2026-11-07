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

export default function History() {
  const [rows, setRows] = useState([])
  const [opening, setOpening] = useState({ balance: 0, asOf: null })
  const [loading, setLoading] = useState(true)

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

      setLoading(false)
    }
    load()
  }, [])

  const generated = rows.reduce((sum, r) => sum + r.totals.totalFunds, 0)
  const accumulated = opening.balance + generated

  if (loading) return <p>Loading history…</p>

  return (
    <div>
      <div className="panel">
        <div className="summary-row">
          <div className="summary-card gold">
            <div className="label">Total accumulated funds (all time)</div>
            <div className="value">₱{money(accumulated)}</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Past sessions</h2>
        {rows.length === 0 && opening.balance === 0 ? (
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
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/session/${r.session_date}`}>{r.session_date}</Link>
                      {r.label?.trim() && <div className="sub-note">{r.label}</div>}
                    </td>
                    <td className="num">
                      {(r.payment_groups || []).reduce((n, g) => n + g.headcount, 0)}
                    </td>
                    <td className="num">
                      {gamesPlayed(r) > 0 ? (
                        <Link to={`/queue/${r.session_date}`}>{gamesPlayed(r)}</Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num">₱{money(r.totals.totalCollected)}</td>
                    <td className="num">₱{money(r.totals.totalFunds)}</td>
                  </tr>
                ))}
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
