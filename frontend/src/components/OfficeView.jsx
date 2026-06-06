/**
 * OfficeView — animated office floor with agents at desks.
 * Task dashboard lives in a collapsible right-hand pane.
 */
import React, { useState, useEffect, useRef } from 'react'
import {
  PanelRightClose, PanelRightOpen, Plus, Clock, CheckCircle2, AlertCircle,
  Pause, Play, X, ListTodo, Filter, RefreshCw, Trash2, ChevronDown,
  MessageSquare, Briefcase,
} from 'lucide-react'
import AgentDesk from './AgentDesk'
import { useOrgStore } from '../stores/orgStore'
import { useAgentTasks, useCreateTask, useUpdateTask, useDeleteTask } from '../hooks/useApi'

// Tokens in plain English (no locale-specific grouping like "万").
const fmtTokens = (n) => (n || 0).toLocaleString('en-US')

// Parse a backend timestamp (UTC; SQLite "YYYY-MM-DD HH:MM:SS" has no zone) into
// a local Date so "today" is computed in the browser's timezone.
function parseUtcTs(ts) {
  if (!ts) return null
  let s = String(ts).trim()
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) s = s.replace(' ', 'T') + 'Z'
  const d = new Date(s)
  return isNaN(d) ? null : d
}

const STATUS_ICON = {
  pending: <Clock size={13} className="text-amber-500" />,
  in_progress: <Play size={13} className="text-blue-500" />,
  completed: <CheckCircle2 size={13} className="text-green-500" />,
  failed: <AlertCircle size={13} className="text-red-500" />,
  paused: <Pause size={13} className="text-gray-400" />,
  blocked: <Clock size={13} className="text-purple-500" />,
}

const PRIORITY_DOT = {
  low: 'bg-gray-300',
  normal: 'bg-blue-400',
  high: 'bg-amber-400',
  urgent: 'bg-red-400',
}

