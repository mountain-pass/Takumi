/**
 * WorkflowEditor — visual node canvas (React Flow) for building a workflow.
 *
 * Nodes are grouped into categories (Trigger / Core / Flow / Data transformation
 * / AI / Human-in-the-loop) and added from a searchable slide-over palette.
 * Nodes can be renamed inline, branch to multiple outputs (If / Switch / Loop),
 * and reference any upstream node's output via {{nodeId.field}} templates — the
 * config drawer surfaces a data picker of every ancestor node's last output.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, applyNodeChanges, applyEdgeChanges, Handle, Position, useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  ArrowLeft, Save, Play, Globe, Code2, GitFork, Repeat, Merge as MergeIcon,
  Sparkles, Hand, Loader2, CheckCircle2, AlertCircle, ShieldCheck, ShieldAlert,
  ShieldX, X, Copy, Timer, Workflow, Reply, CircleSlash, Plus, Search, Pencil,
  Split, Filter as FilterIcon, OctagonAlert, SlidersHorizontal, CalendarClock, Clock,
  UserCheck, Zap, Trash2, ChevronRight, ChevronLeft, ChevronDown, Hash, Type as TypeIcon,
  ToggleLeft, Braces, Brackets, GripVertical, Info,
} from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'

// ── Node-type catalogue ───────────────────────────────────────────────────────
// Each node: { label, desc, icon, color, fields, custom?, outputs?(node)=>handles }
const NODE_META = {
  trigger: { label: 'Trigger', desc: 'Entry point — manual, schedule, webhook or agent', icon: Zap, color: '#6366f1', custom: 'trigger', fields: [] },
  http: { label: 'HTTP Request', desc: 'Make an API call and use the response', icon: Globe, color: '#0ea5e9', custom: 'http', fields: [] },
  code: { label: 'Code', desc: 'Run custom Python or JavaScript', icon: Code2, color: '#a855f7', custom: 'code', fields: [] },
  set: { label: 'Edit Fields', desc: 'Add, set or override fields on the item', icon: SlidersHorizontal, color: '#8b5cf6', fields: [
    { key: 'assignments', label: 'Fields to set (JSON: name → value/template)', type: 'json',
      placeholder: '{ "name": "{{trigger.first}}", "total": "{{http.body.amount}}" }' },
    { key: 'keep_only', label: 'Keep only the fields set above', type: 'checkbox' },
  ] },
  datetime: { label: 'Date & Time', desc: 'Get or transform a timestamp', icon: CalendarClock, color: '#0d9488', fields: [
    { key: 'action', label: 'Action', type: 'select', options: ['now', 'format', 'add'] },
    { key: 'value', label: 'Source value (for format/add)', type: 'text', placeholder: '{{trigger.created_at}}' },
    { key: 'format', label: 'Output format (for format)', type: 'text', placeholder: '%Y-%m-%d' },
    { key: 'seconds', label: 'Offset seconds (for add)', type: 'number' },
  ] },
  if: { label: 'If', desc: 'Route to true / false branches', icon: GitFork, color: '#f59e0b', fields: [
    { key: 'condition', label: 'Condition (Python expression)', type: 'text', placeholder: "input['status'] == 200" },
  ] },
  switch: { label: 'Switch', desc: 'Route to many outputs by ordered rules', icon: Split, color: '#f97316', custom: 'switch', fields: [] },
  loop: { label: 'Loop Over Items', desc: 'Iterate an array; run the body per item', icon: Repeat, color: '#14b8a6', fields: [
    { key: 'items_field', label: 'Array field to iterate', type: 'text', placeholder: 'body.items' },
  ] },
  merge: { label: 'Merge', desc: 'Combine multiple inputs into one', icon: MergeIcon, color: '#64748b', fields: [] },
  filter: { label: 'Filter', desc: 'Continue only if the condition holds', icon: FilterIcon, color: '#22c55e', fields: [
    { key: 'condition', label: 'Keep when (Python expression)', type: 'text', placeholder: "input['amount'] > 0" },
  ] },
  stop_error: { label: 'Stop and Error', desc: 'Throw an error and fail the run', icon: OctagonAlert, color: '#ef4444', fields: [
    { key: 'message', label: 'Error message', type: 'text', placeholder: 'Payload was invalid' },
  ] },
  wait: { label: 'Wait', desc: 'Pause before continuing', icon: Timer, color: '#0891b2', fields: [
    { key: 'seconds', label: 'Seconds to wait', type: 'number', placeholder: '5' },
  ] },
  subworkflow: { label: 'Execute Sub-workflow', desc: 'Run another workflow and use its output', icon: Workflow, color: '#7c3aed', custom: 'subworkflow', fields: [] },
  respond: { label: 'Respond to Webhook', desc: 'Return data to the webhook caller', icon: Reply, color: '#0ea5e9', fields: [
    { key: 'body', label: 'Response body (JSON; defaults to input)', type: 'json' },
  ] },
  noop: { label: 'No Operation', desc: 'Do nothing — pass input through', icon: CircleSlash, color: '#94a3b8', fields: [] },
  llm: { label: 'AI Agent / LLM', desc: 'Run a prompt through an agent & model', icon: Sparkles, color: '#ec4899', custom: 'llm', fields: [] },
  error_trigger: { label: 'Error Trigger', desc: 'Catch-all — runs when any node fails', icon: OctagonAlert, color: '#dc2626', entry: true, fields: [] },
}

// Palette grouping (n8n-style categories).
const CATEGORIES = [
  { id: 'trigger', label: 'Add Trigger', hint: 'How this workflow starts', kinds: ['trigger', 'error_trigger'] },
  { id: 'core', label: 'Core', kinds: ['http', 'code', 'respond', 'subworkflow', 'wait', 'noop'] },
  { id: 'flow', label: 'Flow', kinds: ['if', 'switch', 'loop', 'merge', 'filter', 'stop_error'] },
  { id: 'transform', label: 'Data transformation', kinds: ['set', 'datetime', 'code'] },
  { id: 'ai', label: 'AI', kinds: ['llm'] },
  { id: 'hitl', label: 'Human in the loop', hint: 'Coming soon', kinds: [], comingSoon: true },
]

const STATUS_RING = {
  running: 'ring-2 ring-blue-400 animate-pulse',
  success: 'ring-2 ring-green-400',
  failed:  'ring-2 ring-red-400',
}

// Right-side output handles for a node (supports multi-output if / switch / loop).
function outputHandles(data) {
  if (data.kind === 'if') return [{ id: 'true', label: 'true', color: '#22c55e' }, { id: 'false', label: 'false', color: '#f87171' }]
  if (data.kind === 'loop') return [{ id: 'loop', label: 'loop', color: '#14b8a6' }, { id: 'done', label: 'done', color: '#94a3b8' }]
  if (data.kind === 'switch') {
    const rules = (data.config?.rules || [])
    return [...rules.map((r, i) => ({ id: String(i), label: r.label || `rule ${i}`, color: '#f97316' })),
            { id: 'default', label: 'default', color: '#94a3b8' }]
  }
  if (data.kind === 'filter') return [{ id: 'source', label: '', color: '#9ca3af' }]
  return [{ id: 'source', label: '', color: '#9ca3af' }]
}

// ── Custom node ───────────────────────────────────────────────────────────────
function WfNode({ id, data, selected }) {
  const meta = NODE_META[data.kind] || NODE_META.code
  const Icon = meta.icon
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(data.label || meta.label)
  const handles = outputHandles(data)
  const multi = handles.length > 1
  // Grow the box so every output handle gets its own row (≈26px each) instead of
  // cramming together and spilling below the node.
  const minHeight = multi ? handles.length * 26 + 12 : undefined

  function commit() {
    setEditing(false)
    if (data.onRename) data.onRename(id, draft.trim() || meta.label)
  }

  return (
    <div style={{ minHeight }} className={`bg-white rounded-xl border shadow-sm w-[190px] px-3 py-2.5 transition-all
      ${selected ? 'border-indigo-500 shadow-md' : 'border-gray-200'} ${STATUS_RING[data.status] || ''}`}>
      {!NODE_META[data.kind]?.entry && data.kind !== 'trigger' && <Handle type="target" position={Position.Left} className="!w-2.5 !h-2.5 !bg-gray-300 !border-2 !border-white" />}
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: meta.color + '1a' }}>
          <Icon size={15} style={{ color: meta.color }} />
        </div>
        <div className="min-w-0 flex-1">
          {editing ? (
            <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
              onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
              className="w-full text-[13px] font-medium text-gray-800 border-b border-indigo-400 outline-none bg-transparent" />
          ) : (
            <div className="group flex items-center gap-1">
              <span className="text-[13px] font-medium text-gray-800 truncate">{data.label || meta.label}</span>
              <button onDoubleClick={e => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setDraft(data.label || meta.label); setEditing(true) }}
                className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-indigo-500 shrink-0"><Pencil size={11} /></button>
            </div>
          )}
          <div className="text-[10px] text-gray-400 truncate">{meta.label}</div>
        </div>
      </div>
      {/* Output handles */}
      {handles.map((h, i) => {
        const top = multi ? `${(100 / (handles.length + 1)) * (i + 1)}%` : '50%'
        return (
          <React.Fragment key={h.id}>
            <Handle id={h.id === 'source' ? undefined : h.id} type="source" position={Position.Right}
              style={{ top }} className="!w-2.5 !h-2.5 !border-2 !border-white"
              // color via inline style on the handle dot
            />
            {h.label && (
              <span className="absolute text-[9px] text-gray-400 pointer-events-none"
                style={{ top: `calc(${top} - 7px)`, right: -4, transform: 'translateX(100%)' }}>{h.label}</span>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

const nodeTypes = Object.fromEntries(Object.keys(NODE_META).map(k => [k, WfNode]))

let _seq = 0
const newId = (kind) => `${kind}_${Date.now()}_${_seq++}`

// The workflow's effective trigger node (prefer one with a configured non-manual type).
function pickTrigger(nodes) {
  const triggers = nodes.filter(n => n.type === 'trigger')
  return triggers.find(t => { const tt = t.data?.config?.triggerType; return tt && tt !== 'manual' }) || triggers[0]
}

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
  const rf = useReactFlow()
  const agents = useOrgStore(s => s.agents)
  const getWorkflow = useOrgStore(s => s.getWorkflow)
  const saveWorkflow = useOrgStore(s => s.saveWorkflow)
  const testWorkflow = useOrgStore(s => s.testWorkflow)
  const publishWorkflow = useOrgStore(s => s.publishWorkflow)
  const getRun = useOrgStore(s => s.getRun)
  const executeStep = useOrgStore(s => s.executeStep)
  const stopTest = useOrgStore(s => s.stopTest)
  const wfRun = useOrgStore(s => s.wfRun)
  const [runs, setRuns] = useState([])
  const [stepping, setStepping] = useState(false)

  const [name, setName] = useState('')
  const [status, setStatus] = useState('draft')
  const [requireCompliance, setRequireCompliance] = useState(true)
  const [nodes, setNodes] = useState([])
  const [edges, setEdges] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [editingId, setEditingId] = useState(null)   // node open in the detail view (NDV)
  const [tab, setTab] = useState('editor')            // 'editor' | 'executions'
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [triggerConfig, setTriggerConfig] = useState({})
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [focusedKey, setFocusedKey] = useState(null)
  const [showDocs, setShowDocs] = useState(false)
  const [waitingHook, setWaitingHook] = useState(false)

  const renameNode = useCallback((id, label) => {
    setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, label } } : n))
  }, [])

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

  // Merge live run status + the rename callback into node visuals.
  const liveNodes = useMemo(() => nodes.map(n => ({
    ...n, data: { ...n.data, status: wfRun?.steps?.[n.id]?.status, onRename: renameNode },
  })), [nodes, wfRun, renameNode])

  const onNodesChange = useCallback((c) => setNodes(ns => applyNodeChanges(c, ns)), [])
  const onEdgesChange = useCallback((c) => setEdges(es => applyEdgeChanges(c, es)), [])
  const onConnect = useCallback((params) => setEdges(es => addEdge({ ...params, animated: true }, es)), [])

  function addNode(kind) {
    const id = newId(kind)
    const cfg = kind === 'switch' ? { rules: [{ condition: '', label: '' }] } : {}
    // Drop the node at the center of whatever the user is currently viewing.
    let position = { x: 360, y: 160 }
    const pane = document.querySelector('.react-flow')
    if (pane && rf?.screenToFlowPosition) {
      const r = pane.getBoundingClientRect()
      const c = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      position = { x: c.x - 95, y: c.y - 30 }   // offset by ~half node size so it lands centered
    }
    setNodes(ns => [...ns, {
      id, type: kind, position,
      data: { label: NODE_META[kind].label, kind, config: cfg },
    }])
    setSelectedId(id)       // place + select on the canvas; double-click opens its detail view
    setPaletteOpen(false)
  }

  function updateNodeConfig(key, value) {
    setNodes(ns => ns.map(n => n.id === editingId
      ? { ...n, data: { ...n.data, config: { ...(n.data.config || {}), [key]: value } } } : n))
  }
  function updateNodeLabel(value) {
    setNodes(ns => ns.map(n => n.id === editingId ? { ...n, data: { ...n.data, label: value } } : n))
  }
  function deleteEditing() {
    setEdges(es => es.filter(e => e.source !== editingId && e.target !== editingId))
    setNodes(ns => ns.filter(n => n.id !== editingId))
    setEditingId(null)
  }

  // Insert an {{token}} into the currently focused config field.
  function insertToken(token) {
    if (!focusedKey || !editing) return
    const cur = editing.data.config?.[focusedKey]
    if (cur != null && typeof cur !== 'string') return
    updateNodeConfig(focusedKey, `${cur || ''}${token}`)
  }

  function buildGraph() {
    return {
      nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data: { label: data.label, config: data.config || {} } })),
      edges: edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle })),
    }
  }

  async function handleSave() {
    setSaving(true)
    const trigger = pickTrigger(nodes)
    const tcfg = trigger?.data?.config || {}
    const trigger_type = tcfg.triggerType || 'manual'
    const trigger_config = { ...triggerConfig }
    if (trigger_type === 'schedule') trigger_config.cron = scheduleToCron(tcfg.schedule)
    if (tcfg.sample) trigger_config.payload = tcfg.sample
    const wf = await saveWorkflow(workflowId, { name, graph: buildGraph(), require_compliance: requireCompliance, trigger_type, trigger_config })
    if (wf?.trigger_config) setTriggerConfig(wf.trigger_config)   // pick up server-minted webhook token
    setSaving(false)
  }

  async function handleTest() {
    setTesting(true)
    await handleSave()
    const trigger = pickTrigger(nodes)
    let payload = trigger?.data?.config?.sample || {}
    if (typeof payload === 'string') { try { payload = JSON.parse(payload) } catch { payload = {} } }
    const willWait = trigger?.data?.config?.triggerType === 'webhook' && !trigger?.data?.config?.sample
    setWaitingHook(willWait)
    const d = await testWorkflow(workflowId, payload)
    setWaitingHook(false)
    const wf = await getWorkflow(workflowId)
    if (wf?.runs) setRuns(wf.runs)
    setTesting(false)
    if (d?.timeout) alert(d.message)
  }

  async function handlePublish() {
    const live = status !== 'live'
    await handleSave()
    const wf = await publishWorkflow(workflowId, live)
    if (wf?.trigger_config) setTriggerConfig(wf.trigger_config)
    setStatus(live ? 'live' : 'draft')
  }

  // Execute up to (and including) one node, so its INPUT/OUTPUT populate.
  async function handleStep(nodeId) {
    setStepping(true)
    await handleSave()
    const trigger = pickTrigger(nodes)
    let payload = trigger?.data?.config?.sample || {}
    if (typeof payload === 'string') { try { payload = JSON.parse(payload) } catch { payload = {} } }
    const willWait = trigger?.data?.config?.triggerType === 'webhook' && !trigger?.data?.config?.sample
    setWaitingHook(willWait)
    await executeStep(workflowId, nodeId, payload)
    setWaitingHook(false)
    setStepping(false)
  }

  // Cancel a test/step that's waiting for a webhook call.
  async function handleStop() {
    await stopTest(workflowId)
    setWaitingHook(false)
  }

  const editing = nodes.find(n => n.id === editingId)
  const runSteps = wfRun?.steps || {}
  const orderedSteps = nodes.map(n => ({ node: n, step: runSteps[n.id] })).filter(x => x.step)

  async function refreshRuns() {
    const wf = await getWorkflow(workflowId)
    if (wf?.runs) setRuns(wf.runs)
  }

  // Ancestors of the node being edited (for the data picker).
  const ancestors = useMemo(() => {
    if (!editing) return []
    const incoming = {}
    edges.forEach(e => { (incoming[e.target] = incoming[e.target] || []).push(e.source) })
    const seen = new Set(); const stack = [...(incoming[editing.id] || [])]
    while (stack.length) {
      const n = stack.pop()
      if (seen.has(n)) continue
      seen.add(n)
      ;(incoming[n] || []).forEach(s => stack.push(s))
    }
    return nodes.filter(n => seen.has(n.id))
  }, [editing, nodes, edges])

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-100 bg-white">
        <button onClick={onBack} className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-lg"><ArrowLeft size={18} /></button>
        <input value={name} onChange={e => setName(e.target.value)}
          className="text-sm font-semibold text-gray-800 bg-transparent border-b border-transparent hover:border-gray-200 focus:border-indigo-400 outline-none px-1 py-0.5 min-w-[180px]" />
        <button onClick={() => setShowDocs(true)} title="How workflows work"
          className="p-1 text-gray-400 hover:text-indigo-600"><Info size={16} /></button>
        {/* Editor / Executions tabs */}
        <div className="flex items-center gap-1 ml-2 bg-gray-100 rounded-lg p-0.5">
          {['editor', 'executions'].map(t => (
            <button key={t} onClick={() => { setTab(t); if (t === 'executions') refreshRuns() }}
              className={`px-3 py-1 text-xs font-medium rounded-md capitalize ${tab === t ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>{t}</button>
          ))}
        </div>
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
        {status === 'live' && (
          <span className="flex items-center gap-1.5 px-2 py-1 text-xs font-semibold text-green-700 bg-green-50 border border-green-200 rounded-lg">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> LIVE
          </span>
        )}
        <button onClick={handlePublish}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg ${status === 'live' ? 'text-gray-700 border border-gray-200 hover:bg-gray-50' : 'text-white bg-gray-800 hover:bg-gray-900'}`}>
          <Globe size={14} /> {status === 'live' ? 'Unpublish' : 'Publish'}
        </button>
      </div>

      {waitingHook && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-800">
          <Loader2 size={14} className="animate-spin shrink-0" />
          <span>Listening for a call to the webhook URL (up to 60s)…</span>
          {webhookUrl && <>
            <code className="ml-1 bg-white border border-amber-200 rounded px-1.5 py-0.5 truncate max-w-md">{webhookUrl}</code>
            <button onClick={() => navigator.clipboard?.writeText(webhookUrl)} className="text-amber-700 hover:text-amber-900" title="Copy"><Copy size={13} /></button>
          </>}
          <div className="flex-1" />
          <button onClick={handleStop}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-800 bg-white border border-amber-300 rounded-lg hover:bg-amber-100">
            <X size={13} /> Stop
          </button>
        </div>
      )}

      {tab === 'executions' ? (
        <ExecutionsView runs={runs} nodes={nodes} wfRun={wfRun} getRun={getRun} onRefresh={refreshRuns} workflowId={workflowId} />
      ) : (
      <div className="flex-1 flex min-h-0">
        {/* Canvas */}
        <div className="flex-1 relative">
          <ReactFlow nodes={liveNodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)} onNodeDoubleClick={(_, n) => setEditingId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView proOptions={{ hideAttribution: true }} defaultEdgeOptions={{ animated: true }}>
            <Background color="#e5e7eb" gap={18} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!bg-gray-50" />
          </ReactFlow>

          <button onClick={() => setPaletteOpen(true)}
            className="absolute top-3 right-3 flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg shadow-sm">
            <Plus size={16} /> Add node
          </button>

          {paletteOpen && <NodePalette onAdd={addNode} onClose={() => setPaletteOpen(false)} />}

          {editing && (
            <NodeDetail
              key={editing.id} node={editing} agents={agents} workflowId={workflowId}
              ancestors={ancestors} steps={runSteps} step={runSteps[editing.id]}
              webhookUrl={webhookUrl} stepping={stepping} focusedKey={focusedKey}
              onClose={() => setEditingId(null)} onRename={updateNodeLabel}
              onConfig={updateNodeConfig} onFocusField={setFocusedKey}
              onInsert={insertToken} onDelete={deleteEditing} onStep={() => handleStep(editing.id)}
              onStop={handleStop}
              prevNodes={(() => { const ids = [...new Set(edges.filter(e => e.target === editing.id).map(e => e.source))]; return ids.map(id => nodes.find(n => n.id === id)).filter(Boolean) })()}
              nextNodes={(() => { const ids = [...new Set(edges.filter(e => e.source === editing.id).map(e => e.target))]; return ids.map(id => nodes.find(n => n.id === id)).filter(Boolean) })()}
              onNavigate={setEditingId}
            />
          )}
        </div>
      </div>
      )}

      {showDocs && <WorkflowDocs onClose={() => setShowDocs(false)} />}
    </div>
  )
}

