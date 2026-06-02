/**
 * AgentDesk — renders an agent sitting at a desk with monitor and chair.
 * Isometric-style office desk scene using pure CSS/SVG.
 */
import React from 'react'

const STATUS_COLORS = {
  idle: '#9ca3af',      // grey
  working: '#22c55e',   // green
  thinking: '#3b82f6',  // blue
  error: '#ef4444',     // red
  offline: '#ef4444',   // red
}

export default function AgentDesk({ agent, onClick, isSelected, activeTasks = 0 }) {
  const { config, status, current_action, token_count } = agent
  // Agent is visually "active" if real-time status is working/thinking OR has in-progress tasks
  const isActive = status === 'working' || status === 'thinking' || activeTasks > 0
  const isIdle = !isActive && status !== 'offline'
  const screenColor = isActive ? '#22c55e' : status === 'thinking' ? '#3b82f6' : '#1e293b'

  return (
    <div
      onClick={e => { e.stopPropagation(); onClick(config.id) }}
      className={`
        cursor-pointer select-none relative
        w-[180px] flex flex-col items-center
        transition-all duration-200 hover:scale-[1.03]
        ${isSelected ? 'z-10' : ''}
      `}
    >
      {/* Agent name + status label above */}
      <div className="text-center mb-1 min-h-[36px]">
        <div className="font-semibold text-xs text-gray-800">{config.name}</div>
        {isActive && (
          <div className="text-[10px] text-green-600 font-medium">
            {current_action
              || (activeTasks > 0 ? `Working on ${activeTasks} task${activeTasks > 1 ? 's' : ''}`
              : status === 'working' ? 'Working...' : 'Thinking...')}
          </div>
        )}
      </div>

      {/* Desk scene */}
      <div className={`relative ${isActive ? 'agent-float' : ''}`}>
        <svg width="160" height="130" viewBox="0 0 160 130" fill="none">
          {/* === Desk surface === */}
          {/* Desktop (top) */}
          <rect x="15" y="68" width="130" height="6" rx="2" fill="#d4c4a8" />
          {/* Desk front panel */}
          <rect x="15" y="74" width="130" height="30" rx="1" fill="#c4b494" />
          {/* Desk legs */}
          <rect x="20" y="104" width="6" height="16" rx="1" fill="#b0a080" />
          <rect x="134" y="104" width="6" height="16" rx="1" fill="#b0a080" />
          {/* Desk surface shadow */}
          <rect x="18" y="74" width="124" height="2" fill="#baa87c" opacity="0.5" />

          {/* === Monitor === */}
          {/* Monitor stand base */}
          <rect x="65" y="60" width="30" height="4" rx="2" fill="#9ca3af" />
          {/* Monitor stand pole */}
          <rect x="77" y="42" width="6" height="20" rx="1" fill="#9ca3af" />
          {/* Monitor body */}
          <rect x="42" y="10" width="76" height="34" rx="3" fill="#374151"
            stroke={isSelected ? '#6366f1' : (isActive ? screenColor : '#4b5563')}
            strokeWidth={isSelected ? 2 : 1}
          />
          {/* Screen */}
          <rect x="46" y="14" width="68" height="26" rx="1" fill={isActive ? '#111827' : '#1e293b'} />

          {/* Screen content when active */}
          {isActive && (
            <>
              {/* Code/work lines */}
              <rect x="50" y="18" width="28" height="2" rx="1" fill="#22c55e" opacity="0.8" />
              <rect x="50" y="22" width="40" height="2" rx="1" fill="#60a5fa" opacity="0.6" />
              <rect x="50" y="26" width="22" height="2" rx="1" fill="#22c55e" opacity="0.7" />
              <rect x="50" y="30" width="35" height="2" rx="1" fill="#818cf8" opacity="0.5" />
              <rect x="50" y="34" width="18" height="2" rx="1" fill="#22c55e" opacity="0.6" />
              {/* Blinking cursor */}
              <rect x="74" y="34" width="2" height="3" fill="#22c55e">
                <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite" />
              </rect>
            </>
          )}

          {/* Screen content when idle — sleep dots */}
          {isIdle && (
            <text x="80" y="30" textAnchor="middle" fill="#4b5563" fontSize="10" fontFamily="monospace">···</text>
          )}

          {/* Screen content when thinking — spinner dots */}
          {status === 'thinking' && (
            <>
              <circle cx="70" cy="27" r="2" fill="#3b82f6">
                <animate attributeName="opacity" values="1;0.3;1" dur="0.8s" begin="0s" repeatCount="indefinite" />
              </circle>
              <circle cx="80" cy="27" r="2" fill="#3b82f6">
                <animate attributeName="opacity" values="1;0.3;1" dur="0.8s" begin="0.2s" repeatCount="indefinite" />
              </circle>
              <circle cx="90" cy="27" r="2" fill="#3b82f6">
                <animate attributeName="opacity" values="1;0.3;1" dur="0.8s" begin="0.4s" repeatCount="indefinite" />
              </circle>
            </>
          )}

          {/* === Keyboard === */}
          <rect x="55" y="62" width="50" height="6" rx="2" fill="#e5e7eb" />
          <rect x="57" y="63" width="46" height="4" rx="1" fill="#d1d5db" />

          {/* === Chair === */}
          {/* Chair seat */}
          <ellipse cx="80" cy="95" rx="22" ry="6" fill="#4b5563" />
          {/* Chair back */}
          <path d="M60 95 L62 65 Q80 58 98 65 L100 95" fill="#374151" opacity="0.9" />
          {/* Chair back top */}
          <ellipse cx="80" cy="64" rx="19" ry="5" fill="#4b5563" />

          {/* === Agent (sitting in chair) === */}
          {/* Head */}
          <circle cx="80" cy="48" r="11" fill={config.avatar_color} />
          {/* Initials */}
          <text
            x="80" y="52"
            textAnchor="middle"
            fill="white"
            fontSize="9"
            fontWeight="bold"
            fontFamily="Inter, sans-serif"
          >
            {config.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
          </text>
          {/* Body/shoulders */}
          <path
            d={`M66 58 Q80 52 94 58 L96 72 Q80 76 64 72 Z`}
            fill={config.avatar_color}
            opacity="0.85"
          />
          {/* Arms reaching to keyboard */}
          {isActive && (
            <>
              <path d="M66 64 Q60 70 58 68" stroke={config.avatar_color} strokeWidth="3" fill="none" strokeLinecap="round" />
              <path d="M94 64 Q100 70 102 68" stroke={config.avatar_color} strokeWidth="3" fill="none" strokeLinecap="round" />
            </>
          )}

          {/* ZZZ for idle */}
          {isIdle && (
            <>
              <text x="100" y="40" fill="#9ca3af" fontSize="8" fontWeight="bold" fontFamily="sans-serif" opacity="0.6">z</text>
              <text x="106" y="34" fill="#9ca3af" fontSize="10" fontWeight="bold" fontFamily="sans-serif" opacity="0.4">z</text>
              <text x="113" y="26" fill="#9ca3af" fontSize="12" fontWeight="bold" fontFamily="sans-serif" opacity="0.3">Z</text>
            </>
          )}

          {/* Status dot — reflect effective status (active if has tasks) */}
          <circle cx="91" cy="48" r="4" fill={isActive ? '#22c55e' : (STATUS_COLORS[status] || '#9ca3af')} stroke="white" strokeWidth="1.5" />
        </svg>
      </div>

      {/* Role label below desk */}
      <div className="text-center mt-0.5">
        <div className="text-[10px] text-gray-400 truncate max-w-[160px]">{config.role}</div>
      </div>

      {/* Selection ring */}
      {isSelected && (
        <div className="absolute -inset-2 border-2 border-indigo-400 rounded-2xl pointer-events-none opacity-60" />
      )}
    </div>
  )
}
