/**
 * WorkflowView — list of automation workflows (n8n/make-style). Clicking one
 * opens the visual editor. Manages list↔editor routing internally.
 */
import React, { useEffect, useState } from 'react'
import {
  GitBranch, Plus, Clock, Webhook, Bot, Hand, CheckCircle2, AlertCircle,
  Loader2, Trash2,
} from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'
import WorkflowEditor from './WorkflowEditor'

const TRIGGER_META = {
  manual:   { icon: Hand,    label: 'Manual' },
  schedule: { icon: Clock,   label: 'Schedule' },
  webhook:  { icon: Webhook, label: 'Webhook' },
  agent:    { icon: Bot,     label: 'Agent' },
}

const RUN_META = {
  success: { icon: CheckCircle2, color: 'text-green-500', label: 'Succeeded' },
  failed:  { icon: AlertCircle,  color: 'text-red-500',   label: 'Failed' },
  running: { icon: Loader2,      color: 'text-blue-500',  label: 'Running' },
}

export default function WorkflowView() {
  const workflows = useOrgStore(s => s.workflows)
  const loadWorkflows = useOrgStore(s => s.loadWorkflows)
  const createWorkflow = useOrgStore(s => s.createWorkflow)
  const deleteWorkflow = useOrgStore(s => s.deleteWorkflow)
  const [editingId, setEditingId] = useState(null)

  useEffect(() => { loadWorkflows() }, [])

  async function handleCreate() {
    const wf = await createWorkflow({
      name: 'Untitled workflow',
      graph: { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 80, y: 160 },
        data: { label: 'When triggered', kind: 'trigger', config: {} } }], edges: [] },
    })
    if (wf?.id) setEditingId(wf.id)
  }

  if (editingId) {
    return <WorkflowEditor workflowId={editingId} onBack={() => { setEditingId(null); loadWorkflows() }} />
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <div>
          <h1 className="text-lg font-semibold text-gray-800">Workflows</h1>
          <p className="text-xs text-gray-400">Build multi-step automations triggered by schedules, webhooks or agents.</p>
        </div>
        <button onClick={handleCreate}
          className="flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg">
          <Plus size={16} /> Create workflow
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {workflows.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-3">
            <GitBranch size={40} strokeWidth={1.5} />
            <p className="text-sm font-medium">No workflows yet</p>
            <button onClick={handleCreate} className="text-indigo-600 text-sm font-medium hover:underline">
              Create your first workflow
            </button>
          </div>
        ) : (
          <div className="space-y-2 max-w-4xl mx-auto">
            {workflows.map(wf => {
              const T = TRIGGER_META[wf.trigger_type] || TRIGGER_META.manual
              const TIcon = T.icon
              const last = wf.last_run
              const R = last && RUN_META[last.status]
              const nodeCount = (wf.graph?.nodes || []).length
              return (
                <div key={wf.id} onClick={() => setEditingId(wf.id)}
                  className="group flex items-center gap-4 px-4 py-3 bg-white border border-gray-200 rounded-xl hover:border-indigo-300 hover:shadow-sm cursor-pointer transition-all">
                  <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
                    <GitBranch size={18} className="text-indigo-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-800 truncate">{wf.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                        wf.status === 'live' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {wf.status === 'live' ? 'Live' : 'Draft'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-400 mt-0.5">
                      <span className="flex items-center gap-1"><TIcon size={12} /> {T.label}</span>
                      <span>·</span>
                      <span>{nodeCount} node{nodeCount === 1 ? '' : 's'}</span>
                      {R && <><span>·</span>
                        <span className={`flex items-center gap-1 ${R.color}`}><R.icon size={12} /> {R.label}</span></>}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${wf.name}"?`)) deleteWorkflow(wf.id) }}
                    className="opacity-0 group-hover:opacity-100 p-2 text-gray-400 hover:text-red-500 transition-opacity">
                    <Trash2 size={15} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
