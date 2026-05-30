/**
 * App — main layout with structured sidebar navigation.
 */
import React, { useEffect, useState } from 'react'
import {
  MessageSquare,
  CalendarClock,
  ShoppingBag,
  GitBranch,
  Building2,
  KeyRound,
  Radio,
  Network,
  Wifi,
  WifiOff,
  Plus,
} from 'lucide-react'
import { useOrgStore } from './stores/orgStore'
import SetupWizard from './components/SetupWizard'
import AgentDetailPanel from './components/AgentDetailPanel'
import AgentModal from './components/AgentModal'

// Views
import ChatView from './components/ChatView'
import CronJobView from './components/CronJobView'
import SkillMarketplaceView from './components/SkillMarketplaceView'
import WorkflowView from './components/WorkflowView'
import OfficeView from './components/OfficeView'
import APISettingsView from './components/APISettingsView'
import ChannelView from './components/ChannelView'
import OrganisationView from './components/OrganisationView'

// ── Nav structure ─────────────────────────────────────────────────────────────

const PRIMARY_NAV = [
  { id: 'chat',        icon: MessageSquare, label: 'Chat' },
  { id: 'cron',        icon: CalendarClock, label: 'Cron Jobs' },
  { id: 'skills',      icon: ShoppingBag,   label: 'Skill Marketplace' },
  { id: 'workflows',   icon: GitBranch,     label: 'Workflows' },
]

const OBSERVER_NAV = [
  { id: 'office', icon: Building2, label: 'Office' },
]

const SETTINGS_NAV = [
  { id: 'api',          icon: KeyRound,  label: 'API' },
  { id: 'channels',     icon: Radio,     label: 'Channels' },
  { id: 'organisation', icon: Network,   label: 'Organisation' },
]

const VIEW_MAP = {
  chat:         <ChatView />,
  cron:         <CronJobView />,
  skills:       <SkillMarketplaceView />,
  workflows:    <WorkflowView />,
  office:       <OfficeView />,
  api:          <APISettingsView />,
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

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const connect = useOrgStore(s => s.connect)
  const connected = useOrgStore(s => s.connected)
  const fetchOrg = useOrgStore(s => s.fetchOrg)
  const setupDone = useOrgStore(s => s.setupDone)
  const orgName = useOrgStore(s => s.orgName)
  const selectedAgentId = useOrgStore(s => s.selectedAgentId)

  const [tab, setTab] = useState('chat')
  const [showAddAgent, setShowAddAgent] = useState(false)

  useEffect(() => {
    fetchOrg()
    connect()
  }, [])

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
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-sm shrink-0">
            {orgName ? orgName[0].toUpperCase() : 'T'}
          </div>
          <span className="text-sm font-semibold text-gray-800 truncate">{orgName || 'Takumi'}</span>
        </div>

        {/* Primary nav */}
        <div className="px-2 space-y-0.5">
          {PRIMARY_NAV.map(item => (
            <NavItem key={item.id} item={item} active={tab === item.id} onClick={setTab} />
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

        {/* Spacer */}
        <div className="flex-1" />

        {/* Add agent + connection status */}
        <div className="px-2 space-y-2">
          <button
            onClick={() => setShowAddAgent(true)}
            className="w-full flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus size={15} className="shrink-0" />
            Add Agent
          </button>

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
      <main className={`flex-1 overflow-hidden transition-all ${selectedAgentId ? 'mr-80' : ''}`}>
        {VIEW_MAP[tab]}
      </main>

      {/* Agent detail panel (Office only) */}
      {selectedAgentId && <AgentDetailPanel />}

      {/* Add agent modal */}
      {showAddAgent && <AgentModal onClose={() => setShowAddAgent(false)} />}
    </div>
  )
}