export default function OfficeView() {
  const agents = useOrgStore(s => s.agents)
  const selectedAgentId = useOrgStore(s => s.selectedAgentId)
  const selectAgent = useOrgStore(s => s.selectAgent)
  const clearSelected = useOrgStore(s => s.clearSelected)
  const orgName = useOrgStore(s => s.orgName)

  const [panelOpen, setPanelOpen] = useState(false)
  const [rightTab, setRightTab] = useState('tasks') // 'tasks' | 'messages'
  const [statsOpen, setStatsOpen] = useState(true)
  const [filterAgent, setFilterAgent] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [messages, setMessages] = useState([])
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const msgsEndRef = useRef(null)

  // Auto-switch to messages tab when an agent is selected
  useEffect(() => {
    if (selectedAgentId) {
      setRightTab('messages')
      setPanelOpen(true)
    }
  }, [selectedAgentId])

  // Load messages when messages tab is active and agent is selected
  useEffect(() => {
    if (rightTab === 'messages' && selectedAgentId) {
      setLoadingMsgs(true)
      fetch(`/api/messages?agent_id=${selectedAgentId}&limit=50`)
        .then(r => r.json())
        .then(data => { setMessages(data); setTimeout(() => msgsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100) })
        .catch(() => {})
        .finally(() => setLoadingMsgs(false))
    }
  }, [rightTab, selectedAgentId])

  const { data: tasks = [], isLoading: tasksLoading } = useAgentTasks(
    filterAgent || undefined,
    filterStatus || undefined,
  )

  // Separate unfiltered query to compute active tasks per agent for desk visuals
  const { data: allTasksRaw = [] } = useAgentTasks()

  const agentMap = {}
  agents.forEach(a => { agentMap[a.config.id] = a })

  // Count in_progress + pending tasks per agent
  const activeTasksByAgent = {}
  allTasksRaw.forEach(t => {
    if (t.status === 'in_progress' || t.status === 'pending') {
      activeTasksByAgent[t.agent_id] = (activeTasksByAgent[t.agent_id] || 0) + 1
    }
  })

  // Sorted: CEO first
  const sorted = agents.slice().sort((a, b) => (b.config.is_ceo ? 1 : 0) - (a.config.is_ceo ? 1 : 0))

  // ── Token stats: computed from tasks, scoped to TODAY in the browser's
  //    timezone, broken down per agent. ────────────────────────────────────────
  const todayStr = new Date().toDateString()
  const todayByAgent = {}
  let todayTotal = 0
  allTasksRaw.forEach(t => {
    const d = parseUtcTs(t.completed_at || t.last_run_at || t.created_at)
    if (d && d.toDateString() === todayStr) {
      const tk = t.token_count || 0
      todayByAgent[t.agent_id] = (todayByAgent[t.agent_id] || 0) + tk
      todayTotal += tk
    }
  })
  const todayAgentRows = Object.entries(todayByAgent)
    .map(([id, tok]) => ({ id, name: agentMap[id]?.config?.name || 'Unknown', tok }))
    .sort((a, b) => b.tok - a.tok)

  const activeCount = tasks.filter(t => ['pending', 'in_progress'].includes(t.status)).length
  const completedCount = tasks.filter(t => t.status === 'completed').length

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left: Office Floor ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 shrink-0">
          <div>
            <h1 className="text-lg font-bold text-gray-900">{orgName || 'Organisation'} Office</h1>
            <p className="text-xs text-gray-400">{agents.length} agent{agents.length !== 1 ? 's' : ''}</p>
          </div>
          <button
            onClick={() => setPanelOpen(!panelOpen)}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            title={panelOpen ? 'Hide tasks' : 'Show tasks'}
          >
            {panelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
        </div>

        {/* Office floor */}
        <div
          className="flex-1 overflow-auto p-6 cursor-default"
          onClick={() => clearSelected()}
          style={{
            background: 'linear-gradient(135deg, #f8f7f5 0%, #ede9e3 100%)',
          }}
        >
          {agents.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400">
              <div className="text-6xl mb-4">🏢</div>
              <p className="text-lg font-medium">No agents yet</p>
              <p className="text-sm">Add an agent from the Organisation page to get started</p>
            </div>
          ) : (
            <div>
              {/* Office layout grid */}
              <div className="flex flex-wrap gap-x-2 gap-y-4 justify-start content-start">
                {/* Decorative coffee corner */}
                <OfficeDecor type="coffee" />

                {sorted.map(agent => (
                  <AgentDesk
                    key={agent.config.id}
                    agent={agent}
                    onClick={selectAgent}
                    isSelected={selectedAgentId === agent.config.id}
                    activeTasks={activeTasksByAgent[agent.config.id] || 0}
                  />
                ))}

                {/* Empty desk placeholders */}
                {Array.from({ length: Math.max(0, 4 - agents.length) }).map((_, i) => (
                  <EmptyDesk key={`empty-${i}`} />
                ))}

                {/* Decorative plant corner */}
                <OfficeDecor type="plant" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Right Pane: Tabbed (Tasks / Messages) ── */}
      {panelOpen && (
        <div className="w-80 border-l border-gray-200 bg-white flex flex-col shrink-0 overflow-hidden">
          {/* Tab bar */}
          <div className="flex border-b border-gray-100 shrink-0">
            <button
              onClick={() => setRightTab('tasks')}
              className={`flex-1 px-3 py-2.5 text-[11px] font-medium transition-colors ${
                rightTab === 'tasks'
                  ? 'text-indigo-600 border-b-2 border-indigo-500'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              <Briefcase size={12} className="inline mr-1 -mt-0.5" />
              Tasks ({tasks.length})
            </button>
            <button
              onClick={() => setRightTab('messages')}
              className={`flex-1 px-3 py-2.5 text-[11px] font-medium transition-colors ${
                rightTab === 'messages'
                  ? 'text-indigo-600 border-b-2 border-indigo-500'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              <MessageSquare size={12} className="inline mr-1 -mt-0.5" />
              Messages
              {selectedAgentId && agentMap[selectedAgentId] && (
                <span className="ml-1 text-[10px] text-gray-400">
                  · {agentMap[selectedAgentId].config.name}
                </span>
              )}
            </button>
          </div>

          {rightTab === 'tasks' ? (
            <>
              {/* Collapsible stats header */}
              <button
                onClick={() => setStatsOpen(o => !o)}
                className="w-full px-4 py-2.5 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between hover:bg-gray-100/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">Stats</span>
                  <span className="text-xs font-semibold text-gray-600">
                    {activeCount} active · {completedCount} done · {fmtTokens(todayTotal)} tokens today
                  </span>
                </div>
                <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${statsOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {statsOpen && (
                <>
                  <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/50">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">Today's Tokens</span>
                      <span className="text-[10px] text-gray-300">(your timezone)</span>
                    </div>
                    <div className="text-lg font-bold text-gray-800">{fmtTokens(todayTotal)}</div>
                    {/* Per-agent breakdown for today */}
                    {todayAgentRows.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {todayAgentRows.map(r => (
                          <div key={r.id} className="flex items-center justify-between text-[11px]">
                            <span className="text-gray-500">{r.name}</span>
                            <span className="text-gray-700 font-medium tabular-nums">
                              {fmtTokens(r.tok)}
                              <span className="text-gray-400 ml-1">
                                ({todayTotal ? Math.round((r.tok / todayTotal) * 100) : 0}%)
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-3 border-b border-gray-100">
                    <TaskStat value={activeCount} label="In Progress" color="text-green-600" />
                    <TaskStat value={completedCount} label="Completed" color="text-gray-600" />
                    <TaskStat value={tasks.length} label="Total" color="text-gray-800" />
                  </div>
                </>
              )}

              {/* Filters */}
              <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
                <select
                  value={filterAgent}
                  onChange={e => setFilterAgent(e.target.value)}
                  className="text-[11px] border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-600 focus:outline-none flex-1 min-w-0"
                >
                  <option value="">All agents</option>
                  {agents.filter(a => !a.config.is_ceo).map(a => (
                    <option key={a.config.id} value={a.config.id}>{a.config.name}</option>
                  ))}
                </select>
                <select
                  value={filterStatus}
                  onChange={e => setFilterStatus(e.target.value)}
                  className="text-[11px] border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-600 focus:outline-none"
                >
                  <option value="">All ▾</option>
                  <option value="pending">Pending</option>
                  <option value="in_progress">Running</option>
                  <option value="completed">Done</option>
                  <option value="failed">Failed</option>
                  <option value="paused">Paused</option>
                  <option value="blocked">Blocked</option>
                </select>
              </div>

              {/* Task list */}
              <div className="flex-1 overflow-y-auto scrollbar-thin">
                {tasksLoading ? (
                  <div className="flex items-center justify-center py-12 text-gray-400 text-xs">
                    <RefreshCw size={14} className="animate-spin mr-1.5" /> Loading...
                  </div>
                ) : tasks.length === 0 ? (
                  <div className="text-center py-12 text-gray-400">
                    <ListTodo size={24} className="mx-auto mb-2 opacity-40" />
                    <p className="text-xs">No tasks yet</p>
                  </div>
                ) : (
                  <div className="divide-y divide-gray-50">
                    {tasks.map(task => (
                      <TaskRow key={task.id} task={task} agentMap={agentMap} />
                    ))}
                  </div>
                )}
              </div>

              {/* Bottom: create button */}
              <div className="px-3 py-2 border-t border-gray-100 bg-gray-50/50 shrink-0">
                <button
                  onClick={() => setShowCreateModal(true)}
                  className="w-full flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
                >
                  <Plus size={13} /> New Task
                </button>
              </div>
            </>
          ) : (
            /* Messages tab content */
            <MessagesPane
              selectedAgentId={selectedAgentId}
              agentMap={agentMap}
              messages={messages}
              loading={loadingMsgs}
              msgsEndRef={msgsEndRef}
            />
          )}
        </div>
      )}

      {/* Create Task Modal */}
      {showCreateModal && (
        <CreateTaskModal agents={agents} onClose={() => setShowCreateModal(false)} />
      )}
    </div>
  )
}

// ── Messages Pane ────────────────────────────────────────────────────────────

function MessagesPane({ selectedAgentId, agentMap, messages, loading, msgsEndRef }) {
  if (!selectedAgentId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-400 px-4">
        <MessageSquare size={24} className="mb-2 opacity-40" />
        <p className="text-xs text-center">Click an agent on the office floor to see their messages</p>
      </div>
    )
  }

  const agent = agentMap[selectedAgentId]
  if (!agent) return null

  function resolveAgent(id) {
    const a = agentMap[id]
    return {
      name: a?.config?.name || id?.slice(0, 6) || '?',
      color: a?.config?.avatar_color || '#6b7280',
      initials: (a?.config?.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase(),
    }
  }

  return (
    <>
      {/* Agent header */}
      <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50/50 flex items-center gap-2.5 shrink-0">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-[10px] shrink-0"
          style={{ backgroundColor: agent.config.avatar_color }}
        >
          {agent.config.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-xs text-gray-900 truncate">{agent.config.name}</p>
          <p className="text-[10px] text-gray-400 truncate">{agent.config.role}</p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-400 text-xs">
            <RefreshCw size={14} className="animate-spin mr-1.5" /> Loading...
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <MessageSquare size={20} className="mx-auto mb-2 opacity-40" />
            <p className="text-xs">No messages yet</p>
          </div>
        ) : (
          <div className="p-3 space-y-3">
            {messages.map((m, i) => {
              const isSelf = m.from_agent === selectedAgentId
              const sender = resolveAgent(m.from_agent)
              const receiver = resolveAgent(m.to_agent)
              return (
                <div key={m.id || i} className={`flex gap-2 ${isSelf ? 'flex-row-reverse' : ''}`}>
                  {/* Avatar */}
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[8px] font-bold shrink-0 mt-0.5"
                    style={{ backgroundColor: sender.color }}
                    title={sender.name}
                  >
                    {sender.initials}
                  </div>
                  {/* Bubble */}
                  <div className={`max-w-[85%] ${isSelf ? 'items-end' : 'items-start'}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 px-1">
                      <span className="text-[10px] font-semibold" style={{ color: sender.color }}>{sender.name}</span>
                      <span className="text-[9px] text-gray-300">→</span>
                      <span className="text-[10px] text-gray-400">{receiver.name}</span>
                      {m.created_at && (
                        <span className="text-[9px] text-gray-300 ml-auto">
                          {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                    <div
                      className={`text-xs leading-relaxed rounded-xl px-3 py-2 whitespace-pre-wrap ${
                        isSelf
                          ? 'rounded-tr-sm text-white'
                          : 'rounded-tl-sm bg-gray-100 text-gray-700'
                      }`}
                      style={isSelf ? { backgroundColor: sender.color } : {}}
                    >
                      {m.content?.length > 300 ? m.content.slice(0, 300) + '…' : m.content}
                    </div>
                  </div>
                </div>
              )
            })}
            <div ref={msgsEndRef} />
          </div>
        )}
      </div>
    </>
  )
}

// ── Task Stat Cell ────────────────────────────────────────────────────────────

function TaskStat({ value, label, color }) {
  return (
    <div className="flex flex-col items-center py-3">
      <span className={`text-lg font-bold ${color}`}>{value}</span>
      <span className="text-[10px] text-gray-400">{label}</span>
    </div>
  )
}

// ── Task Row (compact) ────────────────────────────────────────────────────────

function TaskRow({ task, agentMap }) {
  const [expanded, setExpanded] = useState(false)
  const updateTask = useUpdateTask()
  const deleteTask = useDeleteTask()
  const agent = agentMap[task.agent_id]
  const agentName = agent?.config?.name || '?'
  const agentColor = agent?.config?.avatar_color || '#6b7280'
  const assignerName = task.assigned_by === 'user' ? 'You'
    : agentMap[task.assigned_by]?.config?.name || '?'

  const isFailed = task.status === 'failed'

  return (
    <div
      className={`px-3 py-2.5 hover:bg-gray-50/80 group transition-colors cursor-pointer ${expanded ? 'bg-gray-50/60' : ''}`}
      onClick={() => setExpanded(e => !e)}
    >
      <div className="flex items-start gap-2">
        {/* Title + agent avatars */}
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-gray-800 truncate">{task.title}</div>
          <div className="flex items-center gap-1.5 mt-1">
            {/* Agent mini avatars */}
            <div className="flex -space-x-1">
              {task.assigned_by !== 'user' && agentMap[task.assigned_by] && (
                <span
                  className="w-4 h-4 rounded-full inline-flex items-center justify-center text-[6px] text-white font-bold border border-white"
                  style={{ backgroundColor: agentMap[task.assigned_by]?.config?.avatar_color || '#6b7280' }}
                  title={assignerName}
                >
                  {assignerName[0]}
                </span>
              )}
              <span
                className="w-4 h-4 rounded-full inline-flex items-center justify-center text-[6px] text-white font-bold border border-white"
                style={{ backgroundColor: agentColor }}
                title={agentName}
              >
                {agentName[0]}
              </span>
            </div>
            <span className="text-[10px] text-gray-400 truncate">
              {task.token_count ? `${fmtTokens(task.token_count)} tokens` : agentName}
            </span>
          </div>
        </div>

        {/* Status + actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Priority dot */}
          <span className={`w-1.5 h-1.5 rounded-full ${PRIORITY_DOT[task.priority] || PRIORITY_DOT.normal}`} />

          {/* Status badge */}
          <span className={`text-[10px] font-medium ${
            task.status === 'in_progress' ? 'text-green-600' :
            task.status === 'completed' ? 'text-green-500' :
            task.status === 'failed' ? 'text-red-500' :
            task.status === 'paused' ? 'text-gray-400' :
            task.status === 'blocked' ? 'text-purple-500' :
            'text-amber-500'
          }`}>
            {task.status === 'in_progress' ? 'Running' :
             task.status === 'completed' ? 'Done' :
             task.status === 'failed' ? 'Failed' :
             task.status === 'paused' ? 'Paused' :
             task.status === 'blocked' ? 'Blocked' :
             'Pending'}
          </span>
          <ChevronDown size={10} className={`text-gray-300 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="mt-2 space-y-2" onClick={e => e.stopPropagation()}>
          {/* Who did it + token cost */}
          <div className="flex items-center justify-between bg-white rounded-lg p-2 border border-gray-100">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-bold"
                style={{ backgroundColor: agent?.config?.avatar_color || '#6b7280' }}>
                {agentName[0]}
              </span>
              <span className="text-[11px] text-gray-700">{agentName}</span>
            </div>
            <span className="text-[11px] font-semibold text-gray-700 tabular-nums">
              {fmtTokens(task.token_count || 0)} tokens
            </span>
          </div>

          {/* Instruction */}
          {task.instruction && (
            <div>
              <div className="text-[10px] font-medium text-gray-400 uppercase mb-0.5">Instruction</div>
              <p className="text-[11px] text-gray-600 bg-white rounded-lg p-2 border border-gray-100 leading-relaxed whitespace-pre-wrap">
                {task.instruction}
              </p>
            </div>
          )}

          {/* Result or Error */}
          {task.result && (
            <div>
              <div className={`text-[10px] font-medium uppercase mb-0.5 ${isFailed ? 'text-red-400' : 'text-gray-400'}`}>
                {isFailed ? 'Error' : 'Result'}
              </div>
              <p className={`text-[11px] rounded-lg p-2 border leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto ${
                isFailed
                  ? 'text-red-600 bg-red-50 border-red-100'
                  : 'text-gray-700 bg-green-50 border-green-100'
              }`}>
                {task.result}
              </p>
            </div>
          )}

          {/* Metadata row */}
          <div className="flex items-center gap-3 text-[10px] text-gray-400">
            {task.token_count > 0 && <span>{fmtTokens(task.token_count)} tokens</span>}
            {task.run_count > 0 && <span>{task.run_count} run{task.run_count > 1 ? 's' : ''}</span>}
            {task.schedule_human && <span>{task.schedule_human}</span>}
            <span className="ml-auto">{task.created_at ? formatTime(task.created_at) : ''}</span>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 pt-1 border-t border-gray-100">
            {task.status === 'pending' && (
              <button onClick={() => updateTask.mutate({ id: task.id, status: 'paused' })} className="text-[10px] text-amber-500 hover:underline">Pause</button>
            )}
            {task.status === 'paused' && (
              <button onClick={() => updateTask.mutate({ id: task.id, status: 'pending' })} className="text-[10px] text-green-500 hover:underline">Resume</button>
            )}
            {task.status === 'failed' && (
              <button onClick={() => updateTask.mutate({ id: task.id, status: 'pending', next_run_at: new Date().toISOString() })} className="text-[10px] text-blue-500 hover:underline">Retry</button>
            )}
            {!['completed'].includes(task.status) && (
              <button onClick={() => { if (confirm('Delete this task?')) deleteTask.mutate(task.id) }} className="text-[10px] text-red-400 hover:underline ml-auto">Delete</button>
            )}
          </div>
        </div>
      )}

      {/* Timestamp row (collapsed only) */}
      {!expanded && (
        <div className="flex items-center justify-between mt-1">
          <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {task.status === 'pending' && (
              <button onClick={e => { e.stopPropagation(); updateTask.mutate({ id: task.id, status: 'paused' }) }} className="text-[9px] text-amber-500 hover:underline">pause</button>
            )}
            {task.status === 'paused' && (
              <button onClick={e => { e.stopPropagation(); updateTask.mutate({ id: task.id, status: 'pending' }) }} className="text-[9px] text-green-500 hover:underline">resume</button>
            )}
            {!['completed', 'failed'].includes(task.status) && (
              <button onClick={e => { e.stopPropagation(); if (confirm('Delete?')) deleteTask.mutate(task.id) }} className="text-[9px] text-red-400 hover:underline">delete</button>
            )}
          </div>
          <span className="text-[10px] text-gray-300">
            {task.created_at ? formatTime(task.created_at) : ''}
          </span>
        </div>
      )}
    </div>
  )
}

function formatTime(iso) {
  const d = new Date(iso)
  return `${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} ${d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })}`
}

// ── Office Decorations ────────────────────────────────────────────────────────

function OfficeDecor({ type }) {
  if (type === 'coffee') {
    return (
      <div className="w-[180px] flex flex-col items-center justify-end pb-2">
        <svg width="140" height="70" viewBox="0 0 140 70" fill="none">
          {/* Counter */}
          <rect x="10" y="30" width="120" height="30" rx="4" fill="#e8dfd0" />
          <rect x="10" y="30" width="120" height="4" rx="2" fill="#d4c4a8" />
          {/* Coffee cups */}
          <rect x="25" y="20" width="10" height="12" rx="2" fill="#8B4513" />
          <rect x="40" y="22" width="10" height="10" rx="2" fill="#A0522D" />
          <rect x="55" y="21" width="10" height="11" rx="2" fill="#8B4513" />
          <rect x="70" y="23" width="10" height="9" rx="2" fill="#A0522D" />
          <rect x="85" y="20" width="10" height="12" rx="2" fill="#8B4513" />
          <rect x="100" y="22" width="10" height="10" rx="2" fill="#A0522D" />
          {/* Coffee machine */}
          <rect x="48" y="5" width="20" height="18" rx="3" fill="#6b7280" />
          <rect x="52" y="8" width="12" height="8" rx="1" fill="#374151" />
          <circle cx="58" cy="12" r="2" fill="#ef4444" />
        </svg>
        <span className="text-[9px] text-gray-300 mt-0.5">☕ Coffee Corner</span>
      </div>
    )
  }

  if (type === 'plant') {
    return (
      <div className="w-[180px] flex flex-col items-center justify-end pb-2">
        <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
          {/* Pot */}
          <path d="M25 55 L30 75 L50 75 L55 55 Z" fill="#c4856c" />
          <rect x="22" y="50" width="36" height="8" rx="3" fill="#d4956c" />
          {/* Plant leaves */}
          <ellipse cx="40" cy="35" rx="15" ry="18" fill="#4ade80" opacity="0.7" />
          <ellipse cx="32" cy="30" rx="10" ry="14" fill="#22c55e" opacity="0.6" />
          <ellipse cx="48" cy="32" rx="10" ry="14" fill="#16a34a" opacity="0.5" />
          <ellipse cx="40" cy="25" rx="8" ry="12" fill="#4ade80" opacity="0.8" />
        </svg>
        <span className="text-[9px] text-gray-300 mt-0.5">🌿</span>
      </div>
    )
  }

  return null
}

// ── Empty Desk ────────────────────────────────────────────────────────────────

function EmptyDesk() {
  return (
    <div className="w-[180px] flex flex-col items-center opacity-30">
      <div className="min-h-[36px]" />
      <svg width="160" height="130" viewBox="0 0 160 130" fill="none">
        {/* Desk */}
        <rect x="15" y="68" width="130" height="6" rx="2" fill="#d4c4a8" />
        <rect x="15" y="74" width="130" height="30" rx="1" fill="#c4b494" />
        <rect x="20" y="104" width="6" height="16" rx="1" fill="#b0a080" />
        <rect x="134" y="104" width="6" height="16" rx="1" fill="#b0a080" />
        {/* Monitor */}
        <rect x="42" y="10" width="76" height="34" rx="3" fill="#374151" stroke="#4b5563" strokeWidth="1" />
        <rect x="46" y="14" width="68" height="26" rx="1" fill="#1e293b" />
        <rect x="77" y="42" width="6" height="20" rx="1" fill="#9ca3af" />
        <rect x="65" y="60" width="30" height="4" rx="2" fill="#9ca3af" />
        {/* Empty chair */}
        <ellipse cx="80" cy="95" rx="22" ry="6" fill="#4b5563" opacity="0.5" />
        <path d="M60 95 L62 65 Q80 58 98 65 L100 95" fill="#374151" opacity="0.4" />
      </svg>
      <span className="text-[10px] text-gray-300">Available</span>
    </div>
  )
}

// ── Create Task Modal ─────────────────────────────────────────────────────────

function CreateTaskModal({ agents, onClose }) {
  const createTask = useCreateTask()
  const [form, setForm] = useState({
    agent_id: '',
    title: '',
    instruction: '',
    task_type: 'adhoc',
    priority: 'normal',
    schedule_cron: '',
    schedule_human: '',
  })

  const nonCeoAgents = agents.filter(a => !a.config.is_ceo)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.agent_id || !form.title) return
    try {
      await createTask.mutateAsync({
        ...form,
        assigned_by: 'user',
        schedule_cron: form.schedule_cron || undefined,
        schedule_human: form.schedule_human || undefined,
      })
      onClose()
    } catch (err) {
      alert(err.message)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-gray-900">Create Task</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:bg-gray-100 rounded-lg">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Assign to</label>
            <select
              value={form.agent_id}
              onChange={e => setForm(f => ({ ...f, agent_id: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              required
            >
              <option value="">Select agent...</option>
              {nonCeoAgents.map(a => (
                <option key={a.config.id} value={a.config.id}>{a.config.name} — {a.config.role}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Title</label>
            <input
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              placeholder="e.g. Research competitor pricing"
              required
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Instructions</label>
            <textarea
              value={form.instruction}
              onChange={e => setForm(f => ({ ...f, instruction: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
              rows={3}
              placeholder="Detailed instructions..."
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs font-medium text-gray-600 block mb-1">Type</label>
              <select
                value={form.task_type}
                onChange={e => setForm(f => ({ ...f, task_type: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              >
                <option value="adhoc">Ad-hoc (one-off)</option>
                <option value="routine">Routine (recurring)</option>
                <option value="standing">Standing (ongoing)</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="text-xs font-medium text-gray-600 block mb-1">Priority</label>
              <select
                value={form.priority}
                onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>

          {(form.task_type === 'routine' || form.task_type === 'standing') && (
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-xs font-medium text-gray-600 block mb-1">Schedule</label>
                <select
                  value={form.schedule_cron}
                  onChange={e => setForm(f => ({ ...f, schedule_cron: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                >
                  <option value="">Select...</option>
                  <option value="@hourly">Every hour</option>
                  <option value="@daily">Every day</option>
                  <option value="@weekly">Every week</option>
                  <option value="@monthly">Every month</option>
                  <option value="60m">Every 60 min</option>
                  <option value="8h">Every 8 hours</option>
                </select>
              </div>
              <div className="flex-1">
                <label className="text-xs font-medium text-gray-600 block mb-1">Description</label>
                <input
                  value={form.schedule_human}
                  onChange={e => setForm(f => ({ ...f, schedule_human: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  placeholder="e.g. Every weekday 9am"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">Cancel</button>
            <button type="submit" disabled={createTask.isPending} className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50">
              {createTask.isPending ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
