/**
 * CronJobView — SOP (Standard Operating Procedures) management.
 * Visual editor for routine/standing tasks with scheduling.
 */
import React, { useState } from 'react'
import {
  CalendarClock, Plus, Play, Pause, Trash2, ChevronDown, ChevronRight,
  Clock, CheckCircle2, AlertCircle, RefreshCw, Settings2, Search, Filter,
} from 'lucide-react'
import { useAgentTasks, useCreateTask, useUpdateTask, useDeleteTask } from '../hooks/useApi'
import { useOrgStore } from '../stores/orgStore'

const SCHEDULE_OPTIONS = [
  { value: '@hourly', label: 'Every hour' },
  { value: '@daily', label: 'Every day' },
  { value: '@weekly', label: 'Every week' },
  { value: '@monthly', label: 'Every month' },
  { value: '30m', label: 'Every 30 min' },
  { value: '60m', label: 'Every 60 min' },
  { value: '4h', label: 'Every 4 hours' },
  { value: '8h', label: 'Every 8 hours' },
  { value: '12h', label: 'Every 12 hours' },
  { value: '2d', label: 'Every 2 days' },
  { value: '3d', label: 'Every 3 days' },
]

const STATUS_CONFIG = {
  pending: { icon: Clock, color: 'text-amber-500', bg: 'bg-amber-50', label: 'Scheduled' },
  in_progress: { icon: Play, color: 'text-blue-500', bg: 'bg-blue-50', label: 'Running' },
  completed: { icon: CheckCircle2, color: 'text-green-500', bg: 'bg-green-50', label: 'Completed' },
  failed: { icon: AlertCircle, color: 'text-red-500', bg: 'bg-red-50', label: 'Failed' },
  paused: { icon: Pause, color: 'text-gray-400', bg: 'bg-gray-50', label: 'Paused' },
}

const PRIORITY_STYLE = {
  low: 'border-gray-200 text-gray-500',
  normal: 'border-blue-200 text-blue-600',
  high: 'border-amber-200 text-amber-600',
  urgent: 'border-red-200 text-red-600',
}

