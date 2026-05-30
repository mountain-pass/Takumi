/**
 * OfficeView — the main isometric office floor showing all agent desks.
 */
import React from 'react'
import AgentDesk from './AgentDesk'
import { useOrgStore } from '../stores/orgStore'

export default function OfficeView() {
  const agents = useOrgStore(s => s.agents)
  const selectedAgentId = useOrgStore(s => s.selectedAgentId)
  const selectAgent = useOrgStore(s => s.selectAgent)
  const clearSelected = useOrgStore(s => s.clearSelected)

  const activeCount = agents.filter(a => ['working', 'thinking'].includes(a.status)).length

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Organisation Office</h1>
          <p className="text-xs text-gray-400">{agents.length} agents · {activeCount} active</p>
        </div>
        <div className="flex gap-2 text-sm text-gray-500">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-green-400 inline-block" /> Working
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> Thinking
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-gray-300 inline-block" /> Idle
          </span>
        </div>
      </div>

      {/* Office floor */}
      <div
        className="flex-1 overflow-auto p-8 cursor-default"
        onClick={() => clearSelected()}
        style={{
          background: 'linear-gradient(135deg, #f8f7f5 0%, #ede9e3 100%)',
        }}
      >
        {agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <div className="text-6xl mb-4">🏢</div>
            <p className="text-lg font-medium">No agents yet</p>
            <p className="text-sm">Add an agent to get started</p>
          </div>
        ) : (
          <div
            className="flex flex-wrap gap-6 justify-start content-start"
            onClick={e => e.stopPropagation()}
          >
            {/* CEO always first */}
            {agents
              .slice()
              .sort((a, b) => (b.config.is_ceo ? 1 : 0) - (a.config.is_ceo ? 1 : 0))
              .map(agent => (
                <AgentDesk
                  key={agent.config.id}
                  agent={agent}
                  onClick={selectAgent}
                  isSelected={selectedAgentId === agent.config.id}
                />
              ))}

            {/* Empty desk placeholders */}
            {Array.from({ length: Math.max(0, 6 - agents.length) }).map((_, i) => (
              <div
                key={`empty-${i}`}
                className="w-44 h-48 rounded-2xl border-2 border-dashed border-gray-200 flex items-center justify-center"
              >
                <span className="text-gray-200 text-4xl">+</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
