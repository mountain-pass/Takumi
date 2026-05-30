/**
 * AgentDesk — renders one agent as an isometric-style desk with avatar.
 * Shows status, name, role, and current action.
 */
import React from 'react'

const STATUS_COLORS = {
  idle: '#9ca3af',
  thinking: '#f59e0b',
  working: '#10b981',
  waiting: '#6366f1',
  offline: '#6b7280',
}

const STATUS_LABEL = {
  idle: 'Idle',
  thinking: 'Thinking...',
  working: 'Working',
  waiting: 'Waiting',
  offline: 'Offline',
}

function PulsingDot({ color }) {
  return (
    <span className="relative flex h-2.5 w-2.5">
      <span
        className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
        style={{ backgroundColor: color }}
      />
      <span
        className="relative inline-flex rounded-full h-2.5 w-2.5"
        style={{ backgroundColor: color }}
      />
    </span>
  )
}

function AgentAvatar({ name, color, status }) {
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  const isActive = status === 'working' || status === 'thinking'

  return (
    <div className={`relative ${isActive ? 'agent-float' : ''}`}>
      {/* Monitor */}
      <div className="flex flex-col items-center mb-1">
        <div
          className="w-16 h-11 rounded-sm border-2 border-gray-300 bg-gray-900 flex items-center justify-center shadow-md"
          style={{ borderColor: isActive ? color : undefined }}
        >
          {isActive && (
            <div className="flex gap-1">
              {[0, 1, 2].map(i => (
                <div
                  key={i}
                  className="w-1 bg-green-400 rounded-full"
                  style={{
                    height: `${8 + Math.sin(Date.now() / 200 + i) * 4}px`,
                    animation: `blink ${0.6 + i * 0.2}s ease-in-out infinite`,
                  }}
                />
              ))}
            </div>
          )}
          {!isActive && (
            <div className="text-gray-600 text-xs font-mono">···</div>
          )}
        </div>
        {/* Monitor stand */}
        <div className="w-3 h-2 bg-gray-400 rounded-b" />
        <div className="w-8 h-1 bg-gray-400 rounded" />
      </div>

      {/* Avatar circle */}
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-sm shadow-lg mx-auto"
        style={{ backgroundColor: color }}
      >
        {initials}
      </div>
    </div>
  )
}

export default function AgentDesk({ agent, onClick, isSelected }) {
  const { config, status, current_action, token_count } = agent
  const dotColor = STATUS_COLORS[status] || '#9ca3af'

  return (
    <div
      onClick={() => onClick(config.id)}
      className={`
        cursor-pointer select-none
        bg-white rounded-2xl p-4 w-44 flex flex-col items-center gap-2
        border-2 transition-all duration-200 hover:scale-105
        ${isSelected ? 'border-indigo-500 shadow-lg shadow-indigo-100' : 'border-transparent shadow-md hover:shadow-lg'}
        ${status === 'working' ? 'agent-working' : ''}
      `}
    >
      <AgentAvatar name={config.name} color={config.avatar_color} status={status} />

      {/* Name & role */}
      <div className="text-center">
        <div className="font-semibold text-sm text-gray-900">{config.name}</div>
        <div className="text-xs text-gray-500 truncate max-w-full">{config.role}</div>
      </div>

      {/* Status */}
      <div className="flex items-center gap-1.5">
        <PulsingDot color={dotColor} />
        <span className="text-xs font-medium" style={{ color: dotColor }}>
          {STATUS_LABEL[status] || status}
        </span>
      </div>

      {/* Current action */}
      {current_action && (
        <div className="text-xs text-gray-400 text-center truncate max-w-full italic">
          {current_action}
        </div>
      )}

      {/* Token count */}
      {token_count > 0 && (
        <div className="text-xs text-gray-300">
          ☕ {(token_count / 1000).toFixed(1)}k tokens
        </div>
      )}
    </div>
  )
}
