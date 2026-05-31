/**
 * OrganisationView — n8n-style free-flow canvas.
 * Nodes are freely draggable. Click-drag from a right port to connect agents.
 * Click a connection line to edit its label or delete it.
 */
import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Plus, X, Trash2, Check, Network, Pencil, KeyRound } from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'
import {
  useAgents, useConnections,
  useUpdateAgent, useRemoveAgent,
  useCreateConnection, useUpdateConnection, useDeleteConnection,
  useSaveCanvasPositions,
  useProviders, useProviderModels,
} from '../hooks/useApi'
import AgentModal from './AgentModal'
import AIPromptWizard from './AIPromptWizard'

// ── Constants ─────────────────────────────────────────────────────────────────

const NODE_W  = 220
const NODE_H  = 96
const PORT_R  = 7
const GRID    = 24
const COLORS  = ['#4F46E5','#DC2626','#059669','#D97706','#7C3AED','#0891B2','#DB2777']
const PROVIDERS = ['anthropic','openai','ollama','gemini','glm','minimax','custom']
const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini', ollama: 'llama3',
  gemini: 'gemini-1.5-flash', glm: 'glm-4-flash', minimax: 'abab6.5s-chat', custom: '',
}

function initials(name = '') {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

// ── Port geometry ─────────────────────────────────────────────────────────────

function outPort(pos) { return { x: pos.x + NODE_W / 2, y: pos.y + NODE_H } }
function inPort(pos)  { return { x: pos.x + NODE_W / 2, y: pos.y } }

// Smart bezier that bends based on relative node positions.
// When the target is to the right, control points extend horizontally.
// When the target is to the left (backwards), the curve loops around.
function smartBezier(x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const absDx = Math.abs(dx)
  const absDy = Math.abs(dy)
  const minArm = 50

  if (dy > 0) {
    // Target is below — vertical S-curve dropping down
    const arm = Math.max(minArm, absDy * 0.4)
    return {
      d: `M${x1} ${y1} C${x1} ${y1 + arm}, ${x2} ${y2 - arm}, ${x2} ${y2}`,
      labelX: (x1 + x2) / 2 + (dx > 0 ? 12 : -12),
      labelY: (y1 + y2) / 2,
    }
  }

  // Target is above — loop around horizontally
  const loop = Math.max(minArm, absDy * 0.5, 80)
  const hOff = absDx < 40 ? 80 : absDx * 0.6
  const sign = x1 <= x2 ? 1 : -1

  return {
    d: `M${x1} ${y1} C${x1 + sign * hOff} ${y1 + loop}, ${x2 + sign * hOff} ${y2 - loop}, ${x2} ${y2}`,
    labelX: ((x1 + x2) / 2) + sign * hOff * 0.5,
    labelY: (y1 + y2) / 2,
  }
}

function previewBezier(x1, y1, x2, y2) {
  const arm = Math.max(40, Math.abs(y2 - y1) * 0.35)
  return `M${x1} ${y1} C${x1} ${y1 + arm}, ${x2} ${y2 - arm}, ${x2} ${y2}`
}

// ── Dot-grid ──────────────────────────────────────────────────────────────────

function DotGrid() {
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="dots" x="0" y="0" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.2" fill="#d1d5db" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#dots)" />
    </svg>
  )
}

// ── Label modal (create + edit) ───────────────────────────────────────────────

