// Queue master logic: who plays next, how teams split, and whether a score
// is a legal final. Pure functions — no Supabase, no React — so they are easy
// to reason about and test.
//
// Shapes used throughout:
//   entry  = a queue_entries row: { id, display_name, rank, state,
//            available_since, resting_until }
//   match  = { id, status, court_no, teamA: [entryId, entryId],
//             teamB: [entryId, entryId], winner, team_a_score, team_b_score }
//            (build it from matches + match_players with toMatch())

// ─────────────────────────────────────────────
// Ranks
// ─────────────────────────────────────────────

export const RANKS = [
  { value: 'newbie', label: 'Newbie', points: 1 },
  { value: 'beginner', label: 'Beginner', points: 2 },
  { value: 'intermediate', label: 'Intermediate', points: 3 },
  { value: 'advanced', label: 'Advanced', points: 4 },
]

const RANK_POINTS = Object.fromEntries(RANKS.map((r) => [r.value, r.points]))

/** Numeric strength of a rank; unknown ranks count as Beginner. */
export function rankPoints(rank) {
  return RANK_POINTS[rank] ?? 2
}

export function rankLabel(rank) {
  return RANKS.find((r) => r.value === rank)?.label ?? 'Beginner'
}

// ─────────────────────────────────────────────
// Scoring: first to 31, win by 2 from 30-all, capped at 35
// ─────────────────────────────────────────────

export const SCORING = { target: 31, winBy: 2, cap: 35 }

/**
 * Check a final score.
 * @returns {{ valid: boolean, winner: 'a'|'b'|null, message: string|null }}
 *   `winner` is the side ahead even when the score isn't a legal final, so the
 *   UI can pre-select it and just show `message` as a warning.
 */
export function checkScore(a, b, rules = SCORING) {
  const sa = Number(a)
  const sb = Number(b)
  if (!Number.isInteger(sa) || !Number.isInteger(sb) || sa < 0 || sb < 0) {
    return { valid: false, winner: null, message: 'Enter both scores.' }
  }
  if (sa === sb) {
    return { valid: false, winner: null, message: 'Scores are tied: pick the winner.' }
  }
  const winner = sa > sb ? 'a' : 'b'
  const hi = Math.max(sa, sb)
  const lo = Math.min(sa, sb)
  const { target, winBy, cap } = rules

  if (hi > cap) return { valid: false, winner, message: `Max score is ${cap}.` }
  if (hi < target) return { valid: false, winner, message: `Game not finished: ${target} to win.` }
  if (hi === cap) {
    // At the cap the next point wins, whatever the gap (35-34).
    if (lo >= cap - winBy) return { valid: true, winner, message: null }
    return { valid: false, winner, message: `${hi}-${lo} isn't possible: the game ends at ${target}.` }
  }
  if (hi === target) {
    if (lo <= target - winBy) return { valid: true, winner, message: null }
    return { valid: false, winner, message: `From ${target - 1}-all, play on until someone is ${winBy} ahead.` }
  }
  // Between target and cap: only reachable through deuce, so exactly winBy ahead.
  if (hi - lo === winBy) return { valid: true, winner, message: null }
  if (hi - lo < winBy) return { valid: false, winner, message: `Need a ${winBy}-point lead to win.` }
  return { valid: false, winner, message: `${hi}-${lo} isn't possible: the game ends at ${target}.` }
}

// ─────────────────────────────────────────────
// Matches and history
// ─────────────────────────────────────────────

/** Turn a matches row plus its match_players rows into { ...match, teamA, teamB }. */
export function toMatch(row, matchPlayers) {
  const mine = (matchPlayers || []).filter((mp) => mp.match_id === row.id)
  return {
    ...row,
    teamA: mine.filter((mp) => mp.team === 'a').map((mp) => mp.entry_id),
    teamB: mine.filter((mp) => mp.team === 'b').map((mp) => mp.entry_id),
  }
}