// ── Docs modal ────────────────────────────────────────────────────────────────
function WorkflowDocs({ onClose }) {
  const Section = ({ title, children }) => (
    <div className="mb-5">
      <h3 className="text-sm font-semibold text-gray-800 mb-1.5">{title}</h3>
      <div className="text-[13px] text-gray-600 space-y-1.5 leading-relaxed">{children}</div>
    </div>
  )
  const Code = ({ children }) => <code className="text-[12px] bg-gray-100 px-1 py-0.5 rounded text-indigo-600">{children}</code>
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2"><Info size={18} className="text-indigo-600" /> Using Workflows</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          <Section title="What is a workflow?">
            A workflow is a graph of <b>nodes</b> that runs from a <b>trigger</b>. Each node takes the
            output of the nodes before it, does something, and passes its output on. Build it on the
            canvas, <b>Test</b> it, then <b>Publish</b> to run it live.
          </Section>
          <Section title="Triggers (how it starts)">
            <p>The first node is a trigger. Types: <b>Manual</b> (Test only), <b>Schedule</b> (cron), <b>Webhook</b> (a public URL — shown after you Publish), and <b>Agent</b> (an org agent calls it with the <Code>run_workflow</Code> skill).</p>
          </Section>
          <Section title="Adding & connecting nodes">
            <p>Click <b>Add node</b> to pick from Core, Flow, Data transformation, AI, etc. Drag from a node's right dot to another's left dot to connect. <b>If</b> / <b>Switch</b> / <b>Loop</b> have multiple outputs.</p>
            <p>Single-click selects a node; <b>double-click</b> opens its detail view (Input · Parameters · Output). Rename inline with the pencil.</p>
          </Section>
          <Section title="Using data from previous nodes">
            <p>In the node detail view, the <b>Input</b> pane (left) lists every upstream node's output. <b>Drag a field</b> into a parameter box, or click it, to insert a reference like <Code>{'{{HTTP Request.body.id}}'}</Code>. Tokens resolve at run time and work by node name.</p>
          </Section>
          <Section title="Code node">
            <p>Choose <b>Python</b> or <b>JavaScript</b>. <Code>input</Code> is the incoming data, <Code>context</Code> holds every node's output. Produce a result with <Code>return {'{...}'}</Code> (or set <Code>output</Code>). Dragged <Code>{'{{tokens}}'}</Code> are replaced with literal values before running. Use <b>Format</b> to tidy the code.</p>
          </Section>
          <Section title="AI / Agent node & compliance">
            <p>The AI node runs a prompt through an org agent — optionally overriding the provider & model. If <b>Require compliance review</b> is on, the org's Risk & Compliance agent assesses the output; with no such agent the step is flagged <b>unchecked</b> but still runs.</p>
          </Section>
          <Section title="Error handling">
            <p>Add an <b>Error Trigger</b> node (Add Trigger group). It sits outside the normal flow and runs only when any node fails, receiving <Code>{'{{Error Trigger.error}}'}</Code> so you can notify, log, or recover.</p>
          </Section>
          <Section title="Testing & executions">
            <p><b>Test</b> runs the whole workflow; <b>Execute step</b> (in a node) runs up to that node so you can inspect its input/output. The <b>Executions</b> tab lists every run with its time, duration and per-step detail.</p>
          </Section>
        </div>
      </div>
    </div>
  )
}

