import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { RANKS } from '../lib/queue'

export default function Players() {
  const [players, setPlayers] = useState([])
  const [groups, setGroups] = useState([])
  const [name, setName] = useState('')
  const [status, setStatus] = useState('regular')
  const [rank, setRank] = useState('beginner')
  const [groupId, setGroupId] = useState('')
  const [newGroup, setNewGroup] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const [{ data: playersData }, { data: groupsData }] = await Promise.all([
      supabase.from('players').select('*').order('name', { ascending: true }),
      supabase.from('player_groups').select('*').order('name', { ascending: true }),
    ])
    setPlayers(playersData || [])
    setGroups(groupsData || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // Regulars first, guests last; alphabetical within each.
  const byStatusThenName = (a, b) => {
    const rank = (p) => (p.status === 'guest' ? 1 : 0)
    return rank(a) - rank(b) || a.name.localeCompare(b.name)
  }

  const sections = useMemo(() => {
    const byGroup = new Map(groups.map((g) => [g.id, []]))
    const none = []
    for (const p of players) {
      if (p.group_id && byGroup.has(p.group_id)) byGroup.get(p.group_id).push(p)
      else none.push(p)
    }
    const out = groups.map((g) => ({
      id: g.id,
      name: g.name,
      players: (byGroup.get(g.id) || []).sort(byStatusThenName),
    }))
    out.push({ id: null, name: 'No group', players: none.sort(byStatusThenName) })
    return out
  }, [players, groups])

  async function addPlayer(e) {
    e.preventDefault()
    if (!name.trim()) return
    const { error } = await supabase
      .from('players')
      .insert({ name: name.trim(), status, rank, group_id: groupId || null })
    if (!error) {
      setName('')
      setStatus('regular')
      setRank('beginner')
      setGroupId('')
      load()
    } else {
      alert(error.message)
    }
  }

  async function addGroup(e) {
    e.preventDefault()
    if (!newGroup.trim()) return
    const { error } = await supabase.from('player_groups').insert({ name: newGroup.trim() })
    if (!error) {
      setNewGroup('')
      load()
    } else {
      alert(error.message)
    }
  }

  async function renameGroup(g) {
    const next = window.prompt(`Rename "${g.name}" to:`, g.name)
    if (next == null) return
    const trimmed = next.trim()
    if (!trimmed || trimmed === g.name) return
    const { error } = await supabase.from('player_groups').update({ name: trimmed }).eq('id', g.id)
    if (error) alert(error.message)
    else load()
  }

  async function deleteGroup(g) {
    if (!window.confirm(`Delete group "${g.name}"? Players in it become ungrouped.`)) return
    await supabase.from('player_groups').delete().eq('id', g.id)
    load()
  }

  async function setPlayerGroup(player, value) {
    const group_id = value || null
    setPlayers((prev) => prev.map((p) => (p.id === player.id ? { ...p, group_id } : p)))
    await supabase.from('players').update({ group_id }).eq('id', player.id)
  }

  async function setPlayerRank(player, value) {
    setPlayers((prev) => prev.map((p) => (p.id === player.id ? { ...p, rank: value } : p)))
    const { error } = await supabase.from('players').update({ rank: value }).eq('id', player.id)
    if (error) alert(error.message)
  }

  async function toggleStatus(player) {
    const newStatus = player.status === 'regular' ? 'guest' : 'regular'
    await supabase.from('players').update({ status: newStatus }).eq('id', player.id)
    load()
  }

  async function toggleActive(player) {
    await supabase.from('players').update({ active: !player.active }).eq('id', player.id)
    load()
  }

  return (
    <div>
      <div className="panel">
        <h2>Add a player</h2>
        <form onSubmit={addPlayer}>
          <div className="field-row">
            <div className="field" style={{ flex: 2 }}>
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Carl" />
            </div>
            <div className="field">
              <label>Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="regular">Regular</option>
                <option value="guest">Guest</option>
              </select>
            </div>
            <div className="field">
              <label>Rank</label>
              <select value={rank} onChange={(e) => setRank(e.target.value)}>
                {RANKS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Group</label>
              <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">— No group —</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          </div>
          <button className="primary" type="submit">Add player</button>
        </form>
      </div>

      <div className="panel">
        <h2>Groups</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Put couples or families in a group. In a session, everyone in the same group shows as one
          combined line on the bill instead of a separate charge each.
        </p>
        <form onSubmit={addGroup} className="field-row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 2 }}>
            <label>New group name</label>
            <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="e.g. Mon/Wed crew" />
          </div>
          <div className="field">
            <button className="primary" type="submit">Add group</button>
          </div>
        </form>

        {groups.length === 0 ? (
          <div className="empty-state" style={{ padding: '20px' }}>
            No groups yet. Add one above, then assign players in the roster.
          </div>
        ) : (
          <div className="group-chips">
            {groups.map((g) => {
              const count = players.filter((p) => p.group_id === g.id).length
              return (
                <span className="group-chip" key={g.id}>
                  <span className="group-chip-name">{g.name}</span>
                  <span className="group-chip-count">{count}</span>
                  <button className="danger-link" onClick={() => renameGroup(g)}>Rename</button>
                  <button className="danger-link" onClick={() => deleteGroup(g)}>Delete</button>
                </span>
              )
            })}
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Roster</h2>
        {loading ? (
          <p>Loading…</p>
        ) : players.length === 0 ? (
          <div className="empty-state">No players yet — add your first one above.</div>
        ) : (
          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Group</th>
                  <th>Rank</th>
                  <th>Status</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              {sections.map((section) =>
                section.players.length === 0 ? null : (
                  <tbody key={section.id ?? 'none'}>
                    <tr className="group-head">
                      <td colSpan={6}>
                        {section.name}
                        <span className="group-head-count"> · {section.players.length}</span>
                      </td>
                    </tr>
                    {section.players.map((p) => (
                      <tr key={p.id} className={p.status === 'guest' ? 'row-guest' : ''}>
                        <td>{p.name}</td>
                        <td>
                          <select
                            className="inline-select"
                            value={p.group_id || ''}
                            onChange={(e) => setPlayerGroup(p, e.target.value)}
                          >
                            <option value="">— No group —</option>
                            {groups.map((g) => (
                              <option key={g.id} value={g.id}>{g.name}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            className="inline-select"
                            value={p.rank || 'beginner'}
                            onChange={(e) => setPlayerRank(p, e.target.value)}
                            aria-label={`${p.name}'s rank`}
                          >
                            {RANKS.map((r) => (
                              <option key={r.value} value={r.value}>{r.label}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <span className={`badge ${p.status === 'regular' ? 'badge-regular' : 'badge-guest'}`}>
                            {p.status === 'regular' ? 'Regular' : 'Guest'}
                          </span>
                        </td>
                        <td>{p.active ? 'Yes' : 'No'}</td>
                        <td>
                          <div className="row-actions">
                            <button className="danger-link" onClick={() => toggleStatus(p)}>
                              Switch to {p.status === 'regular' ? 'Guest' : 'Regular'}
                            </button>
                            <button className="danger-link" onClick={() => toggleActive(p)}>
                              {p.active ? 'Deactivate' : 'Reactivate'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                )
              )}
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
