/**
 * AgentDetailPanel — sidebar panel shown when an agent is selected.
 */
import React from 'react'
import { X, Trash2 } from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'

export default function AgentDetailPanel() {
  const agents = useOrgStore(s => s.agents)
  const selectedAgentId = useOrgStore(s => s.selectedAgentId)
  const clearSelected = useOrgStore(s => s.clearSelected)
  const removeAgent = useOrgStore(s => s.removeAgent)
  const messages = useOrgStore(s => s.messages)

  const agent = agents.find(a => a.config.id === selectedAgentId)
  if (!agent) return null

  const agentMessages = messages.filter(
    m => m.from_agent === selectedAgentId || m.to_agent === selectedAgentId
  ).slice(-20)

  async function handleRemove() {
    if (!confirm(`Remove ${agent.config.name}?`)) return
    await removeAgent(agent.config.id)
    clearSelected()
  }

  return (
    <div className="fixed right-0 top-0 bottom-0 w-80 bg-white border-l border-gray-100 shadow-2xl z-40 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold"
            style={{ backgroundColor: agent.config.avatar_color }}
          >
            {agent.config.name.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div className="font-semibold text-sm text-gray-900">{agent.config.name}</div>
            <div className="text-xs text-gray-400">{agent.config.role}</div>
          </div>
        </div>
        <div className="flex gap-2">
          {!agent.config.is_ceo && (
            <button onClick={handleRemove} className="p-1.5 text-red-400 hover:bg-red-50 rounded-lg transition-colors">
              <Trash2 size={15} />
            </button>
          )}
          <button onClick={clearSelected} className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-lg transition-colors">
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Details */}
      <div className="p-4 border-b border-gray-100 space-y-2">
        <Row label="Status" value={agent.status} />
        <Row label="Provider" value={`${agent.config.llm_provider} / ${agent.config.llm_model}`} />
        <Row label="Tokens used" value={`${agent.token_count?.toLocaleString() || 0}`} />
        <Row label="Messages handled" value={agent.messages_processed || 0} />
        <Row label="Max context" value={`${agent.config.max_context_messages} msgs`} />
        {agent.config.description && (
          <p className="text-xs text-gray-500 leading-relaxed">{agent.config.description}</p>
        )}
      </div>

      {/* System prompt preview */}
      <div className="p-4 border-b border-gray-100">
        <p className="text-xs font-medium text-gray-400 mb-1">System Prompt</p>
        <p className="text-xs text-gray-600 leading-relaxed line-clamp-5">
          {agent.config.system_prompt}
        </p>
      </div>

      {/* Recent messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2 scrollbar-thin">
        <p className="text-xs font-medium text-gray-400 mb-2">Recent Messages</p>
        {agentMessages.length === 0 && (
          <p className="text-xs text-gray-300">No messages yet.</p>
        )}
        {agentMessages.map(m => (
          <div key={m.id} className={`text-xs rounded-lg p-2 ${m.from_agent === selectedAgentId ? 'bg-indigo-50 text-indigo-800' : 'bg-gray-50 text-gray-700'}`}>
            <span className="font-medium">{m.from_agent === selectedAgentId ? 'Sent' : 'Received'}: </span>
            {m.content.length > 120 ? m.content.slice(0, 120) + '…' : m.content}
          </div>
        ))}
      </div>
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-gray-400">{label}</span>
      <span className="text-gray-700 font-medium">{value}</span>
    </div>
  )
}