// ── Executions view (run history + step detail) ───────────────────────────────
// SQLite stores UTC ('YYYY-MM-DD HH:MM:SS', no tz). Parse as UTC for math/display.
function asUTC(ts) {
  if (!ts) return null
  const norm = ts.includes('T') ? ts : ts.replace(' ', 'T')
  return new Date(/(Z|[+-]\d\d:?\d\d)$/.test(norm) ? norm : norm + 'Z')
}
function fmtDuration(a, b) {
  const da = asUTC(a), db = asUTC(b)
  if (!da || !db) return ''
  const ms = db - da
  if (isNaN(ms)) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
function fmtLocal(ts) {
  const d = asUTC(ts)
  return d && !isNaN(d) ? d.toLocaleString() : (ts || '')
}

function ExecutionsView({ runs, nodes, wfRun, getRun, onRefresh, workflowId }) {
  const deleteRun = useOrgStore(s => s.deleteRun)
  const deleteAllRuns = useOrgStore(s => s.deleteAllRuns)
  const [selId, setSelId] = useState(runs[0]?.id || null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (selId) getRun(selId) }, [selId])
  // Auto-select the newest run (e.g. right after a Test) so its output shows.
  useEffect(() => { if (runs[0]) setSelId(runs[0].id) }, [runs[0]?.id])

  async function handleDelete(id, e) {
    e.stopPropagation()
    setBusy(true)
    await deleteRun(id)
    if (selId === id) setSelId(null)
    await onRefresh()
    setBusy(false)
  }
  async function handleDeleteAll() {
    if (!window.confirm(`Delete all ${runs.length} execution${runs.length === 1 ? '' : 's'}? This can't be undone.`)) return
    setBusy(true)
    await deleteAllRuns(workflowId)
    setSelId(null)
    await onRefresh()
    setBusy(false)
  }
  const matched = wfRun && wfRun.runId === selId ? wfRun : null
  const steps = matched ? matched.steps : {}
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]))
  // Show steps in the order they actually executed (graph/flow order), not node-array order.
  const orderIds = matched?.order?.length ? matched.order : nodes.map(n => n.id)
  const ordered = orderIds.map(id => ({ node: byId[id], step: steps[id] })).filter(x => x.node && x.step)
  return (
    <div className="flex-1 flex min-h-0">
      <aside className="w-72 border-r border-gray-100 overflow-y-auto shrink-0">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
          <span className="text-sm font-semibold text-gray-800">Executions</span>
          <div className="flex items-center gap-3">
            <button onClick={onRefresh} disabled={busy} className="text-xs text-indigo-600 hover:underline disabled:opacity-50">Refresh</button>
            {runs.length > 0 && (
              <button onClick={handleDeleteAll} disabled={busy} className="text-xs text-red-500 hover:underline disabled:opacity-50">Delete all</button>
            )}
          </div>
        </div>
        {runs.length === 0 && <p className="text-xs text-gray-400 p-4">No runs yet — hit Test.</p>}
        {runs.map(r => (
          <div key={r.id} onClick={() => setSelId(r.id)}
            className={`group w-full text-left px-4 py-2.5 border-b border-gray-50 cursor-pointer flex items-start gap-2 ${selId === r.id ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <RunStatus status={r.status} small />
                <span className="text-xs font-medium text-gray-700">{fmtLocal(r.started_at)}</span>
              </div>
              <div className="text-[11px] text-gray-400 ml-5">{r.mode} · {r.trigger_source} · {fmtDuration(r.started_at, r.finished_at) || '—'}</div>
            </div>
            <button onClick={(e) => handleDelete(r.id, e)} disabled={busy} title="Delete execution"
              className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 shrink-0 mt-0.5 disabled:opacity-50"><Trash2 size={13} /></button>
          </div>
        ))}
      </aside>
      <main className="flex-1 overflow-y-auto p-5">
        {!selId ? <p className="text-sm text-gray-400">Select an execution to see its steps.</p> : (
          <div className="space-y-2 max-w-3xl">
            {ordered.length === 0 && <p className="text-sm text-gray-400">Loading steps…</p>}
            {ordered.map(({ node, step }) => (
              <div key={node.id} className="bg-white border border-gray-200 rounded-xl px-4 py-3">
                <div className="flex items-center gap-2">
                  <RunStatus status={step.status} small />
                  <span className="text-sm font-medium text-gray-800">{node.data.label}</span>
                  <span className="text-[10px] text-gray-400">{NODE_META[node.data.kind]?.label}</span>
                  {step.compliance && <ComplianceBadge c={step.compliance} />}
                </div>
                {step.error
                  ? <p className="text-xs text-red-500 mt-1 break-words">{step.error}</p>
                  : <pre className="text-[11px] font-mono text-gray-500 mt-1 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{JSON.stringify(step.output, null, 2)?.slice(0, 1500)}</pre>}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

// ── Categorized node palette (slide-over) ─────────────────────────────────────
function NodePalette({ onAdd, onClose }) {
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  return (
    <>
      <div className="absolute inset-0 bg-black/10 z-10" onClick={onClose} />
      <div className="absolute top-0 right-0 h-full w-80 bg-white border-l border-gray-200 shadow-xl z-20 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-gray-800">Add node</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={16} /></button>
        </div>
        <div className="p-3 border-b border-gray-100">
          <div className="flex items-center gap-2 px-2.5 py-1.5 border border-gray-200 rounded-lg">
            <Search size={14} className="text-gray-400" />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search nodes…"
              className="flex-1 text-sm outline-none bg-transparent" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {CATEGORIES.map(cat => {
            const kinds = cat.kinds.filter(k => {
              const m = NODE_META[k]; if (!m) return false
              return !query || m.label.toLowerCase().includes(query) || (m.desc || '').toLowerCase().includes(query)
            })
            if (cat.comingSoon && query) return null
            if (!cat.comingSoon && kinds.length === 0) return null
            return (
              <div key={cat.id} className="mb-1">
                <div className="px-4 pt-2 pb-1 flex items-baseline gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{cat.label}</span>
                  {cat.hint && <span className="text-[10px] text-gray-400">{cat.hint}</span>}
                </div>
                {cat.comingSoon ? (
                  <p className="px-4 py-1.5 text-xs text-gray-400">Wait-for-approval & form nodes — coming soon.</p>
                ) : kinds.map(k => {
                  const m = NODE_META[k]; const Icon = m.icon
                  return (
                    <button key={k} onClick={() => onAdd(k)}
                      className="w-full flex items-start gap-3 px-4 py-2 hover:bg-gray-50 text-left group">
                      <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ background: m.color + '1a' }}>
                        <Icon size={16} style={{ color: m.color }} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-gray-800">{m.label}</span>
                        <span className="block text-[11px] text-gray-400 leading-tight">{m.desc}</span>
                      </span>
                      <ChevronRight size={14} className="text-gray-300 mt-1.5 opacity-0 group-hover:opacity-100" />
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

// ── INPUT panel: per-node accordions + Schema/Table/JSON, drag-to-parameter ────
function TypeChip({ value }) {
  let Icon = TypeIcon, color = '#64748b'
  if (typeof value === 'number') { Icon = Hash; color = '#0ea5e9' }
  else if (typeof value === 'boolean') { Icon = ToggleLeft; color = '#a855f7' }
  else if (Array.isArray(value)) { Icon = Brackets; color = '#f59e0b' }
  else if (value && typeof value === 'object') { Icon = Braces; color = '#14b8a6' }
  return <Icon size={11} style={{ color }} className="shrink-0" />
}

// Recursive typed tree of a node's output. Every row (leaf OR object/array) is
// draggable and click-to-insert; objects/arrays collapse via a chevron.
function TreeRow({ k, value, base, path, depth, onInsert, onDragStart, onDragEnd }) {
  const isBranch = value !== null && typeof value === 'object'
  const [open, setOpen] = useState(depth === 0)
  const token = `{{${base}.${path}}}`
  const children = isBranch
    ? (Array.isArray(value) ? value.slice(0, 30).map((v, i) => [String(i), v]) : Object.entries(value))
        .filter(([ck]) => !['_merged', '_branch', '_kept', '_loop'].includes(ck))
    : []
  return (
    <div>
      <div style={{ paddingLeft: depth * 14 + 6 }}
        draggable
        onDragStart={e => { e.dataTransfer.setData('text/plain', token); e.dataTransfer.effectAllowed = 'copy'; onDragStart && onDragStart() }}
        onDragEnd={onDragEnd} onClick={() => onInsert(token)}
        title={`Drag into a field, or click to insert ${token}`}
        className="group flex items-center gap-1 py-0.5 cursor-grab hover:bg-indigo-50 rounded pr-2">
        {isBranch
          ? <button onClick={e => { e.stopPropagation(); setOpen(o => !o) }} className="shrink-0 text-gray-400 hover:text-gray-600">
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
          : <GripVertical size={10} className="text-gray-300 group-hover:text-gray-400 shrink-0 ml-0.5" />}
        <TypeChip value={value} />
        <span className="text-[11px] font-medium text-gray-600 shrink-0">{k}</span>
        {isBranch
          ? <span className="text-[10px] text-gray-300">{Array.isArray(value) ? `[${value.length}]` : '{…}'}</span>
          : <span className="text-[11px] text-gray-400 truncate">{String(value)}</span>}
      </div>
      {isBranch && open && children.map(([ck, cv]) => (
        <TreeRow key={`${path}.${ck}`} k={ck} value={cv} base={base} path={`${path}.${ck}`}
          depth={depth + 1} onInsert={onInsert} onDragStart={onDragStart} onDragEnd={onDragEnd} />
      ))}
    </div>
  )
}

function Tree({ data, base, onInsert, onDragStart, onDragEnd }) {
  if (data === null || data === undefined || typeof data !== 'object') return null
  const entries = (Array.isArray(data) ? data.slice(0, 30).map((v, i) => [String(i), v]) : Object.entries(data))
    .filter(([k]) => !['_merged', '_branch', '_kept', '_loop'].includes(k))
  return (
    <div>
      {entries.map(([k, v]) => (
        <TreeRow key={k} k={k} value={v} base={base} path={k} depth={0}
          onInsert={onInsert} onDragStart={onDragStart} onDragEnd={onDragEnd} />
      ))}
    </div>
  )
}

function NodeAccordion({ node, output, onInsert, onDragStart, onDragEnd }) {
  const [open, setOpen] = useState(true)
  const ref = node.data.label || node.id
  const meta = NODE_META[node.data.kind] || {}
  const NodeIcon = meta.icon || CircleSlash
  const count = Array.isArray(output?.items) ? output.items.length : (output ? 1 : 0)
  return (
    <div className="border-b border-gray-50">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-gray-50">
        {open ? <ChevronDown size={13} className="text-gray-400" /> : <ChevronRight size={13} className="text-gray-400" />}
        <NodeIcon size={13} style={{ color: meta.color }} />
        <span className="text-xs font-medium text-gray-700">{node.data.label}</span>
        {output && <span className="ml-auto text-[10px] text-gray-400">{count} item{count === 1 ? '' : 's'}</span>}
      </button>
      {open && (
        <div className="pb-1.5">
          {output == null
            ? <p className="text-[11px] text-gray-400 pl-7 pr-2 py-1">No data — run to view, or drag the whole node: <button onClick={() => onInsert(`{{${ref}}}`)} className="font-mono text-indigo-500 hover:underline">{`{{${ref}}}`}</button></p>
            : <Tree data={output} base={ref} onInsert={onInsert} onDragStart={onDragStart} onDragEnd={onDragEnd} />}
        </div>
      )}
    </div>
  )
}

function InputPanel({ ancestors, steps, step, isEntry, onInsert, onDragStart, onDragEnd }) {
  const [view, setView] = useState('schema')
  const input = step?.input
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-end gap-1 px-3 py-1.5 border-b border-gray-100">
        {['schema', 'table', 'json'].map(v => (
          <button key={v} onClick={() => setView(v)}
            className={`text-[11px] px-2 py-0.5 rounded capitalize ${view === v ? 'bg-gray-800 text-white' : 'text-gray-500 hover:bg-gray-100'}`}>{v}</button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {view === 'json' ? (
          <JsonView data={input} empty="Run to view input data" />
        ) : view === 'table' ? (
          <TableView data={input} />
        ) : isEntry ? (
          <p className="text-xs text-gray-400 p-4">This is an entry node — it receives the trigger payload.</p>
        ) : ancestors.length === 0 ? (
          <p className="text-xs text-gray-400 p-4">No upstream nodes connected yet.</p>
        ) : (
          ancestors.map(a => (
            <NodeAccordion key={a.id} node={a} output={steps[a.id]?.output}
              onInsert={onInsert} onDragStart={onDragStart} onDragEnd={onDragEnd} />
          ))
        )}
      </div>
    </div>
  )
}

function TableView({ data }) {
  if (data == null) return <JsonView data={data} empty="Run to view input data" />
  const rows = Array.isArray(data) ? data : [data]
  const cols = [...new Set(rows.flatMap(r => (r && typeof r === 'object' ? Object.keys(r) : [])))].slice(0, 8)
  if (cols.length === 0) return <JsonView data={data} />
  return (
    <div className="overflow-auto p-2">
      <table className="text-[11px] border-collapse">
        <thead><tr>{cols.map(c => <th key={c} className="text-left font-semibold text-gray-500 border-b border-gray-200 px-2 py-1">{c}</th>)}</tr></thead>
        <tbody>{rows.slice(0, 30).map((r, i) => (
          <tr key={i} className="border-b border-gray-50">{cols.map(c => (
            <td key={c} className="px-2 py-1 text-gray-600 max-w-[160px] truncate">{typeof r?.[c] === 'object' ? JSON.stringify(r[c]) : String(r?.[c] ?? '')}</td>
          ))}</tr>
        ))}</tbody>
      </table>
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

function SwitchConfig({ config, onChange, onFocusField }) {
  const rules = config.rules || []
  function update(i, patch) { onChange('rules', rules.map((r, j) => j === i ? { ...r, ...patch } : r)) }
  function add() { onChange('rules', [...rules, { condition: '', label: '' }]) }
  function remove(i) { onChange('rules', rules.filter((_, j) => j !== i)) }
  const base = "w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-400"
  return (
    <div className="space-y-2">
      <label className="block text-[11px] font-medium text-gray-500">Rules — first match wins; otherwise the <b>default</b> output</label>
      {rules.map((r, i) => (
        <div key={i} className="border border-gray-200 rounded-lg p-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold text-orange-600">Output {i}</span>
            <button onClick={() => remove(i)} className="text-gray-300 hover:text-red-500"><Trash2 size={12} /></button>
          </div>
          <input value={r.label || ''} onChange={e => update(i, { label: e.target.value })} placeholder="Output label (optional)" className={`${base} text-xs`} />
          <input value={r.condition || ''} onFocus={() => onFocusField && onFocusField('rules')} onChange={e => update(i, { condition: e.target.value })}
            placeholder="Condition, e.g. input['type'] == 'mint'" className={`${base} font-mono text-xs`} />
        </div>
      ))}
      <button onClick={add} className="flex items-center gap-1 text-xs text-indigo-600 hover:underline"><Plus size={12} /> Add rule</button>
    </div>
  )
}

// Styled combobox so the model list opens BELOW the field (not the native datalist).
function ModelSelect({ value, models, onChange, placeholder }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const base = "w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-400"
  const filter = (typed && value) ? value.toLowerCase() : ''
  const list = (models || []).filter(m => m.toLowerCase().includes(filter)).slice(0, 60)
  return (
    <div className="relative" ref={ref}>
      <div className="relative">
        <input value={value} placeholder={placeholder}
          onFocus={() => { setOpen(true); setTyped(false) }}
          onChange={e => { onChange(e.target.value); setTyped(true); setOpen(true) }}
          className={`${base} pr-7`} />
        <ChevronDown size={14} className="absolute right-2 top-2.5 text-gray-400 pointer-events-none" />
      </div>
      {open && list.length > 0 && (
        <div className="absolute z-30 mt-1 w-full max-h-52 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
          {list.map(m => (
            <button key={m} type="button" onMouseDown={e => { e.preventDefault(); onChange(m); setOpen(false) }}
              className={`w-full text-left px-2.5 py-1.5 text-sm hover:bg-indigo-50 ${m === value ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700'}`}>{m}</button>
          ))}
        </div>
      )}
    </div>
  )
}

