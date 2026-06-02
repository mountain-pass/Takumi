import React, { useState, useRef, useEffect } from 'react'
import { Bell, BellDot, X, AlertCircle, Info, CheckCircle, ChevronRight } from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'
import { useAgentTasks } from '../hooks/useApi'

// ── Agent status pill ─────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  working:  { color: 'bg-green-500',  pulse: true,  label: 'Working' },
  thinking: { color: 'bg-blue-500',   pulse: true,  label: 'Thinking' },
  idle:     { color: 'bg-gray-400',   pulse: false, label: 'Idle' },
  error:    { color: 'bg-red-500',    pulse: false, label: 'Error' },
  offline:  { color: 'bg-red-500',    pulse: false, label: 'Offline' },
}

function StatusDot({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.idle
  return (
    <span className="relative flex items-center justify-center w-2.5 h-2.5">
      {cfg.pulse && (
        <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${cfg.color} opacity-60`} />
      )}
      <span className={`relative inline-flex rounded-full h-2 w-2 ${cfg.color}`} />
    </span>
  )
}

function AgentStatusPills({ agents, agentsWithActiveTasks = new Set() }) {
  // Group by effective status (account for active tasks)
  const counts = agents.reduce((acc, a) => {
    let s = a.status || 'idle'
    // If agent has active tasks but status is idle, show as working
    if (s === 'idle' && agentsWithActiveTasks.has(a.config?.id)) {
      s = 'working'
    }
    acc[s] = (acc[s] || 0) + 1
    return acc
  }, {})

  if (agents.length === 0) return null

  const order = ['working', 'thinking', 'idle', 'error', 'offline']

  return (
    <div className="flex items-center gap-2">
      {order.filter(s => counts[s]).map(s => (
        <div key={s} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-100 text-xs font-medium text-gray-600">
          <StatusDot status={s} />
          <span>{counts[s]} {STATUS_CONFIG[s].label}</span>
        </div>
      ))}
    </div>
  )
}

// ── Notification bell ─────────────────────────────────────────────────────────

const NOTIF_ICONS = {
  alert:   { icon: AlertCircle, color: 'text-red-500',    bg: 'bg-red-50' },
  info:    { icon: Info,        color: 'text-blue-500',   bg: 'bg-blue-50' },
  success: { icon: CheckCircle, color: 'text-green-500',  bg: 'bg-green-50' },
}

function NotificationPanel({ notifications, onDismiss, onClear }) {
  if (notifications.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-gray-400 gap-2">
        <Bell size={28} strokeWidth={1.5} />
        <p className="text-sm">No notifications</p>
      </div>
    )
  }

  return (
    <div className="divide-y divide-gray-100">
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Notifications</span>
        <button onClick={onClear} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">Clear all</button>
      </div>
      {notifications.map(n => {
        const cfg = NOTIF_ICONS[n.type] || NOTIF_ICONS.info
        const Icon = cfg.icon
        return (
          <div key={n.id} className={`flex gap-3 px-4 py-3 ${cfg.bg} hover:brightness-95 transition-all`}>
            <Icon size={16} className={`${cfg.color} shrink-0 mt-0.5`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800">{n.title}</p>
              {n.body && <p className="text-xs text-gray-500 mt-0.5">{n.body}</p>}
              {n.action && (
                <button className="mt-1.5 flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800">
                  {n.action} <ChevronRight size={11} />
                </button>
              )}
              <p className="text-[10px] text-gray-400 mt-1">{n.time}</p>
            </div>
            <button onClick={() => onDismiss(n.id)} className="text-gray-300 hover:text-gray-500 shrink-0">
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ── Top bar ───────────────────────────────────────────────────────────────────

export default function TopBar() {
  const agents = useOrgStore(s => s.agents)
  const { data: allTasks = [] } = useAgentTasks()
  const agentsWithActiveTasks = new Set(
    allTasks.filter(t => t.status === 'in_progress' || t.status === 'pending').map(t => t.agent_id)
  )
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState([
    {
      id: '1',
      type: 'alert',
      title: 'Action required: Review agent response',
      body: 'The CEO agent is waiting for your approval before proceeding.',
      action: 'Review now',
      time: 'Just now',
    },
    {
      id: '2',
      type: 'info',
      title: 'New skill available',
      body: 'Web Search skill has been added to the marketplace.',
      action: 'View skill',
      time: '5 min ago',
    },
  ])
  const ref = useRef(null)

  const unread = notifications.length

  // Close dropdown on outside click
  useEffect(() => {
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  function dismiss(id) {
    setNotifications(prev => prev.filter(n => n.id !== id))
  }

  return (
    <header className="h-12 bg-white border-b border-gray-100 flex items-center justify-between px-4 shrink-0 z-20">

      {/* Right side */}
      <div className="flex items-center gap-3 ml-auto" ref={ref}>
      <AgentStatusPills agents={agents} agentsWithActiveTasks={agentsWithActiveTasks} />

        {/* Notification bell */}
        <div className="relative">
          <button
            onClick={() => setOpen(o => !o)}
            className="relative w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors"
          >
            {unread > 0 ? <BellDot size={18} className="text-gray-600" /> : <Bell size={18} className="text-gray-400" />}
            {unread > 0 && (
              <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
            )}
          </button>

          {open && (
            <div className="absolute right-0 top-10 w-80 bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden z-50">
              <NotificationPanel
                notifications={notifications}
                onDismiss={dismiss}
                onClear={() => setNotifications([])}
              />
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