function LabelModal({ title, initial, onConfirm, onCancel }) {
  const [label, setLabel] = useState(initial || '')
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onMouseDown={onCancel}>
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-80 space-y-4" onMouseDown={e => e.stopPropagation()}>
        <h3 className="font-semibold text-gray-900">{title || 'Label this connection'}</h3>
        <p className="text-xs text-gray-400">Describe the relationship (e.g. "delegates research to")</p>
        <input
          autoFocus
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400"
          placeholder="Leave blank to skip…"
          value={label}
          onChange={e => setLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onConfirm(label) }}
        />
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 border border-gray-200 rounded-xl py-2 text-sm hover:bg-gray-50">Cancel</button>
          <button onClick={() => onConfirm(label)}
            className="flex-1 bg-indigo-600 text-white rounded-xl py-2 text-sm font-medium hover:bg-indigo-700">
            {initial != null ? 'Update' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Connection popover (edit / delete) ────────────────────────────────────────

function ConnPopover({ x, y, label, onEdit, onDelete, onClose }) {
  return (
    <div
      className="absolute z-40"
      style={{ left: x, top: y, transform: 'translate(-50%, -100%)' }}
    >
      <div className="bg-white rounded-xl shadow-xl border border-gray-100 px-1 py-1 flex items-center gap-0.5 mb-2">
        <button
          onClick={onEdit}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-indigo-50 hover:text-indigo-600 rounded-lg transition-colors"
        >
          <Pencil size={12} /> {label ? 'Edit' : 'Add label'}
        </button>
        <div className="w-px h-4 bg-gray-200" />
        <button
          onClick={onDelete}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-red-50 hover:text-red-600 rounded-lg transition-colors"
        >
          <Trash2 size={12} /> Delete
        </button>
      </div>
    </div>
  )
}

// ── Edit panel ────────────────────────────────────────────────────────────────

function ProviderModelPicker({ form, set }) {
  const navigateTo = useOrgStore(s => s.navigateTo)
  const { data: providers = [] } = useProviders()
  const llmProviders = providers.filter(p => p.type === 'llm')

  const selectedProvider = llmProviders.find(p => p.id === form.api_provider_id)
  const { data: modelsData } = useProviderModels(selectedProvider?.id)
  const models = modelsData?.models || []

  if (llmProviders.length === 0) {
    return (
      <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
        <span className="text-xs text-amber-700 flex-1">No LLM providers configured.</span>
        <button
          type="button"
          onClick={() => navigateTo('api')}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg border border-indigo-200">
          <Pencil size={11} /> Add Provider
        </button>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="space-y-1">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Provider</span>
        <select
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400 bg-white"
          value={form.api_provider_id || ''}
          onChange={e => { set('api_provider_id', e.target.value); set('llm_model', '') }}>
          <option value="">Select provider…</option>
          {llmProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Model</span>
        {models.length > 0 ? (
          <select
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400 bg-white"
            value={form.llm_model || ''}
            onChange={e => set('llm_model', e.target.value)}>
            <option value="">Select model…</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400"
            placeholder="Enter model name"
            value={form.llm_model || ''} onChange={e => set('llm_model', e.target.value)} />
        )}
      </label>
    </div>
  )
}

function EditPanel({ agent, onClose, onSave, onRemove }) {
  const { config } = agent
  const [form, setForm] = useState({ ...config })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function handleSave() {
    setSaving(true)
    try { await onSave(form) } finally { setSaving(false) }
  }

  return (
    <div className="w-[30%] min-w-80 shrink-0 bg-white border-l border-gray-100 flex flex-col overflow-hidden z-10">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-sm"
            style={{ backgroundColor: form.avatar_color }}>
            {initials(form.name)}
          </div>
          <div>
            <p className="font-semibold text-sm text-gray-900">{form.name}</p>
            <p className="text-xs text-gray-400">{form.role}</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-lg"><X size={15} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {[['name','Name'],['role','Role'],['description','Description']].map(([k, label]) => (
          <label key={k} className="block space-y-1">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">{label}</span>
            <input className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400"
              value={form[k] || ''} onChange={e => set(k, e.target.value)} />
          </label>
        ))}
        <div className="block space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">System Prompt</span>
            <AIPromptWizard
              name={form.name}
              role={form.role}
              description={form.description}
              currentPrompt={form.system_prompt}
              onAccept={prompt => set('system_prompt', prompt)}
              onError={setError}
            />
          </div>
          <textarea className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400 resize-y min-h-[120px]"
            rows={5} value={form.system_prompt || ''} onChange={e => set('system_prompt', e.target.value)} />
        </div>
        <div className="space-y-1">
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Provider & Model</span>
          <ProviderModelPicker form={form} set={set} />
        </div>
        <label className="block space-y-1">
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Avatar colour</span>
          <div className="flex gap-2 flex-wrap pt-1">
            {COLORS.map(c => (
              <button key={c} type="button" onClick={() => set('avatar_color', c)}
                className="w-6 h-6 rounded-full border-2 transition-all"
                style={{ backgroundColor: c, borderColor: form.avatar_color === c ? '#111' : 'transparent' }} />
            ))}
          </div>
        </label>
      </div>

      <div className="px-5 py-4 border-t border-gray-100 flex gap-3">
        {!config.is_ceo && (
          <button onClick={() => onRemove(agent)}
            className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl border border-gray-200 transition-all">
            <Trash2 size={15} />
          </button>
        )}
        <button onClick={handleSave} disabled={saving}
          className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl py-2 text-sm font-medium flex items-center justify-center gap-2">
          <Check size={14} /> {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      {error && (
        <div className="px-5 pb-4">
          <p className="text-red-500 text-xs bg-red-50 border border-red-100 rounded-xl px-3 py-2">{error}</p>
        </div>
      )}
    </div>
  )
}

// ── Agent node ────────────────────────────────────────────────────────────────

function AgentNode({ agent, pos, selected, isConnectTarget, onNodeMouseDown, onPortMouseDown, onInPortMouseUp, onClick, onDoubleClick }) {
  const { config } = agent

  return (
    <div
      style={{ left: pos.x, top: pos.y, width: NODE_W, position: 'absolute' }}
      className={`group select-none rounded-2xl border-2 bg-white shadow-sm cursor-grab active:cursor-grabbing transition-shadow
        ${selected       ? 'border-indigo-500 shadow-indigo-100 shadow-lg' : ''}
        ${isConnectTarget ? 'border-indigo-400 shadow-indigo-100 shadow-md' : ''}
        ${!selected && !isConnectTarget ? 'border-gray-200 hover:border-gray-300 hover:shadow-md' : ''}`}
      onMouseDown={e => {
        if (e.target.closest('[data-port]')) return
        onNodeMouseDown(agent, e)
      }}
      onClick={e => {
        e.stopPropagation()
        onClick(agent)
      }}
      onDoubleClick={e => {
        e.stopPropagation()
        onDoubleClick(agent)
      }}
    >
      {config.is_ceo && (
        <span className="absolute -top-2.5 left-3 text-[9px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-600 uppercase tracking-wide z-10">
          CEO
        </span>
      )}

      <div className="p-3 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm shrink-0"
          style={{ backgroundColor: config.avatar_color }}>
          {initials(config.name)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-900 text-sm truncate">{config.name}</p>
          <p className="text-xs text-gray-500 truncate">{config.role}</p>
        </div>
      </div>
      <div className="px-3 pb-3">
        <span className="text-[10px] text-gray-300 font-mono truncate block">{config.llm_provider}/{config.llm_model}</span>
      </div>

      {/* Input port — top */}
      <div
        data-port="in"
        className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 flex items-center justify-center cursor-crosshair"
        style={{ width: PORT_R * 2 + 10, height: PORT_R * 2 + 10 }}
        onMouseDown={e => e.stopPropagation()}
        onMouseUp={e => { e.stopPropagation(); onInPortMouseUp(agent) }}
      >
        <div
          className={`rounded-full border-2 transition-all pointer-events-none
            ${isConnectTarget
              ? 'bg-indigo-400 border-indigo-500 scale-150'
              : 'bg-white border-gray-300 group-hover:border-indigo-400 group-hover:scale-110'}`}
          style={{ width: PORT_R * 2, height: PORT_R * 2 }}
        />
      </div>

      {/* Output port — bottom */}
      <div
        data-port="out"
        className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 z-20 flex items-center justify-center cursor-crosshair"
        style={{ width: PORT_R * 2 + 10, height: PORT_R * 2 + 10 }}
        onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onPortMouseDown(agent, e) }}
      >
        <div
          className="rounded-full border-2 bg-white border-gray-300 hover:border-indigo-500 hover:bg-indigo-100 hover:scale-125 transition-all pointer-events-none"
          style={{ width: PORT_R * 2, height: PORT_R * 2 }}
        />
      </div>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

function getDefaultPos(agent, index) {
  if (agent.config.is_ceo) return { x: 80, y: 60 }
  const col = ((index - 1) % 3)
  const row = Math.floor((index - 1) / 3)
  return { x: 80 + col * 260, y: 220 + row * 150 }
}

export default function OrganisationView() {
  // TanStack queries — cached, auto-refetched, invalidated on mutations
  const { data: agentsData = [] } = useAgents()
  const { data: connectionsData = [] } = useConnections()

  // Also keep WS-driven agents for real-time status updates
  const wsAgents = useOrgStore(s => s.agents)
  // Prefer TanStack data for positions (authoritative from DB), merge WS status
  const agents = agentsData.length > 0 ? agentsData : wsAgents

  // Mutations with automatic cache invalidation
  const updateAgentMut = useUpdateAgent()
  const removeAgentMut = useRemoveAgent()
  const createConnMut  = useCreateConnection()
  const updateConnMut  = useUpdateConnection()
  const deleteConnMut  = useDeleteConnection()
  const savePosMut     = useSaveCanvasPositions()

  const canvasRef = useRef(null)

  const posRef = useRef({})
  const [positions, setPositions] = useState({})

  const [connections, setConnections] = useState([])
  const [selected, setSelected]       = useState(null)
  const [panelOpen, setPanelOpen]     = useState(false)
  const [selectedConn, setSelectedConn] = useState(null)
  const [showAddAgent, setShowAddAgent] = useState(false)
  const [labelModal, setLabelModal]   = useState(null)

  const nodeDrag = useRef(null)
  const connDrag = useRef(null)
  const [connLine, setConnLine] = useState(null)
  const saveTimer = useRef(null)

  // Sync connections from TanStack query data
  useEffect(() => {
    if (connectionsData.length > 0 || connections.length === 0) {
      setConnections(connectionsData.map(c => ({ fromId: c.from_id, toId: c.to_id, label: c.label })))
    }
  }, [connectionsData])

  // Sync canvas positions from TanStack agents data
  const dbLoaded = useRef(false)
  useEffect(() => {
    if (dbLoaded.current || agentsData.length === 0) return
    const loaded = {}
    for (const a of agentsData) {
      const cx = a.config?.canvas_x
      const cy = a.config?.canvas_y
      if (cx != null && cy != null && (cx !== 0 || cy !== 0)) {
        loaded[a.config.id] = { x: cx, y: cy }
        posRef.current[a.config.id] = { x: cx, y: cy }
      }
    }
    if (Object.keys(loaded).length > 0) {
      dbLoaded.current = true
      setPositions(prev => ({ ...prev, ...loaded }))
    }
  }, [agentsData])

  // Debounced save of canvas positions after drag
  function scheduleSavePositions() {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      savePosMut.mutate(posRef.current)
    }, 800)
  }

  function getPosFor(agent, i) {
    if (posRef.current[agent.config.id]) return posRef.current[agent.config.id]
    const p = getDefaultPos(agent, i)
    posRef.current[agent.config.id] = p
    return p
  }

  // ── Canvas mouse handlers ──────────────────────────────────────────────────

  const handleMouseMove = useCallback(e => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    if (nodeDrag.current) {
      const { agentId, offsetX, offsetY } = nodeDrag.current
      const newPos = { x: mx - offsetX, y: my - offsetY }
      posRef.current[agentId] = newPos
      setPositions(prev => ({ ...prev, [agentId]: newPos }))
    }

    if (connDrag.current) {
      setConnLine({ x1: connDrag.current.x1, y1: connDrag.current.y1, x2: mx, y2: my })
    }
  }, [])

  const handleMouseUp = useCallback(() => {
    if (nodeDrag.current) {
      nodeDrag.current = null
      scheduleSavePositions()
    }
    if (connDrag.current) {
      connDrag.current = null
      setConnLine(null)
    }
  }, [])

  function handleNodeMouseDown(agent, e) {
    e.stopPropagation()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const pos = posRef.current[agent.config.id] || { x: 0, y: 0 }
    nodeDrag.current = {
      agentId: agent.config.id,
      offsetX: e.clientX - rect.left - pos.x,
      offsetY: e.clientY - rect.top  - pos.y,
    }
  }

  function handlePortMouseDown(agent, e) {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const pos = posRef.current[agent.config.id]
    if (!pos) return
    const p = outPort(pos)
    connDrag.current = { fromId: agent.config.id, x1: p.x, y1: p.y }
    setConnLine({ x1: p.x, y1: p.y, x2: p.x, y2: p.y })
    setSelected(null)
    setSelectedConn(null)
  }

  function handleInPortMouseUp(toAgent) {
    if (!connDrag.current) return
    const { fromId } = connDrag.current
    connDrag.current = null
    setConnLine(null)
    const toId = toAgent.config.id
    if (fromId === toId) return
    if (connections.some(c => c.fromId === fromId && c.toId === toId)) return
    setLabelModal({ fromId, toId, initial: null })
  }

  async function confirmConnection(label) {
    if (!labelModal) return
    const { fromId, toId, initial } = labelModal

    if (initial != null) {
      setConnections(prev => prev.map(c =>
        c.fromId === fromId && c.toId === toId ? { ...c, label } : c
      ))
      updateConnMut.mutate({ from_id: fromId, to_id: toId, label })
    } else {
      setConnections(prev => [...prev, { fromId, toId, label }])
      createConnMut.mutate({ from_id: fromId, to_id: toId, label })
    }
    setLabelModal(null)
    setSelectedConn(null)
  }

  function handleConnClick(conn, labelX, labelY) {
    setSelectedConn({ ...conn, x: labelX, y: labelY })
    setSelected(null)
    setPanelOpen(false)
  }

  function handleEditConn() {
    if (!selectedConn) return
    const conn = connections.find(c => c.fromId === selectedConn.fromId && c.toId === selectedConn.toId)
    setLabelModal({ fromId: selectedConn.fromId, toId: selectedConn.toId, initial: conn?.label || '' })
    setSelectedConn(null)
  }

  function handleDeleteConn() {
    if (!selectedConn) return
    setConnections(prev => prev.filter(c => !(c.fromId === selectedConn.fromId && c.toId === selectedConn.toId)))
    deleteConnMut.mutate({ from_id: selectedConn.fromId, to_id: selectedConn.toId })
    setSelectedConn(null)
  }

  async function handleRemove(agent) {
    if (!confirm(`Remove ${agent.config.name}?`)) return
    removeAgentMut.mutate(agent.config.id)
    delete posRef.current[agent.config.id]
    setPositions(prev => { const n = { ...prev }; delete n[agent.config.id]; return n })
    setConnections(prev => prev.filter(c => c.fromId !== agent.config.id && c.toId !== agent.config.id))
    if (selected?.config?.id === agent.config.id) setSelected(null)
  }

  async function handleSave(form) {
    await updateAgentMut.mutateAsync({ id: selected.config.id, data: form })
  }

  const selectedAgent = selected ? agents.find(a => a.config.id === selected.config.id) : null

  // Build connection paths with smart bezier
  const livePaths = connections.map(conn => {
    const fp = posRef.current[conn.fromId]
    const tp = posRef.current[conn.toId]
    if (!fp || !tp) return null
    const p1 = outPort(fp), p2 = inPort(tp)
    const { d, labelX, labelY } = smartBezier(p1.x, p1.y, p2.x, p2.y)
    const isSelected = selectedConn?.fromId === conn.fromId && selectedConn?.toId === conn.toId
    return { ...conn, d, labelX, labelY, isSelected }
  }).filter(Boolean)

  function handleCanvasClick() {
    setSelected(null)
    setSelectedConn(null)
    setPanelOpen(false)
  }

  return (
    <div className="flex h-full overflow-hidden bg-slate-50">

      {/* Canvas */}
      <div
        ref={canvasRef}
        className="flex-1 relative overflow-hidden"
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleCanvasClick}
      >
        <DotGrid />

        {/* SVG: connections + preview */}
        {/* SVG layer 1: visible lines (below nodes) */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none z-10">
          <defs>
            <marker id="arr" markerWidth="10" markerHeight="10" refX="9" refY="4" orient="auto">
              <path d="M0,0 L0,8 L10,4 z" fill="#818cf8" />
            </marker>
            <marker id="arr-sel" markerWidth="10" markerHeight="10" refX="9" refY="4" orient="auto">
              <path d="M0,0 L0,8 L10,4 z" fill="#6366f1" />
            </marker>
            <marker id="arr-p" markerWidth="10" markerHeight="10" refX="9" refY="4" orient="auto">
              <path d="M0,0 L0,8 L10,4 z" fill="#f59e0b" />
            </marker>
          </defs>

          {livePaths.map(p => (
            <g key={`${p.fromId}-${p.toId}`}>
              <path
                d={p.d}
                fill="none"
                stroke={p.isSelected ? '#6366f1' : '#a5b4fc'}
                strokeWidth={p.isSelected ? 2.5 : 2}
                markerEnd={p.isSelected ? 'url(#arr-sel)' : 'url(#arr)'}
              />
              {p.label && (
                <g>
                  <rect
                    x={p.labelX - p.label.length * 3.2 - 8}
                    y={p.labelY - 10}
                    width={p.label.length * 6.4 + 16}
                    height={18}
                    rx={9}
                    fill={p.isSelected ? '#eef2ff' : 'white'}
                    stroke={p.isSelected ? '#a5b4fc' : '#e5e7eb'}
                    strokeWidth="1"
                  />
                  <text x={p.labelX} y={p.labelY + 3} textAnchor="middle" fontSize="10" fontWeight="500"
                    fill={p.isSelected ? '#4338ca' : '#6366f1'}>{p.label}</text>
                </g>
              )}
            </g>
          ))}

          {connLine && (
            <path
              d={previewBezier(connLine.x1, connLine.y1, connLine.x2, connLine.y2)}
              fill="none" stroke="#f59e0b" strokeWidth="2" strokeDasharray="6 3"
              markerEnd="url(#arr-p)"
            />
          )}
        </svg>

        {/* SVG layer 2: invisible hit areas (above nodes) */}
        <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: 'none', zIndex: 25 }}>
          {livePaths.map(p => (
            <path
              key={`hit-${p.fromId}-${p.toId}`}
              d={p.d}
              fill="none"
              stroke="transparent"
              strokeWidth="24"
              style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
              onClick={e => { e.stopPropagation(); handleConnClick(p, p.labelX, p.labelY) }}
            />
          ))}
        </svg>

        {/* Connection popover */}
        {selectedConn && (
          <ConnPopover
            x={selectedConn.x}
            y={selectedConn.y}
            label={selectedConn.label}
            onEdit={handleEditConn}
            onDelete={handleDeleteConn}
            onClose={() => setSelectedConn(null)}
          />
        )}

        {/* Nodes */}
        <div className="absolute inset-0 z-20 pointer-events-none [&>*]:pointer-events-auto">
          {agents.map((agent, i) => {
            const pos = getPosFor(agent, i)
            const isConnectTarget = !!connDrag.current && connDrag.current.fromId !== agent.config.id
            return (
              <AgentNode
                key={agent.config.id}
                agent={agent}
                pos={positions[agent.config.id] || pos}
                selected={selectedAgent?.config?.id === agent.config.id}
                isConnectTarget={isConnectTarget}
                onNodeMouseDown={handleNodeMouseDown}
                onPortMouseDown={handlePortMouseDown}
                onInPortMouseUp={handleInPortMouseUp}
                onClick={a => {
                  setSelectedConn(null)
                  setSelected(prev => prev?.config?.id === a.config.id ? prev : a)
                  setPanelOpen(false)
                }}
                onDoubleClick={a => {
                  setSelectedConn(null)
                  setSelected(a)
                  setPanelOpen(true)
                }}
              />
            )
          })}
        </div>

        {/* Empty state */}
        {agents.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 gap-3 z-30 pointer-events-none">
            <Network size={40} strokeWidth={1.5} />
            <p className="text-sm font-medium">No agents yet</p>
            <button className="pointer-events-auto mt-1 flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700"
              onClick={() => setShowAddAgent(true)}>
              <Plus size={14} /> Add Agent
            </button>
          </div>
        )}

        {/* Toolbar */}
        <div className="absolute top-4 right-4 z-30 flex flex-col items-end gap-2">
          <button onClick={() => setShowAddAgent(true)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium shadow-md transition-colors">
            <Plus size={15} /> Add Agent
          </button>
          {connLine && (
            <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700 font-medium shadow">
              Drop on a node's left port to connect
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="absolute bottom-4 left-4 z-30 text-xs text-gray-400 bg-white/80 px-3 py-1.5 rounded-xl border border-gray-100 shadow-sm select-none">
          {agents.length} agent{agents.length !== 1 ? 's' : ''} · {connections.length} connection{connections.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Edit panel */}
      {selectedAgent && panelOpen && (
        <EditPanel
          agent={selectedAgent}
          onClose={() => { setSelected(null); setPanelOpen(false) }}
          onSave={handleSave}
          onRemove={handleRemove}
        />
      )}

      {labelModal && (
        <LabelModal
          title={labelModal.initial != null ? 'Edit connection label' : 'Label this connection'}
          initial={labelModal.initial}
          onConfirm={confirmConnection}
          onCancel={() => setLabelModal(null)}
        />
      )}
      {showAddAgent && <AgentModal onClose={() => setShowAddAgent(false)} />}

      {/* Hover styles for connections */}
      <style>{`
        .conn-hover-trigger:hover ~ path { stroke: #4f46e5 !important; }
      `}</style>
    </div>
  )
}