function LlmConfig({ config, agents, onChange, onFocusField, dragActive, dropToken }) {
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
        <ModelSelect value={config.model || ''} models={models} onChange={v => onChange('model', v)}
          placeholder={config.api_provider_id ? 'Select or type a model' : "Agent's default model"} />
      </div>
      <Field label="System prompt" type="textarea" value={config.system || ''} placeholder="You are a helpful assistant…" onChange={v => onChange('system', v)} onFocus={() => onFocusField && onFocusField('system')} dragActive={dragActive} onDropToken={dropToken && dropToken('system')} />
      <Field label="Prompt (templates: {{nodeId.field}})" type="textarea" value={config.prompt || ''} onChange={v => onChange('prompt', v)} onFocus={() => onFocusField && onFocusField('prompt')} dragActive={dragActive} onDropToken={dropToken && dropToken('prompt')} />
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

// ── Node Detail View (INPUT | PARAMETERS | OUTPUT) ────────────────────────────
function JsonView({ data, empty }) {
  if (data === undefined || data === null) {
    return <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-1 py-8">
      <CircleSlash size={20} /><p className="text-xs">{empty || 'No data'}</p></div>
  }
  const text = JSON.stringify(data, null, 2)
  return (
    <div className="relative group">
      <button onClick={() => navigator.clipboard?.writeText(text)}
        className="absolute top-1 right-1 p-1 text-gray-300 hover:text-indigo-500 opacity-0 group-hover:opacity-100"><Copy size={12} /></button>
      <pre className="text-[11px] font-mono text-gray-600 whitespace-pre-wrap break-words p-3">{text}</pre>
    </div>
  )
}

function NavNodes({ nodes, side, onNavigate }) {
  // Icon buttons straddling the modal edge that jump to connected (linked) nodes.
  // Multi-output nodes (switch/if/loop) can link to several — show one icon each.
  if (!nodes?.length) return null
  const pos = side === 'left' ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2'
  return (
    <div className={`absolute ${pos} top-1/2 -translate-y-1/2 z-10 flex flex-col gap-2`}>
      {nodes.map(node => {
        const m = NODE_META[node.data.kind] || {}
        const NIcon = m.icon || CircleSlash
        return (
          <button key={node.id} onClick={(e) => { e.stopPropagation(); onNavigate(node.id) }}
            title={`${side === 'left' ? 'Previous' : 'Next'}: ${node.data.label || m.label}`}
            className="w-11 h-11 flex items-center justify-center bg-white rounded-full shadow-lg border border-gray-200 hover:border-indigo-300 hover:scale-105 transition-transform">
            <span className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: (m.color || '#999') + '1a' }}>
              <NIcon size={15} style={{ color: m.color }} />
            </span>
          </button>
        )
      })}
    </div>
  )
}

