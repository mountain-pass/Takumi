import React, { useState, useRef, useEffect } from 'react'
import { Bell, BellDot, X, AlertCircle, Info, CheckCircle, ChevronRight } from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'

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

function AgentStatusPills({ agents }) {
  // Use each agent's actual status (kept accurate by the 5s heartbeat). We do NOT
  // infer "working" from open tasks — a single stale task would otherwise pin an
  // idle agent as busy forever.
  const counts = agents.reduce((acc, a) => {
    const s = a.status || 'idle'
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

function timeAgo(iso) {
  if (!iso) return ''
  // created_at is stored as UTC "YYYY-MM-DD HH:MM:SS" (no tz) — parse as UTC.
  const t = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return ''
  const secs = Math.max(0, (Date.now() - t) / 1000)
  if (secs < 45) return 'Just now'
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`
  return `${Math.round(secs / 86400)} d ago`
}

function NotificationPanel({ notifications, onOpen, onDismiss, onClear }) {
  if (notifications.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-gray-400 gap-2">
        <Bell size={28} strokeWidth={1.5} />
        <p className="text-sm">No notifications</p>
      </div>
    )
  }

  return (
    <div className="divide-y divide-gray-100 max-h-[70vh] overflow-y-auto">
      <div className="sticky top-0 bg-white flex items-center justify-between px-4 py-2.5 border-b border-gray-100 z-10">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Notifications</span>
        <button onClick={onClear} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">Clear all</button>
      </div>
      {notifications.map(n => {
        const cfg = NOTIF_ICONS[n.type] || NOTIF_ICONS.info
        const Icon = cfg.icon
        const clickable = !!n.link_view
        return (
          <div key={n.id}
            onClick={clickable ? () => onOpen(n) : undefined}
            className={`flex gap-3 px-4 py-3 ${n.read ? 'bg-white' : cfg.bg} ${clickable ? 'cursor-pointer hover:brightness-95' : ''} transition-all`}>
            {!n.read && <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />}
            <Icon size={16} className={`${cfg.color} shrink-0 mt-0.5 ${n.read ? 'opacity-60' : ''}`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800">{n.title}</p>
              {n.body && <p className="text-xs text-gray-500 mt-0.5 break-words">{n.body}</p>}
              {n.action && clickable && (
                <span className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800">
                  {n.action} <ChevronRight size={11} />
                </span>
              )}
              <p className="text-[10px] text-gray-400 mt-1">{timeAgo(n.created_at)}</p>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onDismiss(n.id) }}
              className="text-gray-300 hover:text-gray-500 shrink-0 self-start">
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
  const notifications = useOrgStore(s => s.notifications)
  const unread = useOrgStore(s => s.notifUnread)
  const openNotification = useOrgStore(s => s.openNotification)
  const dismissNotification = useOrgStore(s => s.dismissNotification)
  const clearNotifications = useOrgStore(s => s.clearNotifications)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const hasItems = notifications.length > 0

  // Close dropdown on outside click
  useEffect(() => {
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  function openNotif(n) {
    setOpen(false)
    openNotification(n)
  }

  return (
    <header className="h-12 bg-white border-b border-gray-100 flex items-center justify-between px-4 shrink-0 z-20">

      {/* Right side */}
      <div className="flex items-center gap-3 ml-auto" ref={ref}>
      <AgentStatusPills agents={agents} />

        {/* Notification bell */}
        <div className="relative">
          <button
            onClick={() => setOpen(o => !o)}
            className="relative w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors"
          >
            {hasItems ? <BellDot size={18} className="text-gray-600" /> : <Bell size={18} className="text-gray-400" />}
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-semibold text-white bg-red-500 rounded-full">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>

          {open && (
            <div className="absolute right-0 top-10 w-80 bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden z-50">
              <NotificationPanel
                notifications={notifications}
                onOpen={openNotif}
                onDismiss={dismissNotification}
                onClear={clearNotifications}
              />
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
