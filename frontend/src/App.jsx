/**
 * App — main layout: sidebar nav, office view, right panels.
 */
import React, { useEffect, useState } from 'react'
import { Building2, MessageSquare, ListTodo, Plus, Wifi, WifiOff } from 'lucide-react'
import { useOrgStore } from './stores/orgStore'
import OfficeView from './components/OfficeView'
import MessageFeed from './components/MessageFeed'
import TaskPanel from './components/TaskPanel'
import AgentDetailPanel from './components/AgentDetailPanel'
import AgentModal from './components/AgentModal'
import SetupWizard from './components/SetupWizard'

const NAV = [
  { id: 'office', icon: Building2, label: 'Office' },
  { id: 'messages', icon: MessageSquare, label: 'Messages' },
  { id: 'tasks', icon: ListTodo, label: 'Tasks' },
]

export default function App() {
  const connect = useOrgStore(s => s.connect)
  const connected = useOrgStore(s => s.connected)
  const selectedAgentId = useOrgStore(s => s.selectedAgentId)
  const fetchOrg = useOrgStore(s => s.fetchOrg)
  const setupDone = useOrgStore(s => s.setupDone)
  const orgName = useOrgStore(s => s.orgName)
  const [tab, setTab] = useState('office')
  const [showAddAgent, setShowAddAgent] = useState(false)

  useEffect(() => {
    fetchOrg()
    connect()
  }, [])

  // Loading — waiting for org check
  if (setupDone === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // First run — show wizard
  if (!setupDone) {
    return <SetupWizard />
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Left nav */}
      <nav className="w-16 bg-white border-r border-gray-100 flex flex-col items-center py-4 gap-2 shadow-sm z-10">
        {/* Logo */}
        <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-bold text-lg mb-4"
          title={orgName || 'Takumi'}>
          {orgName ? orgName[0].toUpperCase() : 'T'}
        </div>

        {NAV.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            title={label}
            className={`
              w-10 h-10 rounded-xl flex items-center justify-center transition-all
              ${tab === id ? 'bg-indigo-100 text-indigo-600' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}
            `}
          >
            <Icon size={18} />
          </button>
        ))}

        <div className="flex-1" />

        {/* Add agent button */}
        <button
          onClick={() => setShowAddAgent(true)}
          title="Add Agent"
          className="w-10 h-10 rounded-xl flex items-center justify-center bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
        >
          <Plus size={18} />
        </button>

        {/* Connection status */}
        <div title={connected ? 'Connected' : 'Reconnecting...'} className="mt-2">
          {connected
            ? <Wifi size={16} className="text-green-400" />
            : <WifiOff size={16} className="text-red-400 animate-pulse" />
          }
        </div>
      </nav>

      {/* Main content */}
      <main className={`flex-1 overflow-hidden transition-all ${selectedAgentId ? 'mr-80' : ''}`}>
        {tab === 'office' && <OfficeView />}
        {tab === 'messages' && (
          <div className="h-full">
            <MessageFeed />
          </div>
        )}
        {tab === 'tasks' && (
          <div className="h-full">
            <TaskPanel />
          </div>
        )}
      </main>

      {/* Agent detail panel */}
      {selectedAgentId && <AgentDetailPanel />}

      {/* Add agent modal */}
      {showAddAgent && <AgentModal onClose={() => setShowAddAgent(false)} />}
    </div>
  )
}