function NodeDetail({ node, agents, workflowId, ancestors, steps, step, webhookUrl, stepping,
                      onClose, onRename, onConfig, onFocusField, onInsert, onDelete, onStep, onStop,
                      prevNodes, nextNodes, onNavigate }) {
  const meta = NODE_META[node.data.kind] || {}
  const Icon = meta.icon || CircleSlash
  const config = node.data.config || {}
  const isEntry = meta.entry || node.data.kind === 'trigger'
  const [dragActive, setDragActive] = useState(false)
  const dropToken = (key) => (t) => onConfig(key, `${typeof config[key] === 'string' ? config[key] : ''}${t}`)

  return (
    <div className="absolute inset-0 z-30 bg-black/30 flex items-center justify-center p-[1.5%]"
      onClick={onClose}>
    <div onClick={(e) => e.stopPropagation()}
      className="relative w-[95%] h-[95%] bg-white rounded-2xl shadow-2xl flex flex-col overflow-visible">
      {/* Jump to linked nodes — buttons sit on the modal edge, showing each target node's icon */}
      <NavNodes nodes={prevNodes} side="left" onNavigate={onNavigate} />
      <NavNodes nodes={nextNodes} side="right" onNavigate={onNavigate} />
      <div className="flex flex-col h-full rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-100 bg-gray-50">
        <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: (meta.color || '#999') + '1a' }}>
          <Icon size={15} style={{ color: meta.color }} />
        </span>
        <input value={node.data.label || ''} onChange={e => onRename(e.target.value)}
          className="text-sm font-semibold text-gray-800 bg-transparent border-b border-transparent hover:border-gray-200 focus:border-indigo-400 outline-none px-1 py-0.5 min-w-[160px]" />
        <span className="text-xs text-gray-400">{meta.label}</span>
        <div className="flex-1" />
        {stepping ? (
          <button onClick={onStop}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-lg">
            <X size={14} /> Stop
          </button>
        ) : (
          <button onClick={onStep}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg">
            <Play size={14} /> Execute step
          </button>
        )}
        <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-700"><X size={18} /></button>
      </div>

      {/* 3 equal panes */}
      <div className="flex-1 grid grid-cols-3 min-h-0 divide-x divide-gray-100">
        {/* INPUT */}
        <div className="flex flex-col min-h-0 overflow-hidden">
          <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 border-b border-gray-100">Input</div>
          {stepping ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-400 gap-2">
              <Loader2 size={22} className="animate-spin text-orange-500" />
              <p className="text-xs">Executing previous nodes…</p>
            </div>
          ) : (
            <InputPanel ancestors={ancestors} steps={steps} step={step} isEntry={isEntry}
              onInsert={onInsert} onDragStart={() => setDragActive(true)} onDragEnd={() => setDragActive(false)} />
          )}
        </div>

        {/* PARAMETERS */}
        <div className="flex flex-col min-h-0 overflow-hidden">
          <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 border-b border-gray-100">Parameters</div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {meta.custom === 'llm' && <LlmConfig config={config} agents={agents} onChange={onConfig} onFocusField={onFocusField} dragActive={dragActive} dropToken={dropToken} />}
            {meta.custom === 'subworkflow' && <SubworkflowConfig config={config} currentId={workflowId} onChange={onConfig} />}
            {meta.custom === 'switch' && <SwitchConfig config={config} onChange={onConfig} onFocusField={onFocusField} />}
            {meta.custom === 'code' && <CodeConfig config={config} onChange={onConfig} onFocusField={onFocusField} dragActive={dragActive} dropToken={dropToken} />}
            {meta.custom === 'http' && <HttpConfig config={config} onChange={onConfig} onFocusField={onFocusField} dragActive={dragActive} dropToken={dropToken} />}
            {meta.custom === 'trigger' && <TriggerConfig config={config} onChange={onConfig} webhookUrl={webhookUrl} />}
            {(meta.fields || []).map(({ key, ...f }) => (
              <Field key={key} {...f} agents={agents} value={config[key] ?? ''}
                dragActive={dragActive} onDropToken={dropToken(key)}
                onFocus={() => onFocusField(key)} onChange={(v) => onConfig(key, v)} />
            ))}
            {(meta.fields || []).length === 0 && !meta.custom && (
              <p className="text-xs text-gray-400">This node has no parameters.</p>
            )}
            {node.data.kind !== 'trigger' && (
              <button onClick={onDelete} className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-600 pt-1">
                <Trash2 size={13} /> Delete node
              </button>
            )}
          </div>
        </div>

        {/* OUTPUT */}
        <div className="flex flex-col min-h-0 overflow-hidden">
          <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 border-b border-gray-100 flex items-center gap-2">
            Output {step && !stepping && <RunStatus status={step.status} small />}
          </div>
          <div className="flex-1 overflow-y-auto">
            {stepping ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2">
                <Loader2 size={22} className="animate-spin text-orange-500" />
                <p className="text-xs">Running this node…</p>
              </div>
            ) : step?.error ? (
              <div className="p-4"><p className="text-xs text-red-500 break-words">{step.error}</p></div>
            ) : step?.output ? <JsonView data={step.output} /> : (
              <div className="flex flex-col items-center justify-center h-32 text-gray-400 gap-2">
                <p className="text-xs">No output data</p>
                <button onClick={onStep} className="text-xs px-2.5 py-1 border border-gray-200 rounded-lg hover:bg-gray-50">Execute step</button>
              </div>
            )}
            {step?.compliance && <div className="px-4 pb-3"><ComplianceBadge c={step.compliance} /></div>}
          </div>
        </div>
      </div>
      </div>
    </div>
    </div>
  )
}