export default function CronJobView() {
  const agents = useOrgStore(s => s.agents)
  const { data: allTasks = [], isLoading } = useAgentTasks()
  const [showCreate, setShowCreate] = useState(false)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('scheduled') // 'all' | 'scheduled' | 'adhoc'
  const [expandedId, setExpandedId] = useState(null)

  const agentMap = {}
  agents.forEach(a => { agentMap[a.config.id] = a })

  // Filter tasks
  const filtered = allTasks.filter(t => {
    if (typeFilter === 'scheduled' && t.task_type === 'adhoc') return false
    if (typeFilter === 'adhoc' && t.task_type !== 'adhoc') return false
    if (search) {
      const q = search.toLowerCase()
      const agentName = (agentMap[t.agent_id]?.config?.name || '').toLowerCase()
      return t.title.toLowerCase().includes(q) || agentName.includes(q)
    }
    return true
  })

  // Group by status
  const active = filtered.filter(t => ['pending', 'in_progress'].includes(t.status))
  const paused = filtered.filter(t => t.status === 'paused')
  const completed = filtered.filter(t => ['completed', 'failed'].includes(t.status))

  // Stats
  const routineCount = allTasks.filter(t => t.task_type === 'routine').length
  const standingCount = allTasks.filter(t => t.task_type === 'standing').length
  const activeCount = allTasks.filter(t => ['pending', 'in_progress'].includes(t.status)).length

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-lg font-bold text-gray-900">Scheduled Jobs & SOPs</h1>
            <p className="text-xs text-gray-400 mt-0.5">
              Manage recurring tasks, routines, and standard operating procedures
            </p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors shadow-sm"
          >
            <Plus size={15} /> New SOP
          </button>
        </div>

        {/* Stats bar */}
        <div className="flex gap-4 mb-3">
          <StatPill label="Active" value={activeCount} color="text-blue-600 bg-blue-50" />
          <StatPill label="Routines" value={routineCount} color="text-purple-600 bg-purple-50" />
          <StatPill label="Standing" value={standingCount} color="text-emerald-600 bg-emerald-50" />
          <StatPill label="Total" value={allTasks.length} color="text-gray-600 bg-gray-50" />
        </div>

        {/* Search + Filter */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search tasks or agents..."
              className="w-full pl-9 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {[
              { id: 'scheduled', label: 'Scheduled' },
              { id: 'adhoc', label: 'Ad-hoc' },
              { id: 'all', label: 'All' },
            ].map(f => (
              <button
                key={f.id}
                onClick={() => setTypeFilter(f.id)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors
                  ${typeFilter === f.id ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-40 text-gray-400">
            <RefreshCw size={20} className="animate-spin mr-2" /> Loading...
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState onCreateClick={() => setShowCreate(true)} />
        ) : (
          <>
            {active.length > 0 && (
              <TaskGroup
                title="Active"
                tasks={active}
                agentMap={agentMap}
                expandedId={expandedId}
                onToggle={setExpandedId}
              />
            )}
            {paused.length > 0 && (
              <TaskGroup
                title="Paused"
                tasks={paused}
                agentMap={agentMap}
                expandedId={expandedId}
                onToggle={setExpandedId}
              />
            )}
            {completed.length > 0 && (
              <TaskGroup
                title="Completed / Failed"
                tasks={completed}
                agentMap={agentMap}
                expandedId={expandedId}
                onToggle={setExpandedId}
                defaultCollapsed
              />
            )}
          </>
        )}
      </div>

      {/* Create SOP Modal */}
      {showCreate && (
        <CreateSOPModal agents={agents} onClose={() => setShowCreate(false)} />
      )}
    </div>
  )
}

// ── Stat Pill ────────────────────────────────────────────────────────────────

function StatPill({ label, value, color }) {
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${color}`}>
      <span className="text-sm font-bold">{value}</span>
      {label}
    </div>
  )
}

// ── Task Group ───────────────────────────────────────────────────────────────

function TaskGroup({ title, tasks, agentMap, expandedId, onToggle, defaultCollapsed = false }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  return (
    <div>
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wide hover:text-gray-700"
      >
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        {title}
        <span className="text-gray-300 font-normal normal-case">({tasks.length})</span>
      </button>
      {!collapsed && (
        <div className="space-y-2">
          {tasks.map(task => (
            <SOPCard
              key={task.id}
              task={task}
              agent={agentMap[task.agent_id]}
              assigner={agentMap[task.assigned_by]}
              expanded={expandedId === task.id}
              onToggle={() => onToggle(expandedId === task.id ? null : task.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── SOP Card ─────────────────────────────────────────────────────────────────

function SOPCard({ task, agent, assigner, expanded, onToggle }) {
  const updateTask = useUpdateTask()
  const deleteTask = useDeleteTask()
  const sc = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending
  const StatusIcon = sc.icon

  const agentName = agent?.config?.name || 'Unknown'
  const agentColor = agent?.config?.avatar_color || '#6b7280'
  const assignerName = task.assigned_by === 'user' ? 'You' : assigner?.config?.name || task.assigned_by?.slice(0, 8)

  const isScheduled = task.task_type === 'routine' || task.task_type === 'standing'

  return (
    <div className={`border rounded-xl overflow-hidden transition-all ${expanded ? 'shadow-md border-indigo-200' : 'border-gray-150 hover:border-gray-300'}`}>
      {/* Header row */}
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={onToggle}>
        {/* Status badge */}
        <div className={`shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${sc.bg} ${sc.color}`}>
          <StatusIcon size={11} />
          {sc.label}
        </div>

        {/* Title + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-800 truncate">{task.title}</span>
            {isScheduled && (
              <span className="flex items-center gap-0.5 text-[10px] text-purple-500 bg-purple-50 px-1.5 py-0.5 rounded-full">
                <RefreshCw size={9} />
                {task.schedule_human || task.schedule_cron || 'scheduled'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {/* Agent pill */}
            <span className="flex items-center gap-1 text-[10px] text-gray-500">
              <span
                className="w-3 h-3 rounded-full inline-flex items-center justify-center text-[7px] text-white font-bold"
                style={{ backgroundColor: agentColor }}
              >
                {agentName[0]}
              </span>
              {agentName}
            </span>
            <span className="text-gray-200">·</span>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 border rounded-full ${PRIORITY_STYLE[task.priority] || PRIORITY_STYLE.normal}`}>
              {task.priority}
            </span>
            <span className="text-gray-200">·</span>
            <span className="text-[10px] text-gray-400">{task.task_type}</span>
          </div>
        </div>

        {/* Run count */}
        {task.run_count > 0 && (
          <div className="shrink-0 text-[10px] text-gray-400 text-right">
            {task.run_count} run{task.run_count !== 1 ? 's' : ''}
          </div>
        )}

        {/* Chevron */}
        <div className="shrink-0 text-gray-300">
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-3">
          {/* Instruction */}
          {task.instruction && (
            <div>
              <p className="text-[10px] font-medium text-gray-400 mb-1">Instructions</p>
              <p className="text-xs text-gray-700 bg-gray-50 rounded-lg p-3 leading-relaxed whitespace-pre-wrap">
                {task.instruction}
              </p>
            </div>
          )}

          {/* Result */}
          {task.result && (
            <div>
              <p className="text-[10px] font-medium text-gray-400 mb-1">Last Result</p>
              <p className="text-xs text-gray-700 bg-green-50 rounded-lg p-3 leading-relaxed whitespace-pre-wrap line-clamp-6">
                {task.result}
              </p>
            </div>
          )}

          {/* Meta grid */}
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <MetaRow label="Assigned by" value={assignerName} />
            <MetaRow label="Created" value={formatDate(task.created_at)} />
            {task.last_run_at && <MetaRow label="Last run" value={formatDate(task.last_run_at)} />}
            {task.next_run_at && <MetaRow label="Next run" value={formatDate(task.next_run_at)} />}
            {task.token_count > 0 && <MetaRow label="Tokens" value={task.token_count.toLocaleString()} />}
            {task.schedule_cron && <MetaRow label="Schedule" value={task.schedule_cron} />}
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            {task.status === 'pending' && (
              <ActionBtn
                icon={Pause} label="Pause"
                color="text-amber-600 bg-amber-50 hover:bg-amber-100"
                onClick={() => updateTask.mutate({ id: task.id, status: 'paused' })}
              />
            )}
            {task.status === 'paused' && (
              <ActionBtn
                icon={Play} label="Resume"
                color="text-green-600 bg-green-50 hover:bg-green-100"
                onClick={() => updateTask.mutate({ id: task.id, status: 'pending' })}
              />
            )}
            {task.status === 'failed' && (
              <ActionBtn
                icon={RefreshCw} label="Retry"
                color="text-blue-600 bg-blue-50 hover:bg-blue-100"
                onClick={() => updateTask.mutate({ id: task.id, status: 'pending' })}
              />
            )}
            {!['completed'].includes(task.status) && (
              <ActionBtn
                icon={Trash2} label="Delete"
                color="text-red-600 bg-red-50 hover:bg-red-100"
                onClick={() => { if (confirm('Delete this SOP?')) deleteTask.mutate(task.id) }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function MetaRow({ label, value }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-400">{label}</span>
      <span className="text-gray-600 font-medium">{value}</span>
    </div>
  )
}

function ActionBtn({ icon: Icon, label, color, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${color}`}
    >
      <Icon size={12} /> {label}
    </button>
  )
}

function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// ── Empty State ──────────────────────────────────────────────────────────────

function EmptyState({ onCreateClick }) {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-gray-400 gap-3">
      <CalendarClock size={40} strokeWidth={1.5} />
      <p className="text-sm font-medium text-gray-600">No scheduled jobs yet</p>
      <p className="text-xs text-gray-400 max-w-xs text-center">
        Create SOPs to automate recurring work — daily reports, weekly reviews, monitoring tasks.
        Agents will execute them on schedule.
      </p>
      <button
        onClick={onCreateClick}
        className="mt-2 flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
      >
        <Plus size={15} /> Create your first SOP
      </button>
    </div>
  )
}

// ── Create SOP Modal ─────────────────────────────────────────────────────────

function CreateSOPModal({ agents, onClose }) {
  const createTask = useCreateTask()
  const [form, setForm] = useState({
    agent_id: '',
    title: '',
    instruction: '',
    task_type: 'routine',
    priority: 'normal',
    schedule_cron: '@daily',
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
      })
      onClose()
    } catch (err) {
      alert(err.message)
    }
  }

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-bold text-gray-900">New SOP / Scheduled Job</h2>
            <p className="text-xs text-gray-400 mt-0.5">Define a recurring task for an agent</p>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-lg">
            <Settings2 size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Agent */}
          <Field label="Assign to agent">
            <select
              value={form.agent_id}
              onChange={e => set('agent_id', e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              required
            >
              <option value="">Select agent...</option>
              {nonCeoAgents.map(a => (
                <option key={a.config.id} value={a.config.id}>
                  {a.config.name} — {a.config.role}
                </option>
              ))}
            </select>
          </Field>

          {/* Title */}
          <Field label="SOP Title">
            <input
              value={form.title}
              onChange={e => set('title', e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              placeholder="e.g. Daily sales report, Weekly competitor analysis"
              required
            />
          </Field>

          {/* Instructions */}
          <Field label="Instructions">
            <textarea
              value={form.instruction}
              onChange={e => set('instruction', e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
              rows={4}
              placeholder="Step-by-step instructions for the agent. Be specific about what data to gather, what format to use, and who to report to."
            />
          </Field>

          {/* Type + Priority */}
          <div className="flex gap-3">
            <Field label="Type" className="flex-1">
              <select
                value={form.task_type}
                onChange={e => set('task_type', e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              >
                <option value="routine">Routine (auto-repeats)</option>
                <option value="standing">Standing (ongoing)</option>
                <option value="adhoc">Ad-hoc (one-off)</option>
              </select>
            </Field>
            <Field label="Priority" className="flex-1">
              <select
                value={form.priority}
                onChange={e => set('priority', e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </Field>
          </div>

          {/* Schedule */}
          {form.task_type !== 'adhoc' && (
            <div className="flex gap-3">
              <Field label="Frequency" className="flex-1">
                <select
                  value={form.schedule_cron}
                  onChange={e => set('schedule_cron', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                >
                  {SCHEDULE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Description (optional)" className="flex-1">
                <input
                  value={form.schedule_human}
                  onChange={e => set('schedule_human', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  placeholder="e.g. Every weekday at 9am"
                />
              </Field>
            </div>
          )}

          {/* Preview */}
          {form.title && form.agent_id && (
            <div className="bg-indigo-50 rounded-lg p-3 text-xs text-indigo-700">
              <strong>{form.title}</strong> will be assigned to{' '}
              <strong>{nonCeoAgents.find(a => a.config.id === form.agent_id)?.config?.name}</strong>
              {form.task_type !== 'adhoc' && (
                <> and run <strong>{SCHEDULE_OPTIONS.find(o => o.value === form.schedule_cron)?.label?.toLowerCase() || form.schedule_cron}</strong></>
              )}
              .
            </div>
          )}

          {/* Submit */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createTask.isPending}
              className="px-5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50 shadow-sm"
            >
              {createTask.isPending ? 'Creating...' : 'Create SOP'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function Field({ label, className = '', children }) {
  return (
    <div className={className}>
      <label className="text-xs font-medium text-gray-600 block mb-1">{label}</label>
      {children}
    </div>
  )
}
