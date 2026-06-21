/**
 * WorkflowEditor — visual node canvas (React Flow) for building a workflow.
 * Drag nodes from the palette, connect them, configure each in the side drawer,
 * and Test-run with live per-node highlighting + compliance badges.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, applyNodeChanges, applyEdgeChanges, Handle, Position,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  ArrowLeft, Save, Play, Globe, Code2, GitFork, Repeat, Merge as MergeIcon,
  Sparkles, Hand, Loader2, CheckCircle2, AlertCircle, ShieldCheck, ShieldAlert,
  ShieldX, X, Copy, Timer, Workflow, Reply, CircleSlash,
} from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'

// ── Node-type catalogue ───────────────────────────────────────────────────────
const NODE_META = {
  trigger: { label: 'Trigger', icon: Hand, color: '#6366f1', fields: [
    { key: 'triggerType', label: 'Trigger type', type: 'select', options: ['manual', 'schedule', 'webhook', 'agent'] },
    { key: 'cron', label: 'Schedule (when type = schedule)', type: 'select',
      options: ['@hourly', '@daily', '@weekly', '30m', '60m', '4h', '12h'] },
    { key: 'sample', label: 'Sample payload (JSON, for testing)', type: 'json' },
  ] },
  http: { label: 'HTTP request', icon: Globe, color: '#0ea5e9', fields: [
    { key: 'method', label: 'Method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    { key: 'url', label: 'URL', type: 'text', placeholder: 'https://api.example.com/{{trigger.id}}' },
    { key: 'headers', label: 'Headers (JSON)', type: 'json' },
    { key: 'body', label: 'Body (JSON or text)', type: 'json' },
  ] },
  code: { label: 'Code / Transform', icon: Code2, color: '#a855f7', fields: [
    { key: 'language', label: 'Language', type: 'select', options: ['python', 'javascript'] },
    { key: 'code', label: 'Code (use `input`, assign `output`)', type: 'textarea',
      placeholder: "output = {'doubled': input['n'] * 2}" },
  ] },
  if: { label: 'If', icon: GitFork, color: '#f59e0b', fields: [
    { key: 'condition', label: 'Condition (Python expression)', type: 'text', placeholder: "input['status'] == 200" },
  ] },
  loop: { label: 'Loop', icon: Repeat, color: '#14b8a6', fields: [
    { key: 'items_field', label: 'Array field to iterate', type: 'text', placeholder: 'body.items' },
  ] },
  merge: { label: 'Merge', icon: MergeIcon, color: '#64748b', fields: [] },
  llm: { label: 'LLM / Agent', icon: Sparkles, color: '#ec4899', custom: 'llm', fields: [] },
  wait: { label: 'Wait', icon: Timer, color: '#0891b2', fields: [
    { key: 'seconds', label: 'Seconds to wait', type: 'number', placeholder: '5' },
  ] },
  subworkflow: { label: 'Execute Sub-workflow', icon: Workflow, color: '#7c3aed', custom: 'subworkflow', fields: [] },
  respond: { label: 'Respond to Webhook', icon: Reply, color: '#0ea5e9', fields: [
    { key: 'body', label: 'Response body (JSON; defaults to input)', type: 'json' },
  ] },
  noop: { label: 'No Operation', icon: CircleSlash, color: '#94a3b8', fields: [] },
}

const PALETTE = ['http', 'llm', 'code', 'if', 'loop', 'merge', 'wait', 'subworkflow', 'respond', 'noop']

const STATUS_RING = {
  running: 'ring-2 ring-blue-400 animate-pulse',
  success: 'ring-2 ring-green-400',
  failed:  'ring-2 ring-red-400',
}

// ── Custom node ───────────────────────────────────────────────────────────────
function WfNode({ data, selected }) {
  const meta = NODE_META[data.kind] || NODE_META.code
  const Icon = meta.icon
  return (
    <div className={`bg-white rounded-xl border shadow-sm w-[180px] px-3 py-2.5 transition-all
      ${selected ? 'border-indigo-500' : 'border-gray-200'} ${STATUS_RING[data.status] || ''}`}>
      {data.kind !== 'trigger' && <Handle type="target" position={Position.Left} className="!bg-gray-400" />}
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: meta.color + '1a' }}>
          <Icon size={15} style={{ color: meta.color }} />
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-gray-800 truncate">{data.label || meta.label}</div>
          <div className="text-[10px] text-gray-400">{meta.label}</div>
        </div>
      </div>
      {data.kind === 'if' ? (
        <>
          <Handle id="true" type="source" position={Position.Right} style={{ top: '38%' }} className="!bg-green-500" />
          <Handle id="false" type="source" position={Position.Right} style={{ top: '70%' }} className="!bg-red-400" />
        </>
      ) : data.kind === 'loop' ? (
        <>
          <Handle id="loop" type="source" position={Position.Right} style={{ top: '38%' }} className="!bg-teal-500" />
          <Handle id="done" type="source" position={Position.Right} style={{ top: '70%' }} className="!bg-gray-400" />
        </>
      ) : (
        <Handle type="source" position={Position.Right} className="!bg-gray-400" />
      )}
    </div>
  )
}

const nodeTypes = { trigger: WfNode, http: WfNode, code: WfNode, if: WfNode, loop: WfNode,
  merge: WfNode, llm: WfNode, wait: WfNode, subworkflow: WfNode, respond: WfNode, noop: WfNode }

let _seq = 0
const newId = (kind) => `${kind}_${Date.now()}_${_seq++}`

// ── Compliance badge ──────────────────────────────────────────────────────────
function ComplianceBadge({ c }) {
  if (!c) return null
  const map = {
    reviewed:  { icon: ShieldCheck, color: 'text-green-600', label: `Reviewed (${c.level || 'ok'})` },
    blocked:   { icon: ShieldX,     color: 'text-red-600',   label: `Blocked (${c.level || 'high'})` },
    unchecked: { icon: ShieldAlert, color: 'text-amber-600', label: 'Unchecked — no compliance agent' },
    skipped:   { icon: ShieldAlert, color: 'text-gray-400',  label: 'Compliance off' },
    error:     { icon: ShieldAlert, color: 'text-gray-400',  label: 'Review error' },
  }
  const m = map[c.status] || map.skipped
  return <span className={`inline-flex items-center gap-1 text-[11px] ${m.color}`}><m.icon size={12} /> {m.label}</span>
}

function EditorInner({ workflowId, onBack }) {
  const agents = useOrgStore(s => s.agents)
  const getWorkflow = useOrgStore(s => s.getWorkflow)
  const saveWorkflow = useOrgStore(s => s.saveWorkflow)
  const testWorkflow = useOrgStore(s => s.testWorkflow)
  const publishWorkflow = useOrgStore(s => s.publishWorkflow)
  const getRun = useOrgStore(s => s.getRun)
  const wfRun = useOrgStore(s => s.wfRun)
  const [runs, setRuns] = useState([])

  const [name, setName] = useState('')
  const [status, setStatus] = useState('draft')
  const [requireCompliance, setRequireCompliance] = useState(true)
  const [nodes, setNodes] = useState([])
  const [edges, setEdges] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [triggerConfig, setTriggerConfig] = useState({})

  useEffect(() => {
    (async () => {
      const wf = await getWorkflow(workflowId)
      if (!wf) return
      setName(wf.name); setStatus(wf.status); setRequireCompliance(!!wf.require_compliance)
      setTriggerConfig(wf.trigger_config || {})
      setNodes((wf.graph?.nodes || []).map(n => ({ ...n, type: n.type, data: { ...n.data, kind: n.type } })))
      setEdges((wf.graph?.edges || []).map(e => ({
        ...e, id: e.id || `${e.source}-${e.sourceHandle || ''}-${e.target}`, animated: true,
      })))
      setRuns(wf.runs || [])
    })()
  }, [workflowId])

  const webhookUrl = triggerConfig.token
    ? `${window.location.origin}/api/hooks/workflow/${workflowId}?token=${triggerConfig.token}`
    : ''

  // Merge live run status into node visuals.
  const liveNodes = useMemo(() => nodes.map(n => ({
    ...n, data: { ...n.data, status: wfRun?.steps?.[n.id]?.status },
  })), [nodes, wfRun])

  const onNodesChange = useCallback((c) => setNodes(ns => applyNodeChanges(c, ns)), [])
  const onEdgesChange = useCallback((c) => setEdges(es => applyEdgeChanges(c, es)), [])
  const onConnect = useCallback((params) => setEdges(es => addEdge({ ...params, animated: true }, es)), [])

  function addNode(kind) {
    const id = newId(kind)
    setNodes(ns => [...ns, {
      id, type: kind,
      position: { x: 320 + (ns.length % 3) * 60, y: 120 + ns.length * 30 },
      data: { label: NODE_META[kind].label, kind, config: {} },
    }])
    setSelectedId(id)
  }

  function updateNodeConfig(key, value) {
    setNodes(ns => ns.map(n => n.id === selectedId
      ? { ...n, data: { ...n.data, config: { ...(n.data.config || {}), [key]: value } } } : n))
  }
  function updateNodeLabel(value) {
    setNodes(ns => ns.map(n => n.id === selectedId ? { ...n, data: { ...n.data, label: value } } : n))
  }
  function deleteSelected() {
    setEdges(es => es.filter(e => e.source !== selectedId && e.target !== selectedId))
    setNodes(ns => ns.filter(n => n.id !== selectedId))
    setSelectedId(null)
  }

  function buildGraph() {
    return {
      nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data: { label: data.label, config: data.config || {} } })),
      edges,
    }
  }

  async function handleSave() {
    setSaving(true)
    const trigger = nodes.find(n => n.type === 'trigger')
    const tcfg = trigger?.data?.config || {}
    const trigger_type = tcfg.triggerType || 'manual'
    const trigger_config = {}
    if (trigger_type === 'schedule' && tcfg.cron) trigger_config.cron = tcfg.cron
    if (tcfg.sample) trigger_config.payload = tcfg.sample
    await saveWorkflow(workflowId, { name, graph: buildGraph(), require_compliance: requireCompliance, trigger_type, trigger_config })
    setSaving(false)
  }

  async function handleTest() {
    setTesting(true)
    await handleSave()
    const trigger = nodes.find(n => n.type === 'trigger')
    let payload = trigger?.data?.config?.sample || {}
    if (typeof payload === 'string') { try { payload = JSON.parse(payload) } catch { payload = {} } }
    await testWorkflow(workflowId, payload)
    const wf = await getWorkflow(workflowId)
    if (wf?.runs) setRuns(wf.runs)
    setTesting(false)
  }

  async function handlePublish() {
    const live = status !== 'live'
    await handleSave()
    const wf = await publishWorkflow(workflowId, live)
    if (wf?.trigger_config) setTriggerConfig(wf.trigger_config)
    setStatus(live ? 'live' : 'draft')
  }

  const selected = nodes.find(n => n.id === selectedId)
  const runSteps = wfRun?.steps || {}
  const orderedSteps = nodes.map(n => ({ node: n, step: runSteps[n.id] })).filter(x => x.step)

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-100 bg-white">
        <button onClick={onBack} className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-lg"><ArrowLeft size={18} /></button>
        <input value={name} onChange={e => setName(e.target.value)}
          className="text-sm font-medium text-gray-800 bg-transparent border-b border-transparent hover:border-gray-200 focus:border-indigo-400 outline-none px-1 py-0.5 min-w-[200px]" />
        <label className="flex items-center gap-1.5 text-xs text-gray-500 ml-2 cursor-pointer">
          <input type="checkbox" checked={requireCompliance} onChange={e => setRequireCompliance(e.target.checked)} />
          Require compliance review
        </label>
        <div className="flex-1" />
        <button onClick={handleTest} disabled={testing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50 disabled:opacity-50">
          {testing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Test
        </button>
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
        </button>
        <button onClick={handlePublish}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-white ${status === 'live' ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-800 hover:bg-gray-900'}`}>
          <Globe size={14} /> {status === 'live' ? 'Live' : 'Publish'}
        </button>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Canvas */}
        <div className="flex-1 relative">
          <ReactFlow nodes={liveNodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)} onPaneClick={() => setSelectedId(null)}
            fitView proOptions={{ hideAttribution: true }}>
            <Background color="#e5e7eb" gap={18} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!bg-gray-50" />
          </ReactFlow>

          {/* Palette */}
          <div className="absolute top-3 right-3 bg-white border border-gray-200 rounded-xl shadow-sm p-2 w-44">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 px-1 pb-1">Add node</p>
            {PALETTE.map(kind => {
              const m = NODE_META[kind]; const Icon = m.icon
              return (
                <button key={kind} onClick={() => addNode(kind)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-gray-700 rounded-lg hover:bg-gray-50">
                  <span className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: m.color + '1a' }}>
                    <Icon size={13} style={{ color: m.color }} />
                  </span>
                  {m.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Config drawer */}
        {selected && (
          <div className="w-80 border-l border-gray-100 bg-white flex flex-col overflow-y-auto">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <span className="text-sm font-semibold text-gray-800">{NODE_META[selected.data.kind]?.label} settings</span>
              <button onClick={() => setSelectedId(null)} className="text-gray-400 hover:text-gray-700"><X size={16} /></button>
            </div>
            <div className="p-4 space-y-3">
              <Field label="Label" type="text" value={selected.data.label || ''} onChange={updateNodeLabel} />
              {NODE_META[selected.data.kind]?.custom === 'llm' && (
                <LlmConfig config={selected.data.config || {}} agents={agents} onChange={updateNodeConfig} />
              )}
              {NODE_META[selected.data.kind]?.custom === 'subworkflow' && (
                <SubworkflowConfig config={selected.data.config || {}} currentId={workflowId} onChange={updateNodeConfig} />
              )}
              {(NODE_META[selected.data.kind]?.fields || []).map(f => (
                <Field key={f.key} {...f}
                  agents={agents}
                  value={selected.data.config?.[f.key] ?? ''}
                  onChange={(v) => updateNodeConfig(f.key, v)} />
              ))}
              {selected.data.kind === 'trigger' && selected.data.config?.triggerType === 'webhook' && (
                <div className="pt-1">
                  <label className="block text-[11px] font-medium text-gray-500 mb-1">Webhook URL</label>
                  {webhookUrl ? (
                    <div className="flex items-center gap-1.5">
                      <code className="flex-1 text-[10px] bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 break-all">{webhookUrl}</code>
                      <button onClick={() => navigator.clipboard?.writeText(webhookUrl)}
                        className="p-1.5 text-gray-400 hover:text-indigo-600" title="Copy"><Copy size={14} /></button>
                    </div>
                  ) : (
                    <p className="text-[11px] text-amber-600">Publish the workflow to generate its webhook URL.</p>
                  )}
                </div>
              )}
              {selected.data.kind !== 'trigger' && (
                <button onClick={deleteSelected} className="text-xs text-red-500 hover:underline">Delete node</button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Run panel */}
      {wfRun && (
        <div className="border-t border-gray-100 bg-gray-50 max-h-56 overflow-y-auto">
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-gray-500 sticky top-0 bg-gray-50">
            <span className="font-semibold uppercase tracking-wide">Run</span>
            <RunStatus status={wfRun.status} />
            {runs.length > 0 && (
              <select value={wfRun.runId || ''} onChange={e => e.target.value && getRun(e.target.value)}
                className="ml-auto text-[11px] border border-gray-200 rounded-md px-1.5 py-0.5 bg-white">
                {!wfRun.runId && <option value="">current</option>}
                {runs.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.mode} · {r.status} · {(r.started_at || '').replace('T', ' ').slice(5, 16)}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="px-4 pb-3 space-y-1.5">
            {orderedSteps.length === 0 && <p className="text-xs text-gray-400">Running…</p>}
            {orderedSteps.map(({ node, step }) => (
              <div key={node.id} className="flex items-start gap-2 text-xs bg-white border border-gray-100 rounded-lg px-3 py-2">
                <RunStatus status={step.status} small />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-700">{node.data.label}</span>
                    {step.compliance && <ComplianceBadge c={step.compliance} />}
                  </div>
                  {step.error
                    ? <p className="text-red-500 mt-0.5 break-words">{step.error}</p>
                    : <pre className="text-gray-500 mt-0.5 whitespace-pre-wrap break-words max-h-20 overflow-y-auto">{JSON.stringify(step.output, null, 0)?.slice(0, 400)}</pre>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function RunStatus({ status, small }) {
  const sz = small ? 13 : 14
  if (status === 'running') return <Loader2 size={sz} className="text-blue-500 animate-spin shrink-0" />
  if (status === 'success') return <CheckCircle2 size={sz} className="text-green-500 shrink-0" />
  if (status === 'failed')  return <AlertCircle size={sz} className="text-red-500 shrink-0" />
  return <span className="text-gray-400">{status}</span>
}

function LlmConfig({ config, agents, onChange }) {
  const providers = useOrgStore(s => s.providers)
  const loadProviders = useOrgStore(s => s.loadProviders)
  const getProviderModels = useOrgStore(s => s.getProviderModels)
  const [models, setModels] = useState([])
  useEffect(() => { loadProviders() }, [])
  useEffect(() => {
    if (config.api_provider_id) getProviderModels(config.api_provider_id).then(setModels)
    else setModels([])
  }, [config.api_provider_id])
  const base = "w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-400"
  return (
    <>
      <div>
        <label className="block text-[11px] font-medium text-gray-500 mb-1">Agent (identity & compliance)</label>
        <select value={config.agent_id || ''} onChange={e => onChange('agent_id', e.target.value)} className={base}>
          <option value="">Auto (first non-manager)</option>
          {(agents || []).map(a => <option key={a.config.id} value={a.config.id}>{a.config.name}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-gray-500 mb-1">Provider (override)</label>
        <select value={config.api_provider_id || ''} onChange={e => { onChange('api_provider_id', e.target.value); onChange('model', '') }} className={base}>
          <option value="">Use the agent's provider</option>
          {(providers || []).map(p => <option key={p.id} value={p.id}>{p.name} ({p.provider})</option>)}
        </select>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-gray-500 mb-1">Model</label>
        <input list="wf-models" value={config.model || ''} placeholder={config.api_provider_id ? 'Select or type a model' : "Agent's default model"}
          onChange={e => onChange('model', e.target.value)} className={base} />
        <datalist id="wf-models">{models.map(m => <option key={m} value={m} />)}</datalist>
      </div>
      <Field label="System prompt" type="textarea" value={config.system || ''} placeholder="You are a helpful assistant…" onChange={v => onChange('system', v)} />
      <Field label="Prompt (templates: {{nodeId.field}})" type="textarea" value={config.prompt || ''} onChange={v => onChange('prompt', v)} />
      <Field label="Max tokens" type="number" value={config.max_tokens ?? ''} onChange={v => onChange('max_tokens', v)} />
    </>
  )
}

function SubworkflowConfig({ config, currentId, onChange }) {
  const workflows = useOrgStore(s => s.workflows)
  const loadWorkflows = useOrgStore(s => s.loadWorkflows)
  useEffect(() => { loadWorkflows() }, [])
  const base = "w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-400"
  return (
    <div>
      <label className="block text-[11px] font-medium text-gray-500 mb-1">Workflow to run</label>
      <select value={config.workflow_id || ''} onChange={e => onChange('workflow_id', e.target.value)} className={base}>
        <option value="">— select —</option>
        {(workflows || []).filter(w => w.id !== currentId).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
      <p className="text-[11px] text-gray-400 mt-1">The current input is passed to the sub-workflow's trigger; its final output is returned.</p>
    </div>
  )
}

function Field({ label, type, value, onChange, options, placeholder, agents }) {
  const base = "w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-400"
  let input
  if (type === 'select') {
    input = <select value={value} onChange={e => onChange(e.target.value)} className={base}>
      <option value="">—</option>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  } else if (type === 'agent') {
    input = <select value={value} onChange={e => onChange(e.target.value)} className={base}>
      <option value="">Auto (first non-manager)</option>
      {(agents || []).map(a => <option key={a.config.id} value={a.config.id}>{a.config.name}</option>)}
    </select>
  } else if (type === 'textarea' || type === 'json') {
    const val = typeof value === 'object' ? JSON.stringify(value, null, 2) : (value ?? '')
    input = <textarea value={val} placeholder={placeholder} rows={type === 'json' ? 4 : 5}
      onChange={e => {
        if (type === 'json') { try { onChange(JSON.parse(e.target.value)) } catch { onChange(e.target.value) } }
        else onChange(e.target.value)
      }}
      className={`${base} font-mono text-xs resize-y`} />
  } else if (type === 'number') {
    input = <input type="number" value={value} placeholder={placeholder}
      onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} className={base} />
  } else {
    input = <input type="text" value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} className={base} />
  }
  return <div><label className="block text-[11px] font-medium text-gray-500 mb-1">{label}</label>{input}</div>
}

export default function WorkflowEditor(props) {
  return <ReactFlowProvider><EditorInner {...props} /></ReactFlowProvider>
}