function Field({ label, type, value, onChange, options, placeholder, agents, onFocus, dragActive, onDropToken }) {
  // Text/textarea fields accept dragged {{tokens}} from the INPUT pane.
  const droppable = !!onDropToken && (type === 'textarea' || type === 'json' || type === undefined || type === 'text')
  const ring = dragActive && droppable ? ' ring-2 ring-indigo-300 bg-indigo-50/40' : ''
  const dropProps = droppable ? {
    onDragOver: e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' },
    onDrop: e => { e.preventDefault(); const t = e.dataTransfer.getData('text/plain'); if (t) onDropToken(t) },
  } : {}
  const base = "w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-400" + ring
  let input
  if (type === 'select') {
    input = <select value={value} onChange={e => onChange(e.target.value)} className={base}>
      <option value="">—</option>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  } else if (type === 'checkbox') {
    return <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
      <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} /> {label}
    </label>
  } else if (type === 'agent') {
    input = <select value={value} onChange={e => onChange(e.target.value)} className={base}>
      <option value="">Auto (first non-manager)</option>
      {(agents || []).map(a => <option key={a.config.id} value={a.config.id}>{a.config.name}</option>)}
    </select>
  } else if (type === 'textarea' || type === 'json') {
    const val = typeof value === 'object' ? JSON.stringify(value, null, 2) : (value ?? '')
    input = <textarea value={val} placeholder={placeholder} rows={type === 'json' ? 4 : 5} onFocus={onFocus} {...dropProps}
      onChange={e => {
        if (type === 'json') { try { onChange(JSON.parse(e.target.value)) } catch { onChange(e.target.value) } }
        else onChange(e.target.value)
      }}
      className={`${base} font-mono text-xs resize-y`} />
  } else if (type === 'number') {
    input = <input type="number" value={value} placeholder={placeholder} onFocus={onFocus}
      onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} className={base} />
  } else {
    input = <input type="text" value={value} placeholder={placeholder} onFocus={onFocus} {...dropProps} onChange={e => onChange(e.target.value)} className={base} />
  }
  return <div>{label && <label className="block text-[11px] font-medium text-gray-500 mb-1">{label}</label>}{input}</div>
}

