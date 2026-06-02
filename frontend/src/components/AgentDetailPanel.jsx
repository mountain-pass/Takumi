/**
 * AgentDetailPanel — sidebar panel shown when an agent is selected in the Office.
 * Tabs: Info, Tasks, Messages
 */
import React, { useState } from 'react'
import { X, Trash2, Clock, CheckCircle2, AlertCircle, Pause, Play, ListTodo, MessageSquare, Info } from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'
import { useAgentTasks, useTaskLogs, useUpdateTask } from '../hooks/useApi'

const STATUS_ICON = {
  pending: <Clock size={12} className="text-amber-500" />,
  in_progress: <Play size={12} className="text-blue-500" />,
  completed: <CheckCircle2 size={12} className="text-green-500" />,
  failed: <AlertCircle size={12} className="text-red-500" />,
  paused: <Pause size={12} className="text-gray-400" />,
}

export default function AgentDetailPanel() {
  const agents = useOrgStore(s => s.agents)
  const selectedAgentId = useOrgStore(s => s.selectedAgentId)
  const clearSelected = useOrgStore(s => s.clearSelected)
  const removeAgent = useOrgStore(s => s.removeAgent)
  const messages = useOrgStore(s => s.messages)

  const [tab, setTab] = useState('info')

  const agent = agents.find(a => a.config.id === selectedAgentId)
  if (!agent) return null

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

      {/* Tabs */}
      <div className="flex border-b border-gray-100">
        {[
          { id: 'info', icon: Info, label: 'Info' },
          { id: 'tasks', icon: ListTodo, label: 'Tasks' },
          { id: 'messages', icon: MessageSquare, label: 'Messages' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors
              ${tab === t.id ? 'text-indigo-600 border-b-2 border-indigo-500' : 'text-gray-400 hover:text-gray-600'}`}
          >
            <t.icon size={13} />
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {tab === 'info' && <InfoTab agent={agent} />}
        {tab === 'tasks' && <TasksTab agentId={selectedAgentId} agents={agents} />}
        {tab === 'messages' && <MessagesTab agentId={selectedAgentId} messages={messages} />}
      </div>
    </div>
  )
}

// ── Info Tab ──────────────────────────────────────────────────────────────────

function InfoTab({ agent }) {
  return (
    <div>
      <div className="p-4 border-b border-gray-100 space-y-2">
        <Row label="Status" value={agent.status} />
        <Row label="Provider" value={`${agent.config.llm_provider} / ${agent.config.llm_model}`} />
        <Row label="Tokens used" value={`${agent.token_count?.toLocaleString() || 0}`} />
        <Row label="Messages handled" value={agent.messages_processed || 0} />
        <Row label="Max context" value={`${agent.config.max_context_messages} msgs`} />
        {agent.config.description && (
          <p className="text-xs text-gray-500 leading-relaxed pt-1">{agent.config.description}</p>
        )}
      </div>
      <div className="p-4">
        <p className="text-xs font-medium text-gray-400 mb-1">System Prompt</p>
        <p className="text-xs text-gray-600 leading-relaxed line-clamp-8">
          {agent.config.system_prompt}
        </p>
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

// ── Tasks Tab ────────────────────────────────────────────────────────────────

function TasksTab({ agentId, agents }) {
  const { data: tasks = [], isLoading } = useAgentTasks(agentId)
  const updateTask = useUpdateTask()
  const [expandedTask, setExpandedTask] = useState(null)

  const agentMap = {}
  agents.forEach(a => { agentMap[a.config.id] = a.config.name })

  if (isLoading) return <p className="text-xs text-gray-400 p-4 text-center">Loading...</p>
  if (tasks.length === 0) return <p className="text-xs text-gray-400 p-4 text-center">No tasks assigned to this agent.</p>

  return (
    <div className="p-3 space-y-2">
      {tasks.map(task => (
        <div key={task.id} className="border border-gray-100 rounded-lg overflow-hidden">
          <button
            onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
            className="w-full flex items-center gap-2 p-2.5 hover:bg-gray-50 transition-colors text-left"
          >
            <div className="shrink-0">{STATUS_ICON[task.status] || STATUS_ICON.pending}</div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-gray-800 truncate">{task.title}</div>
              <div className="text-[10px] text-gray-400">
                {task.task_type} · {task.priority}
                {task.assigned_by !== 'user' && ` · from ${agentMap[task.assigned_by] || 'unknown'}`}
              </div>
            </div>
          </button>

          {expandedTask === task.id && (
            <div className="px-2.5 pb-2.5 space-y-2">
              {task.instruction && (
                <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">{task.instruction}</p>
              )}
              {task.result && (
                <div>
                  <p className="text-[10px] font-medium text-gray-400 mb-0.5">Result</p>
                  <p className="text-xs text-gray-600 bg-green-50 rounded p-2 leading-relaxed line-clamp-4">{task.result}</p>
                </div>
              )}
              {task.schedule_human && (
                <p className="text-[10px] text-gray-400">Schedule: {task.schedule_human}</p>
              )}
              <div className="flex gap-1.5">
                {task.status === 'pending' && (
                  <button
                    onClick={() => updateTask.mutate({ id: task.id, status: 'paused' })}
                    className="text-[10px] px-2 py-1 rounded bg-amber-50 text-amber-600 hover:bg-amber-100 transition-colors"
                  >
                    Pause
                  </button>
                )}
                {task.status === 'paused' && (
                  <button
                    onClick={() => updateTask.mutate({ id: task.id, status: 'pending' })}
                    className="text-[10px] px-2 py-1 rounded bg-green-50 text-green-600 hover:bg-green-100 transition-colors"
                  >
                    Resume
                  </button>
                )}
              </div>

              {/* Task log timeline */}
              <TaskLogTimeline taskId={task.id} agentMap={agentMap} />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function TaskLogTimeline({ taskId, agentMap }) {
  const { data: logs = [] } = useTaskLogs(taskId)
  if (logs.length === 0) return null

  return (
    <div className="pt-1">
      <p className="text-[10px] font-medium text-gray-400 mb-1">Activity</p>
      <div className="space-y-1">
        {logs.map(log => (
          <div key={log.id} className="flex items-start gap-1.5 text-[10px]">
            <div className="w-1 h-1 rounded-full bg-gray-300 mt-1.5 shrink-0" />
            <div className="text-gray-500">
              <span className="font-medium text-gray-600">{log.action}</span>
              {log.detail && <span className="ml-1">— {log.detail.slice(0, 80)}{log.detail.length > 80 ? '…' : ''}</span>}
              <span className="block text-gray-300">
                {log.created_at ? new Date(log.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Messages Tab ─────────────────────────────────────────────────────────────

function MessagesTab({ agentId, messages }) {
  const agentMessages = messages.filter(
    m => m.from_agent === agentId || m.to_agent === agentId
  ).slice(-30)

  if (agentMessages.length === 0) {
    return <p className="text-xs text-gray-300 p-4 text-center">No messages yet.</p>
  }

  return (
    <div className="p-3 space-y-2">
      {agentMessages.map(m => (
        <div key={m.id} className={`text-xs rounded-lg p-2 ${m.from_agent === agentId ? 'bg-indigo-50 text-indigo-800' : 'bg-gray-50 text-gray-700'}`}>
          <span className="font-medium">{m.from_agent === agentId ? 'Sent' : 'Received'}: </span>
          {m.content.length > 120 ? m.content.slice(0, 120) + '…' : m.content}
        </div>
      ))}
    </div>
  )
}