const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`)

/**
 * Who has partnered or faced whom tonight, and how many games each has
 * played. Voided matches don't count; in-progress ones do (the pairing has
 * already happened).
 */
export function buildHistory(matches) {
  const partners = new Map()
  const opponents = new Map()
  const games = new Map()
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1)

  for (const m of matches || []) {
    if (m.status === 'void') continue
    for (const team of [m.teamA, m.teamB]) {
      for (const id of team) bump(games, id)
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) bump(partners, pairKey(team[i], team[j]))
      }
    }
    for (const x of m.teamA) for (const y of m.teamB) bump(opponents, pairKey(x, y))
  }

  return {
    partners,
    opponents,
    games,
    partnerCount: (x, y) => partners.get(pairKey(x, y)) || 0,
    opponentCount: (x, y) => opponents.get(pairKey(x, y)) || 0,
    gamesPlayed: (id) => games.get(id) || 0,
  }
}

/** Entry ids currently on a court. */
export function busyEntryIds(matches) {
  const ids = new Set()
  for (const m of matches || []) {
    if (m.status !== 'in_progress') continue
    for (const id of [...m.teamA, ...m.teamB]) ids.add(id)
  }
  return ids
}

/** Court numbers 1..courtCount with no game in progress. */
export function freeCourts(courtCount, matches) {
  const used = new Set((matches || []).filter((m) => m.status === 'in_progress').map((m) => m.court_no))
  const free = []
  for (let c = 1; c <= courtCount; c++) if (!used.has(c)) free.push(c)
  return free
}

// ─────────────────────────────────────────────
// The queue
// ─────────────────────────────────────────────

const toMs = (t) => (t == null ? null : t instanceof Date ? t.getTime() : new Date(t).getTime())

/**
 * Everyone who could go on court right now, longest wait first.
 * - waiting players who aren't on a court
 * - resting players whose resting_until has passed (their wait starts then)
 * Each result is the entry plus `waitingSince` (ms).
 */
export function queueOrder(entries, matches, now = Date.now()) {
  const nowMs = toMs(now)
  const busy = busyEntryIds(matches)
  const history = buildHistory(matches)
  const ready = []

  for (const e of entries || []) {
    if (busy.has(e.id)) continue
    let since = toMs(e.available_since) ?? nowMs
    if (e.state === 'resting') {
      const until = toMs(e.resting_until)
      if (until == null || until > nowMs) continue
      since = Math.max(since, until)
    } else if (e.state !== 'waiting') {
      continue
    }
    ready.push({ ...e, waitingSince: since })
  }

  return ready.sort(
    (x, y) =>
      x.waitingSince - y.waitingSince ||
      history.gamesPlayed(x.id) - history.gamesPlayed(y.id) ||
      String(x.display_name).localeCompare(String(y.display_name))
  )
}

/**
 * Penalty weights for choosing the next match. Lower total wins.
 * Repeats cost more each time: a pair's 2nd repeat costs 2x, the 3rd 3x...
 */
export const DEFAULT_WEIGHTS = {
  partnerRepeat: 60, // per repeat of a teammate pairing
  opponentRepeat: 20, // per repeat of an opponent pairing
  rankGap: 15, // per point of difference between the two teams' rank totals
  skipPerMinute: 3, // per minute waited, for each player in the pool left out
}

// Escalating cost for a pairing already seen `count` times: 1, 3, 6, 10...
const repeatCost = (count) => (count * (count + 1)) / 2

// The 3 ways to split 4 players into two teams of 2.
const SPLITS = [
  [[0, 1], [2, 3]],
  [[0, 2], [1, 3]],
  [[0, 3], [1, 2]],
]

/**
 * Pick the next 4 players and how to split them.
 *
 * Considers the `poolSize` longest-waiting players. The longest-waiting player
 * always plays, so nobody gets stuck; the other 3 and the team split are
 * chosen to avoid repeat teammates and opponents and to balance ranks, at the
 * cost of passing over people who have waited a while.
 *
 * @param {object} opts
 * @param {Array} opts.entries - all queue_entries for the session
 * @param {Array} opts.matches - every match tonight, from toMatch()
 * @param {number|Date} [opts.now]
 * @param {object} [opts.weights] - overrides for DEFAULT_WEIGHTS
 * @param {number} [opts.poolSize=8]
 * @param {Array<string>} [opts.exclude] - entry ids already promised elsewhere
 *   (e.g. picked for another free court in the same refresh)
 * @returns {null | { teamA: entry[], teamB: entry[], cost: number, notes: string[] }}
 */
export function pickNextMatch({ entries, matches, now = Date.now(), weights, poolSize = 8, exclude = [] }) {
  const w = { ...DEFAULT_WEIGHTS, ...weights }
  const skip = new Set(exclude)
  const order = queueOrder(entries, matches, now).filter((e) => !skip.has(e.id))
  if (order.length < 4) return null

  const pool = order.slice(0, Math.max(4, poolSize))
  const history = buildHistory(matches)
  const nowMs = toMs(now)
  const waitedMin = (e) => Math.max(0, (nowMs - e.waitingSince) / 60000)

  const [anchor, ...rest] = pool
  let best = null

  for (let i = 0; i < rest.length; i++) {
    for (let j = i + 1; j < rest.length; j++) {
      for (let k = j + 1; k < rest.length; k++) {
        const four = [anchor, rest[i], rest[j], rest[k]]
        const chosen = new Set(four.map((e) => e.id))
        const skipCost = pool
          .filter((e) => !chosen.has(e.id))
          .reduce((sum, e) => sum + w.skipPerMinute * waitedMin(e), 0)

        for (const [ia, ib] of SPLITS) {
          const teamA = ia.map((n) => four[n])
          const teamB = ib.map((n) => four[n])
          const cost = skipCost + splitCost(teamA, teamB, history, w)
          if (!best || cost < best.cost) best = { teamA, teamB, cost }
        }
      }
    }
  }

  return { ...best, notes: describeMatch(best.teamA, best.teamB, history) }
}

/** Cost of one team split, ignoring who was passed over. */
function splitCost(teamA, teamB, history, w) {
  let cost = 0
  for (const team of [teamA, teamB]) {
    cost += w.partnerRepeat * repeatCost(history.partnerCount(team[0].id, team[1].id))
  }
  for (const x of teamA) {
    for (const y of teamB) cost += w.opponentRepeat * repeatCost(history.opponentCount(x.id, y.id))
  }
  cost += w.rankGap * Math.abs(teamRank(teamA) - teamRank(teamB))
  return cost
}

export const teamRank = (team) => team.reduce((sum, e) => sum + rankPoints(e.rank), 0)

/**
 * Plain-language notes on a proposed match, e.g.
 *   "All new pairings", "Ana & Ben partnered 1x before", "Ranks 5 v 5"
 */
export function describeMatch(teamA, teamB, history) {
  const notes = []
  const name = (e) => e.display_name
  for (const team of [teamA, teamB]) {
    const n = history.partnerCount(team[0].id, team[1].id)
    if (n) notes.push(`${name(team[0])} & ${name(team[1])} partnered ${n}x before`)
  }
  for (const x of teamA) {
    for (const y of teamB) {
      const n = history.opponentCount(x.id, y.id)
      if (n) notes.push(`${name(x)} vs ${name(y)} ${n}x before`)
    }
  }
  if (!notes.length) notes.push('All new pairings')
  notes.push(`Ranks ${teamRank(teamA)} v ${teamRank(teamB)}`)
  return notes
}

// ─────────────────────────────────────────────
// Night summary
// ─────────────────────────────────────────────

/**
 * Per-player record for the night, from finished games only.
 * @returns {{
 *   players: Array<{ entry, games, wins, losses, pointsFor, pointsAgainst,
 *                    partners: Array<{ entry, count }>, opponents: Array<{ entry, count }> }>,
 *   games: number,
 *   pairings: { distinct: number, repeats: number },
 * }}
 *   players are sorted by wins, then win rate, then name. Partner and
 *   opponent lists are sorted most-often first.
 */
export function nightSummary(matches, entries) {
  const done = (matches || []).filter((m) => m.status === 'done')
  const byId = new Map((entries || []).map((e) => [e.id, e]))
  const rows = new Map()
  const row = (id) => {
    if (!rows.has(id)) {
      rows.set(id, {
        entry: byId.get(id) ?? { id, display_name: '?' },
        games: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0,
        partners: new Map(), opponents: new Map(),
      })
    }
    return rows.get(id)
  }
  const bump = (map, id) => map.set(id, (map.get(id) || 0) + 1)

  for (const m of done) {
    for (const [side, team, other, mine, theirs] of [
      ['a', m.teamA, m.teamB, m.team_a_score, m.team_b_score],
      ['b', m.teamB, m.teamA, m.team_b_score, m.team_a_score],
    ]) {
      for (const id of team) {
        const r = row(id)
        r.games++
        if (m.winner === side) r.wins++
        else if (m.winner) r.losses++
        r.pointsFor += Number(mine) || 0
        r.pointsAgainst += Number(theirs) || 0
        for (const p of team) if (p !== id) bump(r.partners, p)
        for (const o of other) bump(r.opponents, o)
      }
    }
  }

  const list = (map) =>
    [...map.entries()]
      .map(([id, count]) => ({ entry: byId.get(id) ?? { id, display_name: '?' }, count }))
      .sort((x, y) => y.count - x.count || String(x.entry.display_name).localeCompare(String(y.entry.display_name)))

  const players = [...rows.values()]
    .map((r) => ({ ...r, partners: list(r.partners), opponents: list(r.opponents) }))
    .sort(
      (x, y) =>
        y.wins - x.wins ||
        y.wins / (y.games || 1) - x.wins / (x.games || 1) ||
        String(x.entry.display_name).localeCompare(String(y.entry.display_name))
    )

  const history = buildHistory(done)
  const counts = [...history.partners.values()]
  return {
    players,
    games: done.length,
    pairings: {
      distinct: counts.length,
      repeats: counts.reduce((sum, c) => sum + c - 1, 0),
    },
  }
}

/**
 * Fill every free court at once. Each court takes the best match from whoever
 * the earlier courts left over.
 * @returns {Array<{ court_no, teamA, teamB, cost, notes }>}
 */
export function fillCourts({ courtCount, entries, matches, now = Date.now(), weights, poolSize }) {
  const picks = []
  const taken = []
  for (const court_no of freeCourts(courtCount, matches)) {
    const pick = pickNextMatch({ entries, matches, now, weights, poolSize, exclude: taken })
    if (!pick) break
    picks.push({ court_no, ...pick })
    taken.push(...pick.teamA.map((e) => e.id), ...pick.teamB.map((e) => e.id))
  }
  return picks
}