function CodeConfig({ config, onChange, onFocusField, dragActive, dropToken }) {
  const formatCode = useOrgStore(s => s.formatCode)
  const [busy, setBusy] = useState(false)
  const lang = config.language || 'python'
  async function fmt() {
    setBusy(true)
    const r = await formatCode(config.code || '', lang)
    if (r?.code != null) onChange('code', r.code)
    setBusy(false)
  }
  return (
    <>
      <Field label="Language" type="select" options={['python', 'javascript']} value={lang} onChange={v => onChange('language', v)} />
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[11px] font-medium text-gray-500">Code — use <code>input</code>/<code>context</code>; <code>return</code> a value (or set <code>output</code>)</label>
          <button onClick={fmt} disabled={busy}
            className="flex items-center gap-1 text-[11px] text-indigo-600 hover:bg-indigo-50 px-1.5 py-0.5 rounded disabled:opacity-50">
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />} Format
          </button>
        </div>
        <Field type="textarea" value={config.code ?? ''}
          placeholder={lang === 'python' ? "return {'doubled': input['n'] * 2}" : 'return { doubled: input.n * 2 }'}
          dragActive={dragActive} onDropToken={dropToken && dropToken('code')}
          onFocus={() => onFocusField && onFocusField('code')} onChange={v => onChange('code', v)} />
      </div>
    </>
  )
}

// ── Trigger node config (dynamic by trigger type) ─────────────────────────────
const TRIGGER_TYPES = [
  { id: 'manual', label: 'Manual', icon: Hand, desc: 'Run on demand (test / Execute workflow)' },
  { id: 'schedule', label: 'Schedule', icon: Clock, desc: 'Run automatically on a time schedule' },
  { id: 'webhook', label: 'Webhook', icon: Globe, desc: 'Run when an HTTP request hits its URL' },
  { id: 'agent', label: 'Agent', icon: Sparkles, desc: 'Run when an org agent invokes it' },
]
const WEEKDAYS = [
  { v: 0, label: 'Sunday' }, { v: 1, label: 'Monday' }, { v: 2, label: 'Tuesday' },
  { v: 3, label: 'Wednesday' }, { v: 4, label: 'Thursday' }, { v: 5, label: 'Friday' }, { v: 6, label: 'Saturday' },
]
const HOUR_LABELS = i => i === 0 ? 'Midnight (00:00)' : i === 12 ? 'Noon (12:00)' : `${String(i).padStart(2, '0')}:00`

function scheduleToCron(s) {
  s = s || {}
  const m = Math.min(59, Math.max(0, Number(s.atMinute) || 0))
  const h = Math.min(23, Math.max(0, Number(s.atHour) || 0))
  const n = Math.max(1, Number(s.every) || 1)
  switch (s.interval) {
    case 'minutes': return `*/${n} * * * *`
    case 'hours': return `${m} */${n} * * *`
    case 'days': return n === 1 ? `${m} ${h} * * *` : `${m} ${h} */${n} * *`
    case 'weeks': { const d = (s.weekdays?.length ? s.weekdays : [1]).join(','); return `${m} ${h} * * ${d}` }
    case 'months': return `${m} ${h} ${Math.min(31, Math.max(1, Number(s.dayOfMonth) || 1))} * *`
    case 'cron': return (s.cron || '').trim() || '@daily'
    default: return `${m} ${h} * * *`
  }
}

