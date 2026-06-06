/**
 * App — main layout with structured sidebar navigation.
 */
import React, { useEffect, useState } from 'react'
import {
  MessageSquare,
  CalendarClock,
  Plug,
  GitBranch,
  Building2,
  KeyRound,
  Radio,
  Network,
  Wifi,
  WifiOff,
  Settings,
  Trash2,
} from 'lucide-react'
import { useOrgStore } from './stores/orgStore'
import SetupWizard from './components/SetupWizard'
// AgentDetailPanel removed — agent details now shown in Office right pane
import TopBar from './components/TopBar'

// Views
import ChatView from './components/ChatView'
import CronJobView from './components/CronJobView'
import SkillMarketplaceView from './components/SkillMarketplaceView'
import WorkflowView from './components/WorkflowView'
import OfficeView from './components/OfficeView'
import APISettingsView from './components/APISettingsView'
import SystemSettingsView from './components/SystemSettingsView'
import ChannelView from './components/ChannelView'
import OrganisationView from './components/OrganisationView'

// ── Nav structure ─────────────────────────────────────────────────────────────

const PRIMARY_NAV = [
  { id: 'chat',        icon: MessageSquare, label: 'Chat' },
  { id: 'cron',        icon: CalendarClock, label: 'Scheduled Jobs' },
  { id: 'skills',      icon: Plug,          label: 'MCP Servers' },
  { id: 'workflows',   icon: GitBranch,     label: 'Workflows' },
]

const OBSERVER_NAV = [
  { id: 'office', icon: Building2, label: 'Office' },
]

const SETTINGS_NAV = [
  { id: 'api',          icon: KeyRound,  label: 'API' },
  { id: 'channels',     icon: Radio,     label: 'Channels' },
  { id: 'organisation', icon: Network,   label: 'Organisation' },
  { id: 'settings',     icon: Settings,  label: 'Settings' },
]

const VIEW_MAP = {
  chat:         <ChatView />,
  cron:         <CronJobView />,
  skills:       <SkillMarketplaceView />,
  workflows:    <WorkflowView />,
  office:       <OfficeView />,
  api:          <APISettingsView />,
  settings:     <SystemSettingsView />,
  channels:     <ChannelView />,
  organisation: <OrganisationView />,
}

// ── Nav item ──────────────────────────────────────────────────────────────────

function NavItem({ item, active, onClick }) {
  const Icon = item.icon
  return (
    <button
      onClick={() => onClick(item.id)}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all text-left
        ${active
          ? 'bg-indigo-50 text-indigo-600'
          : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
        }`}
    >
      <Icon size={16} className="shrink-0" />
      <span className="truncate">{item.label}</span>
    </button>
  )
}

function NavSection({ label, children }) {
  return (
    <div className="mt-4">
      <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-400">{label}</p>
      {children}
    </div>
  )
}

function ChatHistory({ active }) {
  const conversations = useOrgStore(s => s.chatConversations)
  const activeConvId = useOrgStore(s => s.activeConvId)
  const loadChatConversations = useOrgStore(s => s.loadChatConversations)
  const openConversation = useOrgStore(s => s.openConversation)

  useEffect(() => { loadChatConversations() }, [])

  const newChat = useOrgStore(s => s.newChat)

  async function remove(id, e) {
    e.stopPropagation()
    try { await fetch(`/api/conversations/${id}`, { method: 'DELETE' }) } catch {}
    // If the deleted conversation is the one on screen, clear it.
    if (activeConvId === id) newChat()
    loadChatConversations()
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col mt-4">
      <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-400">History</p>
      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {conversations.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-gray-400">No conversations yet</p>
        ) : conversations.map(conv => (
          <div key={conv.id}
            onClick={() => openConversation(conv.id)}
            className={`group flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer transition-colors ${
              active === 'chat' && activeConvId === conv.id
                ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
            }`}>
            <MessageSquare size={13} className="shrink-0 opacity-50" />
            <span className="flex-1 truncate text-xs">{conv.title}</span>
            <button onClick={e => remove(conv.id, e)}
              className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-500 transition-all">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const connect = useOrgStore(s => s.connect)
  const connected = useOrgStore(s => s.connected)
  const fetchOrg = useOrgStore(s => s.fetchOrg)
  const setupDone = useOrgStore(s => s.setupDone)
  const orgName = useOrgStore(s => s.orgName)
  const pendingNav = useOrgStore(s => s.pendingNav)
  const clearNav = useOrgStore(s => s.clearNav)
  const newChat = useOrgStore(s => s.newChat)

  const [tab, setTab] = useState('chat')

  // Clicking "Chat" always opens a fresh chat (no stale conversation bleeding in).
  function handleNav(id) {
    if (id === 'chat') newChat()
    else setTab(id)
  }

  const fetchAgents = useOrgStore(s => s.fetchAgents)

  useEffect(() => {
    fetchOrg()
    connect()
    // Poll agent status as a fallback so the top-bar status self-heals even if a
    // WebSocket heartbeat is missed (e.g. after a reconnect).
    const id = setInterval(() => fetchAgents(), 8000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (pendingNav) {
      setTab(pendingNav)
      clearNav()
    }
  }, [pendingNav])

  if (setupDone === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!setupDone) return <SetupWizard />

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">

      {/* ── Sidebar ── */}
      <aside className="w-52 bg-white border-r border-gray-100 flex flex-col py-4 shadow-sm z-10 shrink-0">

        {/* Logo + org name */}
        <div className="flex items-center gap-2.5 px-3 mb-5">
          <img src="/Takumi_no_text.png" alt="Takumi" className="w-20 h-20 object-contain shrink-0" />
          <span className="text-sm font-semibold text-gray-800 truncate">{orgName || 'Takumi'}</span>
        </div>

        {/* Primary nav */}
        <div className="px-2 space-y-0.5">
          {PRIMARY_NAV.map(item => (
            <NavItem key={item.id} item={item} active={tab === item.id} onClick={handleNav} />
          ))}
        </div>

        {/* Observer section */}
        <NavSection label="Observer">
          <div className="px-2 space-y-0.5">
            {OBSERVER_NAV.map(item => (
              <NavItem key={item.id} item={item} active={tab === item.id} onClick={setTab} />
            ))}
          </div>
        </NavSection>

        {/* Settings section */}
        <NavSection label="Settings">
          <div className="px-2 space-y-0.5">
            {SETTINGS_NAV.map(item => (
              <NavItem key={item.id} item={item} active={tab === item.id} onClick={setTab} />
            ))}
          </div>
        </NavSection>

        {/* Chat history */}
        <ChatHistory active={tab} />

        {/* Connection status */}
        <div className="px-2 space-y-2">
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium
            ${connected ? 'text-green-600 bg-green-50' : 'text-red-500 bg-red-50'}`}>
            {connected
              ? <><Wifi size={13} className="shrink-0" /> Connected</>
              : <><WifiOff size={13} className="shrink-0 animate-pulse" /> Reconnecting…</>
            }
          </div>
        </div>
      </aside>

      {/* ── Main content ── */}
      <div className={`flex-1 flex flex-col overflow-hidden transition-all`}>
        <TopBar />
        <main className="flex-1 overflow-hidden">
          {VIEW_MAP[tab]}
        </main>
      </div>


    </div>
  )
}
