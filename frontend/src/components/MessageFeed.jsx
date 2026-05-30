/**
 * MessageFeed — live inter-agent conversation log.
 */
import React, { useEffect, useRef } from 'react'
import { useOrgStore } from '../stores/orgStore'

function AgentChip({ id, agents }) {
  const agent = agents.find(a => a.config.id === id)
  const name = id === 'user' ? 'You' : agent?.config.name || id.slice(0, 8)
  const color = id === 'user' ? '#6366f1' : agent?.config.avatar_color || '#9ca3af'
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-white text-xs font-medium"
      style={{ backgroundColor: color }}
    >
      {name}
    </span>
  )
}

export default function MessageFeed() {
  const messages = useOrgStore(s => s.messages)
  const agents = useOrgStore(s => s.agents)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700">Agent Conversations</h2>
        <p className="text-xs text-gray-400">{messages.length} messages</p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin">
        {messages.length === 0 && (
          <div className="text-center text-gray-300 text-sm mt-8">
            No messages yet. Submit a task to watch agents collaborate.
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <AgentChip id={msg.from_agent} agents={agents} />
              <span>→</span>
              <AgentChip id={msg.to_agent} agents={agents} />
              <span className="ml-auto">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <div className="bg-white rounded-xl px-3 py-2 text-sm text-gray-700 shadow-sm border border-gray-100 leading-relaxed">
              {msg.content.length > 300 ? msg.content.slice(0, 300) + '…' : msg.content}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