function TriggerConfig({ config, onChange, webhookUrl }) {
  const base = "w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-400"
  const type = config.triggerType || 'manual'
  const sched = config.schedule || { interval: 'days', every: 1, atHour: 0, atMinute: 0, weekdays: [1], dayOfMonth: 1 }
  const setSched = (patch) => onChange('schedule', { ...sched, ...patch })
  const hourSel = (val, on) => (
    <select value={val ?? 0} onChange={e => on(Number(e.target.value))} className={base}>
      {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{HOUR_LABELS(i)}</option>)}
    </select>
  )
  const numField = (label, val, on, hint) => (
    <div>
      <label className="block text-[11px] font-medium text-gray-500 mb-1">{label}</label>
      <input type="number" min={1} value={val ?? 1} onChange={e => on(e.target.value === '' ? '' : Number(e.target.value))} className={base} />
      {hint && <p className="text-[10px] text-gray-400 mt-1">{hint}</p>}
    </div>
  )
  const minField = (
    <div>
      <label className="block text-[11px] font-medium text-gray-500 mb-1">Trigger at minute</label>
      <input type="number" min={0} max={59} value={sched.atMinute ?? 0} onChange={e => setSched({ atMinute: Number(e.target.value) })} className={base} />
    </div>
  )
  return (
    <div className="space-y-4">
      {/* Trigger type selector */}
      <div>
        <label className="block text-[11px] font-medium text-gray-500 mb-1.5">Trigger type</label>
        <div className="grid grid-cols-2 gap-1.5">
          {TRIGGER_TYPES.map(t => {
            const TIcon = t.icon; const active = type === t.id
            return (
              <button key={t.id} onClick={() => onChange('triggerType', t.id)} title={t.desc}
                className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left transition-colors ${active ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                <TIcon size={15} className="shrink-0" />
                <span className="text-xs font-medium">{t.label}</span>
              </button>
            )
          })}
        </div>
        <p className="text-[11px] text-gray-400 mt-1.5">{TRIGGER_TYPES.find(t => t.id === type)?.desc}</p>
      </div>

      {/* Dynamic options */}
      {(type === 'manual' || type === 'agent') && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-[11px] text-amber-800">
          {type === 'manual'
            ? 'No schedule needed — this runs when you trigger it. Use Test or “Execute step”/“Execute workflow” to run it now.'
            : 'This runs when an org agent invokes the workflow (via its run_workflow skill). You can still Test it manually here.'}
        </div>
      )}

      {type === 'webhook' && (
        <div className="space-y-2">
          <label className="block text-[11px] font-medium text-gray-500">Webhook URL</label>
          {webhookUrl ? (
            <div className="flex items-center gap-1.5">
              <code className="flex-1 text-[10px] bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 break-all">{webhookUrl}</code>
              <button onClick={() => navigator.clipboard?.writeText(webhookUrl)} className="p-1.5 text-gray-400 hover:text-indigo-600" title="Copy"><Copy size={14} /></button>
            </div>
          ) : <p className="text-[11px] text-amber-600">Save the workflow to generate its webhook URL.</p>}
          <p className="text-[11px] text-gray-400">POST to this URL to trigger the workflow. During a Test it captures the next real call.</p>
        </div>
      )}

      {type === 'schedule' && (
        <div className="space-y-3">
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-[11px] text-amber-800">
            This workflow runs on the schedule below once published. For testing, trigger it manually with Test.
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">Trigger interval</label>
            <select value={sched.interval || 'days'} onChange={e => setSched({ interval: e.target.value })} className={base}>
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
              <option value="cron">Custom (cron)</option>
            </select>
          </div>

          {sched.interval === 'minutes' && numField('Minutes between triggers', sched.every, v => setSched({ every: v }), 'e.g. 15 → every 15 minutes')}

          {sched.interval === 'hours' && <>
            {numField('Hours between triggers', sched.every, v => setSched({ every: v }))}
            {minField}
          </>}

          {(sched.interval === 'days' || !sched.interval) && <>
            {numField('Days between triggers', sched.every, v => setSched({ every: v }), 'Must be in range 1–31')}
            <div><label className="block text-[11px] font-medium text-gray-500 mb-1">Trigger at hour</label>{hourSel(sched.atHour, v => setSched({ atHour: v }))}</div>
            {minField}
          </>}

          {sched.interval === 'weeks' && <>
            {numField('Weeks between triggers', sched.every, v => setSched({ every: v }))}
            <div>
              <label className="block text-[11px] font-medium text-gray-500 mb-1">Trigger on weekdays</label>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map(d => {
                  const on = (sched.weekdays || []).includes(d.v)
                  return (
                    <button key={d.v} onClick={() => setSched({ weekdays: on ? (sched.weekdays || []).filter(x => x !== d.v) : [...(sched.weekdays || []), d.v] })}
                      className={`px-2 py-1 rounded-md text-[11px] border ${on ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                      {d.label.slice(0, 3)}
                    </button>
                  )
                })}
              </div>
            </div>
            <div><label className="block text-[11px] font-medium text-gray-500 mb-1">Trigger at hour</label>{hourSel(sched.atHour, v => setSched({ atHour: v }))}</div>
            {minField}
          </>}

          {sched.interval === 'months' && <>
            {numField('Day of month', sched.dayOfMonth, v => setSched({ dayOfMonth: v }), '1–31')}
            <div><label className="block text-[11px] font-medium text-gray-500 mb-1">Trigger at hour</label>{hourSel(sched.atHour, v => setSched({ atHour: v }))}</div>
            {minField}
          </>}

          {sched.interval === 'cron' && (
            <div>
              <label className="block text-[11px] font-medium text-gray-500 mb-1">Cron expression</label>
              <input value={sched.cron || ''} onChange={e => setSched({ cron: e.target.value })} placeholder="0 9 * * 1-5" className={`${base} font-mono`} />
              <p className="text-[10px] text-gray-400 mt-1">Standard 5-field cron: minute hour day-of-month month day-of-week.</p>
            </div>
          )}

          <p className="text-[11px] text-gray-400">Resolves to <code className="bg-gray-100 rounded px-1">{scheduleToCron(sched)}</code></p>
        </div>
      )}

      {/* Sample/test input — available for every type */}
      <div className="border-t border-gray-100 pt-3">
        <label className="block text-[11px] font-medium text-gray-500 mb-1">Test input (JSON, optional)</label>
        <textarea value={typeof config.sample === 'string' ? config.sample : (config.sample ? JSON.stringify(config.sample, null, 2) : '')}
          onChange={e => onChange('sample', e.target.value)} rows={3}
          placeholder='{ "example": "value" }' className={`${base} font-mono text-xs`} />
        <p className="text-[10px] text-gray-400 mt-1">Used as the trigger payload when you Test the workflow.</p>
      </div>
    </div>
  )
}

function Toggle({ on, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={`shrink-0 w-9 h-5 rounded-full relative transition-colors ${on ? 'bg-indigo-500' : 'bg-gray-300'}`}>
      <span className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all" style={{ left: on ? 18 : 2 }} />
    </button>
  )
}

// n8n-style key/value rows (Name | Value | delete) with an "Add parameter" button.
function KvRows({ rows, onChange, addLabel = 'Add parameter' }) {
  const base = "flex-1 min-w-0 text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-400"
  const set = (i, patch) => onChange(rows.map((r, j) => j === i ? { ...r, ...patch } : r))
  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-[11px] text-gray-400">None yet — add one below.</p>}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input value={r.name || ''} onChange={e => set(i, { name: e.target.value })} placeholder="Name" className={base} />
          <input value={r.value || ''} onChange={e => set(i, { value: e.target.value })} placeholder="Value" className={`${base} font-mono text-xs`} />
          <button onClick={() => onChange(rows.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500 shrink-0" title="Remove"><Trash2 size={13} /></button>
        </div>
      ))}
      <button onClick={() => onChange([...rows, { name: '', value: '' }])}
        className="flex items-center gap-1 text-xs text-indigo-600 hover:underline"><Plus size={12} /> {addLabel}</button>
    </div>
  )
}

function HttpSection({ label, on, toggle, children }) {
  return (
    <div className="border-t border-gray-100 pt-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-gray-700">{label}</label>
        <Toggle on={on} onClick={toggle} />
      </div>
      {on && <div className="mt-2.5">{children}</div>}
    </div>
  )
}

function HttpConfig({ config, onChange, onFocusField, dragActive, dropToken }) {
  const base = "w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-400"
  const opts = config.options || {}
  const setOpt = (k, v) => onChange('options', { ...opts, [k]: v })
  const ring = dragActive ? ' ring-2 ring-indigo-300 bg-indigo-50/40' : ''
  const dropProps = (key) => ({
    onDragOver: e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' },
    onDrop: e => { e.preventDefault(); const t = e.dataTransfer.getData('text/plain'); if (t && dropToken) dropToken(key)(t) },
  })
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[11px] font-medium text-gray-500 mb-1">Method</label>
        <select value={config.method || 'GET'} onChange={e => onChange('method', e.target.value)} className={base}>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-gray-500 mb-1">URL</label>
        <input value={config.url || ''} onFocus={() => onFocusField && onFocusField('url')}
          onChange={e => onChange('url', e.target.value)} {...dropProps('url')}
          placeholder="https://api.example.com/{{Trigger.id}}" className={base + ring} />
      </div>

      <HttpSection label="Send Query Parameters" on={!!config.sendQuery} toggle={() => onChange('sendQuery', !config.sendQuery)}>
        <KvRows rows={config.queryParams || []} onChange={v => onChange('queryParams', v)} />
      </HttpSection>

      <HttpSection label="Send Headers" on={!!config.sendHeaders} toggle={() => onChange('sendHeaders', !config.sendHeaders)}>
        <KvRows rows={config.headerParams || []} onChange={v => onChange('headerParams', v)} />
      </HttpSection>

      <HttpSection label="Send Body" on={!!config.sendBody} toggle={() => onChange('sendBody', !config.sendBody)}>
        <div className="space-y-2">
          <select value={config.bodyType || 'json'} onChange={e => onChange('bodyType', e.target.value)} className={`${base} text-xs`}>
            <option value="json">JSON</option>
            <option value="raw">Raw / text</option>
          </select>
          <textarea value={config.body ?? ''} onFocus={() => onFocusField && onFocusField('body')}
            onChange={e => onChange('body', e.target.value)} {...dropProps('body')} rows={4}
            placeholder={config.bodyType === 'raw' ? 'raw body…' : '{ "key": "{{Trigger.value}}" }'}
            className={`${base} font-mono text-xs${ring}`} />
        </div>
      </HttpSection>

      {/* Options */}
      <div className="border-t border-gray-100 pt-3 space-y-2.5">
        <label className="text-xs font-medium text-gray-700">Options</label>
        <div>
          <label className="block text-[11px] text-gray-500 mb-1">Timeout (ms)</label>
          <input type="number" value={opts.timeout ?? ''} onChange={e => setOpt('timeout', e.target.value ? Number(e.target.value) : '')}
            placeholder="default" className={`${base} text-xs`} />
        </div>
        <div className="flex items-center justify-between">
          <label className="text-[11px] text-gray-500">Follow redirects</label>
          <Toggle on={opts.followRedirects !== false} onClick={() => setOpt('followRedirects', opts.followRedirects === false)} />
        </div>
        <div className="flex items-center justify-between">
          <label className="text-[11px] text-gray-500">Ignore SSL issues (insecure)</label>
          <Toggle on={!!opts.ignoreSSL} onClick={() => setOpt('ignoreSSL', !opts.ignoreSSL)} />
        </div>
      </div>

      {/* Error handling */}
      <div className="border-t border-gray-100 pt-3">
        <label className="block text-xs font-medium text-gray-700 mb-1">On Error</label>
        <select value={config.onError || 'stop'} onChange={e => onChange('onError', e.target.value)} className={`${base} text-xs`}>
          <option value="stop">Stop Workflow (fail on 4xx/5xx)</option>
          <option value="continue">Continue (ignore 4xx/5xx)</option>
        </select>
        <p className="text-[11px] text-gray-400 mt-1.5">A 4xx/5xx response fails the node so an <b>Error Trigger</b> can catch the message — unless set to Continue.</p>
      </div>
    </div>
  )
}

export default function WorkflowEditor(props) {
  return <ReactFlowProvider><EditorInner {...props} /></ReactFlowProvider>
}
