import { useEffect, useState } from 'react'
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom'
import { supabase } from './lib/supabaseClient'
import Login from './pages/Login'
import Players from './pages/Players'
import SessionPage from './pages/SessionPage'
import History from './pages/History'
import QueuePage from './pages/QueuePage'

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = loading
  const { pathname } = useLocation()
  // "/" is today; "/session/<date>" is any other day — both belong to this tab
  const onSessionTab = pathname === '/' || pathname.startsWith('/session/')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  if (session === undefined) {
    return <div className="app-shell">Loading…</div>
  }

  if (!session) {
    return <Login />
  }

  return (
    <div className="app-shell">
      <header className="court-header">
        <div>
          <h1>Court Split</h1>
          <div className="tagline">Court fees, sorted — every Friday.</div>
        </div>
        <button className="ghost" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </header>

      <nav className="tabs">
        <NavLink to="/" end className={onSessionTab ? 'active' : ''}>
          Session
        </NavLink>
        <NavLink to="/queue" className={({ isActive }) => (isActive ? 'active' : '')}>
          Queue
        </NavLink>
        <NavLink to="/players" className={({ isActive }) => (isActive ? 'active' : '')}>
          Players
        </NavLink>
        <NavLink to="/history" className={({ isActive }) => (isActive ? 'active' : '')}>
          History
        </NavLink>
      </nav>

      <Routes>
        <Route path="/" element={<SessionPage />} />
        <Route path="/session/:date" element={<SessionPage />} />
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/queue/:date" element={<QueuePage />} />
        <Route path="/players" element={<Players />} />
        <Route path="/history" element={<History />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}
