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
import CodeMirror from '@uiw/react-codemirror'
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript'
import { python, pythonLanguage } from '@codemirror/lang-python'
import { json, jsonLanguage } from '@codemirror/lang-json'
import { linter, lintGutter } from '@codemirror/lint'
import { Decoration, ViewPlugin, EditorView } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import {
  ArrowLeft, Save, Play, Globe, Code2, GitFork, Repeat, Merge as MergeIcon,
  Sparkles, Hand, Loader2, CheckCircle2, AlertCircle, ShieldCheck, ShieldAlert,
  ShieldX, X, Copy, Timer, Workflow, Reply, CircleSlash, Plus, Search, Pencil,
  Split, Filter as FilterIcon, OctagonAlert, SlidersHorizontal, CalendarClock, Clock,
  UserCheck, Zap, Trash2, ChevronRight, ChevronLeft, ChevronDown, Hash, Type as TypeIcon,
  ToggleLeft, Braces, Brackets, GripVertical, Info, Variable, FileDown, FileUp,
  FolderOpen, Folder, FileText, Ban, Target, History, Check,
} from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'

// ── Node-type catalogue ───────────────────────────────────────────────────────
// Each node: { label, desc, icon, color, fields, custom?, outputs?(node)=>handles }
const NODE_META = {
  trigger: { label: 'Trigger', desc: 'Entry point — manual, schedule, webhook or agent', icon: Zap, color: '#6366f1', custom: 'trigger', fields: [] },
  http: { label: 'HTTP Request', desc: 'Make an API call and use the response', icon: Globe, color: '#0ea5e9', custom: 'http', fields: [] },
  code: { label: 'Code', desc: 'Run custom Python or JavaScript', icon: Code2, color: '#a855f7', custom: 'code', fields: [] },
  set: { label: 'Edit Fields', desc: 'Add, set or override fields on the item', icon: SlidersHorizontal, color: '#8b5cf6', custom: 'set', fields: [] },
  datetime: { label: 'Date & Time', desc: 'Get or transform a timestamp', icon: CalendarClock, color: '#0d9488', fields: [
    { key: 'action', label: 'Action', type: 'select', options: ['now', 'format', 'add'] },
    { key: 'value', label: 'Source value (for format/add)', type: 'text', placeholder: '{{trigger.created_at}}' },
    { key: 'format', label: 'Output format (for format)', type: 'text', placeholder: '%Y-%m-%d' },
    { key: 'seconds', label: 'Offset seconds (for add)', type: 'number' },
  ] },
  if: { label: 'If', desc: 'Route to true / false branches', icon: GitFork, color: '#f59e0b', fields: [
    { key: 'lang', label: 'Expression language', type: 'select', options: ['python', 'javascript'] },
    { key: 'condition', label: 'Condition (supports {{tokens}}, && and ||)', type: 'text', placeholder: "{{Code.output}} > 1 && {{Code.output}} < 3" },
  ] },
  switch: { label: 'Switch', desc: 'Route to many outputs by ordered rules', icon: Split, color: '#f97316', custom: 'switch', fields: [] },
  loop: { label: 'Loop Over Items', desc: 'Iterate an array; run the body per item', icon: Repeat, color: '#14b8a6', fields: [
    { key: 'items_field', label: 'Array field to iterate (one {{token}} or a path)', type: 'text', placeholder: '{{Code.items}}' },
  ] },
  merge: { label: 'Merge', desc: 'Combine multiple inputs into one', icon: MergeIcon, color: '#64748b', fields: [
    { key: 'mode', label: 'Mode', type: 'select', options: ['append', 'combine', 'chooseBranch'] },
    { key: 'number_of_inputs', label: 'Number of inputs', type: 'select', options: ['2', '3', '4', '5', '6', '7', '8', '9', '10'],
      showIf: c => (c.mode || 'append') !== 'combine' },
    { key: 'combine_by', label: 'Combine by', type: 'select', options: ['matchingFields', 'position', 'allCombinations'],
      showIf: c => c.mode === 'combine' },
    { key: 'fields_to_match', label: 'Fields to match (comma-separated)', type: 'text', placeholder: 'id, email',
      showIf: c => c.mode === 'combine' && (c.combine_by || 'matchingFields') === 'matchingFields' },
    { key: 'output_type', label: 'Output type', type: 'select', options: ['keepMatches', 'keepNonMatches', 'keepEverything', 'enrichInput1', 'enrichInput2'],
      showIf: c => c.mode === 'combine' && (c.combine_by || 'matchingFields') === 'matchingFields' },
    { key: 'fuzzy', label: 'Fuzzy compare — treat "3" and 3 as equal', type: 'checkbox',
      showIf: c => c.mode === 'combine' && (c.combine_by || 'matchingFields') === 'matchingFields' },
    { key: 'clash', label: 'On clashing fields, prioritise', type: 'select', options: ['input2', 'input1'],
      showIf: c => c.mode === 'combine' },
    { key: 'branch', label: 'Branch to output, 1-based', type: 'number', placeholder: '1',
      showIf: c => c.mode === 'chooseBranch' },
  ] },
  filter: { label: 'Filter', desc: 'Continue only if the condition holds', icon: FilterIcon, color: '#22c55e', fields: [
    { key: 'lang', label: 'Expression language', type: 'select', options: ['python', 'javascript'] },
    { key: 'condition', label: 'Keep when (supports {{tokens}}, && and ||)', type: 'text', placeholder: "{{Code.output}} > 0" },
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
  variable: { label: 'Variable', desc: 'Assign a named value (overwritable; read as {{name}})', icon: Variable, color: '#0d9488', fields: [
    { key: 'name', label: 'Variable name', type: 'text', placeholder: 'myVar' },
    { key: 'value', label: 'Value (supports {{tokens}}; defaults to input)', type: 'text', placeholder: '{{HTTP Request.body.id}}' },
  ] },
  write_file: { label: 'Write File', desc: 'Write content to a file on disk', icon: FileDown, color: '#0284c7', fields: [
    { key: 'path', label: 'File path', type: 'filepath', pickMode: 'write', placeholder: '/tmp/output.json' },
    { key: 'content', label: 'Content (supports {{tokens}}; defaults to input)', type: 'textarea', placeholder: '{{Code.output}}' },
    { key: 'mode', label: 'Mode', type: 'select', options: ['overwrite', 'append'] },
  ] },
  read_file: { label: 'Read File', desc: 'Read a file from disk into the workflow', icon: FileUp, color: '#ca8a04', fields: [
    { key: 'path', label: 'File path', type: 'filepath', pickMode: 'read', placeholder: '/tmp/input.json' },
    { key: 'parse_json', label: 'Parse content as JSON (adds a json field)', type: 'checkbox' },
  ] },
  websearch: { label: 'Web Search', desc: 'Search the web in real time for fresh data', icon: Search, color: '#7c3aed', fields: [
    { key: 'query', label: 'Search query (supports {{tokens}})', type: 'textarea', placeholder: 'latest AI chip news {{today}}' },
    { key: 'max_results', label: 'Max results', type: 'number', placeholder: '5' },
    { key: 'fetch_content', label: 'Fetch full page content of top results (higher accuracy)', type: 'checkbox' },
  ] },
}

// Palette grouping (n8n-style categories).
const CATEGORIES = [
  { id: 'trigger', label: 'Add Trigger', hint: 'How this workflow starts', kinds: ['trigger', 'error_trigger'] },
  { id: 'core', label: 'Core', kinds: ['http', 'code', 'respond', 'subworkflow', 'wait', 'noop'] },
  { id: 'flow', label: 'Flow', kinds: ['if', 'switch', 'loop', 'merge', 'filter', 'stop_error'] },
  { id: 'transform', label: 'Data transformation', kinds: ['set', 'variable', 'datetime', 'code'] },
  { id: 'files', label: 'Files', kinds: ['read_file', 'write_file'] },
  { id: 'ai', label: 'AI', kinds: ['llm', 'websearch'] },
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

// Merge shows N numbered input ports (n8n-style). Combine is always 2 inputs;
// otherwise honour the configured Number of inputs.
function inputHandles(data) {
  if (data.kind !== 'merge') return null
  const n = data.config?.mode === 'combine' ? 2 : (parseInt(data.config?.number_of_inputs) || 2)
  return Array.from({ length: n }, (_, i) => ({ id: `input-${i}`, label: String(i + 1) }))
}

// ── Custom node ───────────────────────────────────────────────────────────────
function WfNode({ id, data, selected }) {
  const meta = NODE_META[data.kind] || NODE_META.code
  const Icon = meta.icon
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(data.label || meta.label)
  const handles = outputHandles(data)
  const inputs = inputHandles(data)
  const multi = handles.length > 1
  // Grow the box so every output/input handle gets its own row (≈26px each)
  // instead of cramming together and spilling below the node.
  const rows = Math.max(handles.length, inputs?.length || 0)
  const minHeight = rows > 1 ? rows * 26 + 12 : undefined

  function commit() {
    setEditing(false)
    if (data.onRename) data.onRename(id, draft.trim() || meta.label)
  }

  return (
    <div style={{ minHeight }} className={`bg-white rounded-xl border shadow-sm w-[190px] px-3 py-2.5 transition-all
      ${selected ? 'border-indigo-500 shadow-md' : 'border-gray-200'} ${STATUS_RING[data.status] || ''}`}>
      {inputs ? inputs.map((h, i) => {
        const top = `${(100 / (inputs.length + 1)) * (i + 1)}%`
        return (
          <React.Fragment key={h.id}>
            <Handle id={h.id} type="target" position={Position.Left} style={{ top }}
              className="!w-2.5 !h-2.5 !bg-gray-300 !border-2 !border-white" />
            {inputs.length > 1 && (
              <span className="absolute text-[9px] text-gray-400 pointer-events-none"
                style={{ top: `calc(${top} - 7px)`, left: -4, transform: 'translateX(-100%)' }}>{h.label}</span>
            )}
          </React.Fragment>
        )
      }) : (!NODE_META[data.kind]?.entry && data.kind !== 'trigger' && <Handle type="target" position={Position.Left} className="!w-2.5 !h-2.5 !bg-gray-300 !border-2 !border-white" />)}
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

// Conversational workflow builder. Chats with the user, captures the business
// objective first, then writes the AI-generated graph onto the canvas each turn.
// Last-resort guard: never render a raw JSON blob in the chat. If a reply still
// looks like the builder's {"reply":...,"graph":...} object, pull out the reply.
function cleanReply(reply) {
  const s = String(reply || '').trim()
  if (!s) return '(no reply)'
  if (s.startsWith('{') && /"reply"\s*:/.test(s)) {
    const m = s.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')
    return "I've updated the workflow. Tell me what else you'd like to change."
  }
  return s
}

// Deterministic left→right layered layout so an AI-generated graph is always tidy,
// regardless of the (often rough) x/y coordinates the model guessed. Columns = longest
// path depth from the roots; nodes in a column are stacked and vertically centred.
function layoutGraph(nodes, edges) {
  if (!nodes || !nodes.length) return nodes || []
  const fwd = (edges || []).filter(e => !String(e.id || '').startsWith('wfback') && e.source && e.target)
  const preds = new Map(nodes.map(n => [n.id, []]))
  fwd.forEach(e => { if (preds.has(e.target)) preds.get(e.target).push(e.source) })
  const depth = new Map(); const visiting = new Set()
  const calc = (id) => {
    if (depth.has(id)) return depth.get(id)
    if (visiting.has(id)) return 0            // cycle guard — treat back-edge as no depth
    visiting.add(id)
    const ps = preds.get(id) || []
    const d = ps.length ? Math.max(...ps.map(p => calc(p) + 1)) : 0
    visiting.delete(id); depth.set(id, d); return d
  }
  nodes.forEach(n => calc(n.id))
  const cols = new Map()
  nodes.forEach(n => { const d = depth.get(n.id) || 0; if (!cols.has(d)) cols.set(d, []); cols.get(d).push(n.id) })
  const COL_W = 280, ROW_H = 130, X0 = 80, YC = 260, pos = new Map()
  ;[...cols.keys()].sort((a, b) => a - b).forEach(d => {
    const ids = cols.get(d)
    ids.forEach((id, i) => pos.set(id, { x: X0 + d * COL_W, y: YC + (i - (ids.length - 1) / 2) * ROW_H }))
  })
  return nodes.map(n => ({ ...n, position: pos.get(n.id) || n.position || { x: X0, y: YC } }))
}

function AIAssistPanel({ objective, wfId, getGraph, onApply, onClose, history, onHistory }) {
  const [messages, setMessages] = useState(
    (history && history.length) ? history : [
      { role: 'assistant', content: objective
        ? `This flow's objective is: "${objective}". Tell me what you'd like to add or change and I'll update the workflow.`
        : 'What is the main business objective for this flow — and why does it matter to your business? Tell me the outcome you\'re after, not the technical steps, so I can design the best workflow for it.' },
    ])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [obj, setObj] = useState(objective || '')
  const [error, setError] = useState('')
  const [awaitConfirm, setAwaitConfirm] = useState(false)  // last turn flagged HIGH risk
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight) }, [messages, busy])

  async function send(text, { riskConfirmed = false } = {}) {
    text = (typeof text === 'string' ? text : input).trim()
    if (!text || busy) return
    // The opener always asks for the objective, so the first user message IS the
    // objective — capture it deterministically rather than relying on the model.
    const isFirstUser = messages.every(m => m.role !== 'user')
    const nextObj = obj || (isFirstUser ? text : '')
    const convo = [...messages, { role: 'user', content: text }]
    setMessages(convo); setInput(''); setBusy(true); setError(''); setObj(nextObj); setAwaitConfirm(false)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    try {
      const res = await fetch('/api/workflows/ai-build', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: convo, graph: getGraph(), objective: nextObj,
          wf_id: wfId, risk_confirmed: riskConfirmed }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'AI build failed')
      const data = await res.json()
      const finalObj = data.objective || nextObj
      setObj(finalObj)
      onApply(data.graph || getGraph(), finalObj)
      const next = [...convo, { role: 'assistant', content: cleanReply(data.reply),
        risk: data.risk, verification: data.verification }]
      setMessages(next)
      setAwaitConfirm(!!data.needs_confirmation)
      onHistory && onHistory(next)
    } catch (e) { setError(String(e.message || e)) } finally { setBusy(false) }
  }

  return (
    <div className="w-[340px] shrink-0 border-r border-gray-100 bg-white flex flex-col">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center"><Sparkles size={15} className="text-indigo-600" /></div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-gray-800">AI Assist</div>
          <div className="text-[11px] text-gray-400">Build this flow by chatting</div>
        </div>
        {onClose && <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={16} /></button>}
      </div>
      {obj && (
        <div className="px-4 py-2 bg-indigo-50/50 border-b border-indigo-100 text-[11px] text-indigo-700">
          <span className="font-semibold">Objective:</span> {obj}
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div className={`max-w-[85%] px-3 py-2 rounded-2xl text-[13px] whitespace-pre-wrap select-text cursor-text ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-800'}`}>{m.content}</div>
            {m.risk && m.risk.level && (
              <div className={`mt-1 max-w-[85%] text-[11px] px-2 py-1 rounded-lg border flex items-center gap-1.5 ${RISK_LEVEL_STYLE[(m.risk.level || '').toLowerCase()]?.bg || 'bg-gray-50 border-gray-200'}`}>
                <ShieldCheck size={12} className={RISK_LEVEL_STYLE[(m.risk.level || '').toLowerCase()]?.text || 'text-gray-500'} />
                <span className={RISK_LEVEL_STYLE[(m.risk.level || '').toLowerCase()]?.text || 'text-gray-600'}>
                  Compliance: <b>{(m.risk.level || 'n/a').toUpperCase()}</b>
                  {m.risk.score != null && <> · score {m.risk.score}/{m.risk.threshold}</>}
                  {m.risk.reviewer && <> · {m.risk.reviewer}</>}
                </span>
              </div>
            )}
            {m.verification && (() => {
              const v = m.verification
              const ok = v.ran_ok && v.meets_objective === 'yes'
              const ranButUnmet = v.ran_ok && v.meets_objective !== 'yes'  // runs, objective not confirmed
              const style = ok ? 'bg-green-50 border-green-200 text-green-700'
                : ranButUnmet ? 'bg-amber-50 border-amber-200 text-amber-700'
                : 'bg-red-50 border-red-200 text-red-700'
              return (
                <div className={`mt-1 max-w-[85%] text-[11px] px-2 py-1 rounded-lg border flex items-center gap-1.5 ${style}`}>
                  {ok ? <><CheckCircle2 size={12} /> Verified · runs clean & meets objective</>
                    : ranButUnmet ? <><AlertCircle size={12} /> Runs, but objective {v.meets_objective === 'unknown' ? 'unconfirmed' : v.meets_objective}{v.note ? ` — ${v.note}` : ''}</>
                    : <><AlertCircle size={12} /> Verification: {v.error || `objective ${v.meets_objective}`}</>}
                </div>
              )
            })()}
          </div>
        ))}
        {busy && <div className="flex justify-start"><div className="px-3 py-2 rounded-2xl bg-gray-100 text-gray-400 text-[13px] flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Thinking…</div></div>}
        {error && <div className="text-[11px] text-red-500 bg-red-50 border border-red-100 rounded-lg px-2 py-1.5">{error}</div>}
      </div>
      <div className="p-3 border-t border-gray-100">
        {awaitConfirm && (
          <div className="mb-2 flex items-center gap-2">
            <button onClick={() => send('Proceed as-is — I confirm the risk.', { riskConfirmed: true })}
              className="flex-1 text-[12px] font-medium px-2 py-1.5 rounded-lg bg-amber-100 text-amber-800 hover:bg-amber-200">
              Proceed anyway
            </button>
            <button onClick={() => inputRef.current?.focus()}
              className="flex-1 text-[12px] font-medium px-2 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
              Suggest a safer way
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea ref={inputRef} rows={1} value={input}
            onChange={e => { setInput(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px' }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder="Ask anything…"
            className="flex-1 resize-none border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400 overflow-y-auto" style={{ maxHeight: 160 }} />
          <button onClick={send} disabled={busy || !input.trim()}
            className="p-2 rounded-xl bg-indigo-600 text-white disabled:opacity-40 hover:bg-indigo-700"><ChevronRight size={18} /></button>
        </div>
      </div>
    </div>
  )
}

function EditorInner({ workflowId, onBack, aiAssist }) {
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
  const [objective, setObjective] = useState('')
  const [improving, setImproving] = useState(false)
  const [improveResult, setImproveResult] = useState(null)
  const [showObjective, setShowObjective] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [improveBanner, setImproveBanner] = useState(null)
  const [improveProgress, setImproveProgress] = useState(null)  // {step,total,label} while applying
  const [assistOpen, setAssistOpen] = useState(!!aiAssist)   // AI builder panel — on by default for AI-created flows
  const [aiChat, setAiChat] = useState([])                   // persisted AI Assist conversation

  const renameNode = useCallback((id, label) => {
    setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, label } } : n))
  }, [])

  const loadWorkflow = useCallback(async () => {
    const wf = await getWorkflow(workflowId)
    if (!wf) return
    setName(wf.name); setStatus(wf.status); setRequireCompliance(!!wf.require_compliance)
    setTriggerConfig(wf.trigger_config || {}); setObjective(wf.objective || ''); setAiChat(wf.ai_chat || [])
    setNodes((wf.graph?.nodes || []).map(n => ({ ...n, type: n.type, data: { ...n.data, kind: n.type } })))
    setEdges((wf.graph?.edges || []).map(e => ({
      ...e, id: e.id || `${e.source}-${e.sourceHandle || ''}-${e.target}`, animated: true,
    })))
    setRuns(wf.runs || [])
  }, [workflowId, getWorkflow])

  useEffect(() => { loadWorkflow() }, [loadWorkflow])

  const webhookUrl = triggerConfig.token
    ? `${window.location.origin}/api/hooks/workflow/${workflowId}?token=${triggerConfig.token}`
    : ''

  // Merge live run status + the rename callback into node visuals.
  const liveNodes = useMemo(() => nodes.map(n => ({
    ...n, data: { ...n.data, status: wfRun?.steps?.[n.id]?.status, onRename: renameNode },
  })), [nodes, wfRun, renameNode])

  // Display edges: smoothstep so they bend at right angles (esp. backward loop-backs),
  // loop-back edges drawn dashed/grey, and the loop's 'loop' edge labelled with the
  // item count from the last run.
  const displayEdges = useMemo(() => edges.map(e => {
    const isBack = String(e.id || '').startsWith('wfback_')
    const src = nodes.find(n => n.id === e.source)
    // Count of items flowing down this edge from the source's last run (n8n-style).
    const out = wfRun?.steps?.[e.source]?.output
    let cnt
    if (out != null) {
      if (src?.data?.kind === 'loop') cnt = e.sourceHandle === 'loop' ? out.count : 1
      else if (Array.isArray(out)) cnt = out.length
      else if (Array.isArray(out.items)) cnt = out.items.length
      else cnt = 1
    }
    const label = cnt != null ? `${cnt} item${cnt === 1 ? '' : 's'}` : undefined
    return {
      ...e, type: 'smoothstep', label,
      style: isBack ? { stroke: '#94a3b8', strokeDasharray: '5 4' } : e.style,
      labelStyle: { fontSize: 10, fill: '#4f46e5', fontWeight: 600 },
      labelBgStyle: { fill: '#eef2ff' }, labelBgPadding: [4, 2], labelBgBorderRadius: 4,
    }
  }), [edges, nodes, wfRun])

  const onNodesChange = useCallback((c) => setNodes(ns => applyNodeChanges(c, ns)), [])
  const onEdgesChange = useCallback((c) => setEdges(es => applyEdgeChanges(c, es)), [])
  const onConnect = useCallback((params) => setEdges(es => addEdge({ ...params, animated: true }, es)), [])

  function addNode(kind) {
    const id = newId(kind)
    const cfg = kind === 'switch' ? { rules: [{ condition: '', label: '' }] }
      : kind === 'websearch' ? { fetch_content: true }
      : {}
    // Drop the node at the center of whatever the user is currently viewing.
    let position = { x: 360, y: 160 }
    const pane = document.querySelector('.react-flow')
    if (pane && rf?.screenToFlowPosition) {
      const r = pane.getBoundingClientRect()
      const c = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      position = { x: c.x - 95, y: c.y - 30 }   // offset by ~half node size so it lands centered
    }
    // A Loop comes with a starter body: a "Replace Me" node on the loop branch whose
    // end loops back into the Loop (n8n-style). The loop-back edge is visual only
    // (id `wfback_*`) — the engine fans the body out per item on its own.
    if (kind === 'loop') {
      const bodyId = newId('noop')
      setNodes(ns => [...ns,
        { id, type: 'loop', position, data: { label: NODE_META.loop.label, kind: 'loop', config: {} } },
        { id: bodyId, type: 'noop', position: { x: position.x + 240, y: position.y + 12 },
          data: { label: 'Replace Me', kind: 'noop', config: {} } },
      ])
      setEdges(es => [...es,
        { id: `${id}-loop-${bodyId}`, source: id, sourceHandle: 'loop', target: bodyId, animated: true },
        { id: `wfback_${bodyId}_${id}`, source: bodyId, target: id, animated: true },
      ])
      setSelectedId(id)
      setPaletteOpen(false)
      return
    }
    setNodes(ns => [...ns, {
      id, type: kind, position,
      data: { label: NODE_META[kind].label, kind, config: cfg },
    }])
    setSelectedId(id)       // place + select on the canvas; double-click opens its detail view
    setPaletteOpen(false)
  }

  // Copy/paste the selected node with Cmd/Ctrl+C / Cmd/Ctrl+V. Ignored while typing
  // in a field (input/textarea/CodeMirror) so normal text copy/paste still works.
  const clipboardRef = useRef(null)   // { node, pastes }
  useEffect(() => {
    const editable = el => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    const hasTextSelection = () => {
      const s = window.getSelection && window.getSelection()
      return !!(s && s.toString().trim())
    }
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || editable(document.activeElement)) return
      const k = e.key.toLowerCase()
      if (k === 'c') {
        // Don't hijack Cmd+C when the user has actually selected text (e.g. in a chat
        // bubble) — let the browser copy the text. Only copy the node when nothing is selected.
        if (hasTextSelection()) return
        const n = nodes.find(x => x.id === selectedId)
        if (n) { clipboardRef.current = { node: n, pastes: 0 }; e.preventDefault() }
      } else if (k === 'v' && clipboardRef.current) {
        e.preventDefault()
        const { node: src } = clipboardRef.current
        const kind = src.data.kind
        const n = ++clipboardRef.current.pastes
        const id = newId(kind)
        const copy = {
          id, type: src.type,
          position: { x: (src.position?.x || 0) + 40 * n, y: (src.position?.y || 0) + 40 * n },
          data: { label: `${src.data.label || NODE_META[kind].label} copy`, kind,
                  config: JSON.parse(JSON.stringify(src.data.config || {})) },
        }
        setNodes(ns => [...ns, copy])
        setSelectedId(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nodes, selectedId])

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

  // Replace the canvas with an AI-generated graph (used by the AI Assist builder).
  function applyGraph(graph) {
    // Reconcile in place: preserve each kept node's measured dimensions (and seed a
    // default for new ones) so edges keep rendering. RF v12 hides an edge whenever an
    // endpoint lacks `measured` — and rapid successive applyGraph calls during streaming
    // would otherwise rebuild nodes bare and make every edge vanish.
    const laidOut = layoutGraph(graph?.nodes || [], graph?.edges || [])
    setNodes(prev => {
      const byId = new Map(prev.map(n => [n.id, n]))
      return laidOut.map(n => {
        const ex = byId.get(n.id)
        const base = { ...n, type: n.type, data: { ...n.data, kind: n.type } }
        // Seed dims matching the real node (w-[190px], ~56px tall) so edge endpoints
        // anchor correctly before RF re-measures — a wrong guess floats the handles.
        const measured = ex?.measured || { width: 190, height: 56 }
        // Use the freshly computed tidy position (overrides the model's guessed x/y).
        return ex ? { ...ex, ...base, position: n.position, measured }
                  : { ...base, width: 190, height: 56, measured }
      })
    })
    setEdges((graph?.edges || []).map(e => {
      // The default output handle renders with id=undefined, so an AI-emitted
      // sourceHandle:"source" (or a blank one) won't match and the edge floats.
      const sh = (e.sourceHandle && e.sourceHandle !== 'source') ? e.sourceHandle : undefined
      return { ...e, sourceHandle: sh,
        id: e.id || `${e.source}-${sh || ''}-${e.target}`, animated: true }
    }))
  }

  async function handleSave() {
    setSaving(true)
    const trigger = pickTrigger(nodes)
    const tcfg = trigger?.data?.config || {}
    const trigger_type = tcfg.triggerType || 'manual'
    const trigger_config = { ...triggerConfig }
    if (trigger_type === 'schedule') trigger_config.cron = scheduleToCron(tcfg.schedule)
    if (trigger_type === 'webhook') trigger_config.response_mode = tcfg.responseMode || 'auto'
    if (tcfg.sample) trigger_config.payload = tcfg.sample
    const wf = await saveWorkflow(workflowId, { name, graph: buildGraph(), require_compliance: requireCompliance, trigger_type, trigger_config, objective })
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

  async function handleImprove() {
    setImproving(true)
    try {
      await handleSave()   // persist latest objective + graph so the analysis is current
      const res = await fetch(`/api/workflows/${workflowId}/improve`, { method: 'POST' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Improve failed')
      setImproveResult(await res.json())
    } catch (e) {
      setImproveResult({ error: String(e.message || e), suggestions: [] })
    } finally { setImproving(false) }
  }

  // Apply suggestions one at a time, streaming progress: the canvas updates live as
  // the AI implements each suggestion, then a final review pass stitches it together.
  async function handleApplyImprove() {
    setImproving(true)
    const total = improveResult?.suggestions?.length || 1
    try {
      await handleSave()
      setImproveResult(null)
      setImproveBanner(null)
      setImproveProgress({ step: 0, total, label: 'Starting…' })
      const res = await fetch(`/api/workflows/${workflowId}/improve/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestions: improveResult?.suggestions || [], analysis: improveResult?.analysis || '' }),
      })
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).detail || 'Improve failed')

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = '', lastError = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 2)
          if (!line.startsWith('data:')) continue
          let ev; try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
          if (ev.graph) { applyGraph(ev.graph); requestAnimationFrame(() => rf?.fitView?.({ padding: 0.2 })) }
          if (ev.type === 'step') setImproveProgress({ step: ev.index + 1, total: ev.total, label: ev.title })
          else if (ev.type === 'review') setImproveProgress({ step: total, total, label: 'Reviewing & stitching the flow together…' })
          else if (ev.type === 'verify') setImproveProgress({ step: total, total,
            label: ev.ok ? '✓ Verified — flow is connected and wired'
                         : `Verifying (attempt ${ev.attempt}/${ev.max}) — fixing ${ev.problems.length} issue(s)…` })
          else if (ev.type === 'done') { setImproveProgress(null); setImproveBanner(ev.summary || 'AI improvements applied as a draft.') }
          else if (ev.type === 'error') lastError = ev.message
        }
      }
      if (lastError) { setImproveProgress(null); setImproveResult({ error: lastError, suggestions: [] }) }
    } catch (e) {
      setImproveProgress(null); setImproveResult({ error: String(e.message || e), suggestions: [] })
    } finally { setImproving(false) }
  }

  // Snapshot the current canvas as a new (active) version. Label is optional —
  // the backend names it "Version N" when blank.
  async function saveAsNewVersion(label = '') {
    await handleSave()
    const res = await fetch(`/api/workflows/${workflowId}/versions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: buildGraph(), label }),
    })
    if (res.ok) { setImproveBanner(null); await loadWorkflow() }
    return res.ok
  }

  async function activateVersion(version) {
    const res = await fetch(`/api/workflows/${workflowId}/versions/${version}/activate`, { method: 'POST' })
    if (res.ok) { setImproveBanner(null); await loadWorkflow() }
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

  // The input this node would receive from already-run upstream nodes (no re-run).
  // Prefer this node's own captured input; else assemble from direct upstream outputs
  // (single upstream → its output; multiple → merged), mirroring the engine.
  function capturedInput(nodeId) {
    const own = wfRun?.steps?.[nodeId]?.input
    if (own) return own
    const sources = [...new Set(edges.filter(e => e.target === nodeId).map(e => e.source))]
    const outs = sources.map(s => wfRun?.steps?.[s]?.output).filter(o => o != null)
    if (outs.length === 0) return null
    if (outs.length === 1) return outs[0]
    return Object.assign({}, ...outs.filter(o => typeof o === 'object'))
  }

  // Re-run ONLY this node using the input from upstream's last run — no upstream re-run.
  async function handleStepOnly(nodeId) {
    const input = capturedInput(nodeId)
    if (!input) return
    // Seed every already-run node's output by id AND label so {{Upstream.field}} tokens resolve.
    const context = {}
    for (const [id, s] of Object.entries(wfRun?.steps || {})) {
      if (s?.output == null) continue
      context[id] = s.output
      const label = nodes.find(n => n.id === id)?.data?.label
      if (label) context[label] = s.output
    }
    setStepping(true)
    await handleSave()
    await executeStep(workflowId, nodeId, input, true, context)
    setStepping(false)
  }

  // Stop a running test/step — cancels a webhook wait AND an executing run.
  async function handleStop() {
    await stopTest(workflowId)
    setWaitingHook(false)
    setStepping(false)
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
        <div className="flex-1" />

        {/* AI / meta tools */}
        <button onClick={() => setAssistOpen(o => !o)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border rounded-lg ${assistOpen ? 'text-white bg-indigo-600 border-indigo-600 hover:bg-indigo-700' : 'text-indigo-600 border-indigo-200 hover:bg-indigo-50'}`}
          title="Build or refine this flow by chatting with AI">
          <Sparkles size={14} /> AI Assist
        </button>
        <button onClick={handleImprove} disabled={improving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-violet-600 border border-violet-200 rounded-lg hover:bg-violet-50 disabled:opacity-50"
          title="Analyse this flow against its objective and suggest improvements">
          {improving ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Improve flow
        </button>
        <button onClick={() => setShowObjective(true)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border rounded-lg ${objective ? 'text-gray-700 border-gray-200 hover:bg-gray-50' : 'text-amber-700 border-amber-200 bg-amber-50 hover:bg-amber-100'}`}
          title="Set the business objective for this workflow">
          <Target size={14} /> {objective ? 'Objective' : 'Set objective'}
        </button>
        <button onClick={() => setShowVersions(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50"
          title="Workflow versions — view, revert, and choose the active one">
          <History size={14} /> Versions
        </button>

        <div className="w-px h-6 bg-gray-200 mx-1" />

        {/* Run / save / publish */}
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

      {improveProgress && (
        <div className="px-4 py-2.5 bg-violet-50 border-b border-violet-200 text-xs text-violet-800">
          <div className="flex items-center gap-2">
            <Loader2 size={14} className="shrink-0 animate-spin" />
            <span className="flex-1 leading-relaxed truncate">
              <b>AI is improving your flow…</b> step {Math.min(improveProgress.step, improveProgress.total)} of {improveProgress.total}
              {improveProgress.label ? ` — ${improveProgress.label}` : ''}
            </span>
            <span className="shrink-0 tabular-nums font-medium">
              {Math.round((Math.min(improveProgress.step, improveProgress.total) / Math.max(improveProgress.total, 1)) * 100)}%
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full rounded-full bg-violet-200 overflow-hidden">
            <div className="h-full rounded-full bg-violet-600 transition-all duration-500 ease-out"
              style={{ width: `${Math.round((Math.min(improveProgress.step, improveProgress.total) / Math.max(improveProgress.total, 1)) * 100)}%` }} />
          </div>
        </div>
      )}

      {improveBanner && !improveProgress && (
        <div className="flex items-start gap-2 px-4 py-2.5 bg-violet-50 border-b border-violet-200 text-xs text-violet-800">
          <Sparkles size={14} className="shrink-0 mt-0.5" />
          <span className="flex-1 leading-relaxed"><b>AI draft applied:</b> {improveBanner}</span>
          <button onClick={() => saveAsNewVersion()}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-violet-600 rounded-lg hover:bg-violet-700 shrink-0 whitespace-nowrap">
            <Check size={13} /> Save as new version
          </button>
          <button onClick={() => { setImproveBanner(null); loadWorkflow() }}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-violet-800 bg-white border border-violet-300 rounded-lg hover:bg-violet-100 shrink-0 whitespace-nowrap">
            <X size={13} /> Discard
          </button>
        </div>
      )}

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
        {assistOpen && (
          <AIAssistPanel
            objective={objective}
            wfId={workflowId}
            getGraph={buildGraph}
            history={aiChat}
            onHistory={(msgs) => { setAiChat(msgs); if (workflowId) saveWorkflow(workflowId, { ai_chat: msgs }) }}
            onApply={(graph, obj) => { applyGraph(graph); if (obj) setObjective(obj); requestAnimationFrame(() => rf?.fitView?.({ padding: 0.2 })) }}
            onClose={() => setAssistOpen(false)}
          />
        )}
        {/* Canvas */}
        <div className="flex-1 relative">
          <ReactFlow nodes={liveNodes} edges={displayEdges} nodeTypes={nodeTypes}
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

          {/* Compliance review toggle — floats on the canvas, not crammed in the toolbar */}
          <button onClick={() => setRequireCompliance(v => !v)}
            title="When on, AI-agent outputs in this workflow pass a compliance review before continuing."
            className={`absolute top-3 left-3 flex items-center gap-2 pl-3 pr-2 py-2 text-sm font-medium rounded-lg shadow-sm border bg-white ${requireCompliance ? 'text-emerald-700 border-emerald-200' : 'text-gray-500 border-gray-200'}`}>
            {requireCompliance ? <ShieldCheck size={16} className="text-emerald-600" /> : <ShieldAlert size={16} className="text-gray-300" />}
            Compliance review
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${requireCompliance ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-400'}`}>
              {requireCompliance ? 'ON' : 'OFF'}
            </span>
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
              onStepOnly={() => handleStepOnly(editing.id)} hasInput={!!capturedInput(editing.id)}
              onExecuteNode={handleStep}
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
      {improveResult && <ImproveModal result={improveResult} objective={objective}
        applying={improving} onApply={handleApplyImprove} onClose={() => setImproveResult(null)} />}
      {showObjective && <ObjectiveModal value={objective}
        onSave={async (v) => { setObjective(v); setShowObjective(false); await saveWorkflow(workflowId, { objective: v }) }}
        onClose={() => setShowObjective(false)} />}
      {showVersions && <VersionsPanel workflowId={workflowId}
        onActivate={activateVersion} onSaveNew={saveAsNewVersion} onClose={() => setShowVersions(false)} />}
    </div>
  )
}

// ── Improve-flow modal ────────────────────────────────────────────────────────
const IMPACT_STYLE = {
  tokens: 'bg-amber-100 text-amber-700', reliability: 'bg-blue-100 text-blue-700',
  simplicity: 'bg-emerald-100 text-emerald-700', accuracy: 'bg-violet-100 text-violet-700',
}
const MEETS_STYLE = {
  yes: 'bg-emerald-100 text-emerald-700', partly: 'bg-amber-100 text-amber-700',
  no: 'bg-red-100 text-red-700', unknown: 'bg-gray-100 text-gray-500',
}

function ImproveModal({ result, objective, applying, onApply, onClose }) {
  const suggestions = Array.isArray(result.suggestions) ? result.suggestions : []
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-violet-600" />
            <h2 className="text-base font-semibold text-gray-800">Improve flow</h2>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {result.error ? (
            <p className="text-sm text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{result.error}</p>
          ) : <>
            {objective && <p className="text-xs text-gray-400"><span className="font-semibold text-gray-500">Objective:</span> {objective}</p>}
            <div className="flex items-center gap-2 flex-wrap">
              {result.meets_objective && (
                <span className={`text-[11px] font-semibold px-2 py-1 rounded-full ${MEETS_STYLE[result.meets_objective] || MEETS_STYLE.unknown}`}>
                  Meets objective: {result.meets_objective}
                </span>
              )}
              {result.total_tokens != null && (
                <span className="text-[11px] font-semibold px-2 py-1 rounded-full bg-gray-100 text-gray-600">
                  {result.total_tokens.toLocaleString()} AI tokens (recent runs)
                </span>
              )}
            </div>
            {result.analysis && <p className="text-sm text-gray-700 leading-relaxed">{result.analysis}</p>}
            <div className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Suggestions</h3>
              {suggestions.length === 0 && <p className="text-sm text-gray-400">No suggestions — the flow looks good.</p>}
              {suggestions.map((s, i) => (
                <div key={i} className="border border-gray-200 rounded-xl p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-800">{s.title}</span>
                    {s.impact && <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${IMPACT_STYLE[s.impact] || 'bg-gray-100 text-gray-600'}`}>{s.impact}</span>}
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed">{s.detail}</p>
                </div>
              ))}
            </div>
          </>}
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">Close</button>
          {!result.error && (
            <button onClick={onApply} disabled={applying}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-violet-600 rounded-lg hover:bg-violet-700 disabled:opacity-50">
              {applying ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Apply with AI
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// Edit the workflow's business objective.
function ObjectiveModal({ value, onSave, onClose }) {
  const [text, setText] = useState(value || '')
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2"><Target size={16} className="text-amber-600" />
            <h2 className="text-base font-semibold text-gray-800">Business objective</h2></div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <p className="text-xs text-gray-400 mb-3">What should this workflow achieve? Used to evaluate and improve the flow.</p>
        <textarea autoFocus rows={4} value={text} onChange={e => setText(e.target.value)}
          placeholder="e.g. Notify sales in Slack whenever a high-value order is placed."
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400 resize-y" />
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
          <button onClick={() => onSave(text.trim())} className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700">Save</button>
        </div>
      </div>
    </div>
  )
}

// View, revert, and choose the active workflow version.
function VersionsPanel({ workflowId, onActivate, onSaveNew, onClose }) {
  const [versions, setVersions] = useState(null)
  const [busy, setBusy] = useState(false)
  const [label, setLabel] = useState('')
  const refresh = useCallback(async () => {
    const res = await fetch(`/api/workflows/${workflowId}/versions`)
    if (res.ok) setVersions((await res.json()).versions || [])
  }, [workflowId])
  useEffect(() => { refresh() }, [refresh])

  async function saveNew() {
    setBusy(true)
    try { const ok = await onSaveNew(label.trim()); if (ok) { setLabel(''); await refresh() } }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2"><History size={16} className="text-gray-600" />
            <h2 className="text-base font-semibold text-gray-800">Versions</h2></div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="px-5 py-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <input value={label} onChange={e => setLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !busy) saveNew() }}
              placeholder="Label (optional)"
              className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-violet-400" />
            <button onClick={saveNew} disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-violet-600 rounded-lg hover:bg-violet-700 disabled:opacity-50 shrink-0">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Save as new version
            </button>
          </div>
          <p className="text-[11px] text-gray-400 mt-1.5">Only the <b>active</b> version runs when the trigger fires.</p>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {versions === null && <p className="text-sm text-gray-400 p-2">Loading…</p>}
          {versions?.map(v => (
            <div key={v.version} className={`border rounded-xl px-3 py-2.5 flex items-center gap-3 ${v.active ? 'border-green-300 bg-green-50/50' : 'border-gray-200'}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-800">v{v.version}</span>
                  <span className="text-xs text-gray-500 truncate">{v.label}</span>
                  {v.active && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">ACTIVE</span>}
                </div>
                <div className="text-[11px] text-gray-400">{(v.graph?.nodes || []).length} nodes · {fmtLocal(v.created_at)}</div>
              </div>
              {v.active ? (
                <span className="flex items-center gap-1 text-xs text-green-600 font-medium"><Check size={13} /> Running</span>
              ) : (
                <button onClick={async () => { setBusy(true); await onActivate(v.version); setBusy(false); refresh() }} disabled={busy}
                  className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                  Make active
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
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
          <Section title="Built-in variables">
            <p>These are always available in any <Code>{'{{token}}'}</Code> field — no upstream node needed (great for filenames, timestamps, etc.):</p>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
              {[
                ['{{today}}', 'Date — 2026-06-28'],
                ['{{now}}', 'Date & time (ISO)'],
                ['{{time}}', 'Time — 08:00:00'],
                ['{{timestamp}}', 'Unix seconds'],
                ['{{year}} {{month}} {{day}}', 'Date parts'],
                ['{{weekday}}', 'e.g. Monday'],
                ['{{workflow.name}}', "This workflow's name"],
                ['{{workflow.id}}', "This workflow's id"],
                ['{{run.id}}', 'Current execution id'],
                ['{{run.mode}}', 'test or live'],
              ].map(([t, d]) => (
                <div key={t} className="flex items-baseline gap-2">
                  <Code>{t}</Code><span className="text-gray-400">{d}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-gray-400">Tip: <Code>tech_news_{'{{today}}'}.txt</Code> → <Code>tech_news_2026-06-28.txt</Code>. (They're also reachable as <Code>{'{{$vars.today}}'}</Code>.)</p>
          </Section>
          <Section title="Code node">
            <p>Choose <b>Python</b> or <b>JavaScript</b>. <Code>input</Code> is the incoming data, <Code>context</Code> holds every node's output. Produce a result with <Code>return {'{...}'}</Code> (or set <Code>output</Code>). Dragged <Code>{'{{tokens}}'}</Code> are replaced with literal values before running. Use <b>Format</b> to tidy the code.</p>
          </Section>
          <Section title="AI / Agent node & compliance">
            <p>The AI node is a <b>self-contained agent</b>: give it a provider, model, system prompt and task. It has every tool (web search, browser, files, shell, MCP), loops to gather accurate data, and self-evaluates before answering. If <b>Compliance review</b> is on (the chip on the canvas), the org's Risk & Compliance agent must clear the output before it flows on — a block, <i>or having no compliance agent set up</i>, fails the step.</p>
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
  // Total AI tokens for this run (only LLM nodes contribute; 0 when none involved).
  const runTokens = ordered.reduce((t, { step }) => t + (step.input_tokens || 0) + (step.output_tokens || 0), 0)
  // Compliance review cards — LLM steps that were actually assessed (not 'off'/'skipped').
  const complianceItems = ordered
    .filter(({ step }) => step.compliance && !['skipped'].includes(step.compliance.status))
    .map(({ node, step }) => ({ node, c: step.compliance }))
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
            {runTokens > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
                <Sparkles size={13} className="text-violet-500" />
                <span className="font-medium text-gray-700">{runTokens.toLocaleString()}</span> AI tokens used this run
              </div>
            )}
            {ordered.length === 0 && <p className="text-sm text-gray-400">Loading steps…</p>}
            {ordered.map(({ node, step }) => (
              <div key={node.id} className="bg-white border border-gray-200 rounded-xl px-4 py-3">
                <div className="flex items-center gap-2">
                  <RunStatus status={step.status} small />
                  <span className="text-sm font-medium text-gray-800">{node.data.label}</span>
                  <span className="text-[10px] text-gray-400">{NODE_META[node.data.kind]?.label}</span>
                  {step.compliance && <ComplianceBadge c={step.compliance} />}
                  {(step.input_tokens || step.output_tokens) ? (
                    <span className="ml-auto text-[10px] font-medium text-violet-600 bg-violet-50 rounded-full px-1.5 py-0.5">
                      {((step.input_tokens || 0) + (step.output_tokens || 0)).toLocaleString()} tok
                    </span>
                  ) : null}
                </div>
                {step.error
                  ? <p className="text-xs text-red-500 mt-1 break-words">{step.error}</p>
                  : <pre className="text-[11px] font-mono text-gray-500 mt-1 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{JSON.stringify(step.output, null, 2)?.slice(0, 1500)}</pre>}
              </div>
            ))}
          </div>
        )}
      </main>
      {selId && complianceItems.length > 0 && <ComplianceReviewPanel items={complianceItems} />}
    </div>
  )
}

// ── Compliance review panel (Executions tab) ──────────────────────────────────
const RISK_LEVEL_STYLE = {
  low:      { dot: 'bg-green-500',  text: 'text-green-700',  bg: 'bg-green-50 border-green-200' },
  medium:   { dot: 'bg-amber-500',  text: 'text-amber-700',  bg: 'bg-amber-50 border-amber-200' },
  high:     { dot: 'bg-orange-500', text: 'text-orange-700', bg: 'bg-orange-50 border-orange-200' },
  critical: { dot: 'bg-red-500',    text: 'text-red-700',    bg: 'bg-red-50 border-red-200' },
}

function ComplianceReviewPanel({ items }) {
  return (
    <aside className="w-[380px] border-l border-gray-100 overflow-y-auto shrink-0 bg-gray-50/50">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 bg-white">
        <ShieldCheck size={15} className="text-indigo-600" />
        <div>
          <div className="text-sm font-semibold text-gray-800">Compliance review</div>
          <div className="text-[11px] text-gray-400">How Risk &amp; Compliance scored each AI output</div>
        </div>
      </div>

      <div className="p-3 space-y-3">
        {items.map(({ node, c }) => {
          const lvl = (c.level || '').toLowerCase()
          const st = RISK_LEVEL_STYLE[lvl] || RISK_LEVEL_STYLE.medium
          const blocked = c.status === 'blocked'
          const notReviewed = c.status === 'error' || c.status === 'unchecked'
          const cats = Object.entries(c.categories || {}).filter(([, v]) => v && (v.score || v.note))
          return (
            <div key={node.id} className={`rounded-xl border ${st.bg} p-3 space-y-2.5`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-gray-800 truncate">{node.data.label}</span>
                <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold ${notReviewed ? 'text-gray-500' : st.text}`}>
                  <span className={`w-2 h-2 rounded-full ${notReviewed ? 'bg-gray-400' : st.dot}`} />
                  {notReviewed ? 'NOT REVIEWED' : (c.level || 'n/a').toUpperCase()}
                </span>
              </div>

              {c.status === 'unchecked' ? (
                <p className="text-xs text-amber-700">No Risk &amp; Compliance agent is set up, so this output
                  could not be reviewed. Add one in Risk &amp; Compliance.</p>
              ) : c.status === 'error' ? (
                <p className="text-xs text-gray-600">This output could not be reviewed, so it was not allowed
                  to proceed. {c.reason}{c.reviewer && <span className="text-gray-400"> (reviewer: {c.reviewer})</span>}</p>
              ) : (
                <>
                  <div className="flex items-center gap-3 text-xs">
                    <span className={`font-semibold px-2 py-0.5 rounded-full ${blocked ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                      {blocked ? 'Blocked' : 'Cleared'}
                    </span>
                    <span className="text-gray-600">
                      Risk score <b className="text-gray-800">{c.score ?? '—'}</b>
                      {c.threshold != null && <span className="text-gray-400"> / block at {c.threshold}</span>}
                    </span>
                  </div>

                  {c.rationale && (
                    <div>
                      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Why</div>
                      <p className="text-xs text-gray-700 leading-relaxed">{c.rationale}</p>
                    </div>
                  )}

                  {cats.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Risk breakdown</div>
                      <div className="space-y-1">
                        {cats.map(([name, v]) => (
                          <div key={name} className="flex items-start gap-2 text-[11px]">
                            <span className="capitalize font-medium text-gray-700 w-20 shrink-0">{name}</span>
                            <span className="text-gray-400 shrink-0">L{v.likelihood}×C{v.consequence}={v.score}</span>
                            {v.note && <span className="text-gray-500 flex-1">{v.note}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {(c.findings || []).length > 0 && (
                    <p className="text-[11px] text-red-600">⚠ {c.findings.length} sensitive value(s) detected in output.</p>
                  )}

                  {c.reviewer && <p className="text-[10px] text-gray-400">Reviewed by {c.reviewer}</p>}
                </>
              )}
            </div>
          )
        })}

        <p className="text-[10px] text-gray-400 leading-relaxed px-1 pt-1">
          Coming soon: when an output exceeds the risk level, the compliance agent will hand it back to the
          AI agent with its findings to revise — a self-improving review loop.
        </p>
      </div>
    </aside>
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

function NodeAccordion({ node, output, onInsert, onDragStart, onDragEnd, onExecute, stepping }) {
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
            ? <div className="pl-7 pr-2 py-1 space-y-1.5">
                <p className="text-[11px] text-gray-400">No data — run to view, or drag the whole node: <button onClick={() => onInsert(`{{${ref}}}`)} className="font-mono text-indigo-500 hover:underline">{`{{${ref}}}`}</button></p>
                {onExecute && <button onClick={() => onExecute(node.id)} disabled={stepping}
                  className="flex items-center gap-1 text-[11px] text-orange-600 border border-orange-300 hover:bg-orange-50 rounded-md px-2 py-1 disabled:opacity-50">
                  <Play size={11} /> Execute step</button>}
              </div>
            : <Tree data={output} base={ref} onInsert={onInsert} onDragStart={onDragStart} onDragEnd={onDragEnd} />}
        </div>
      )}
    </div>
  )
}

function InputPanel({ ancestors, steps, step, isEntry, onInsert, onDragStart, onDragEnd, onExecute, stepping }) {
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
              onInsert={onInsert} onDragStart={onDragStart} onDragEnd={onDragEnd}
              onExecute={onExecute} stepping={stepping} />
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
  if (status === 'cancelled') return <Ban size={sz} className="text-slate-400 shrink-0" title="Cancelled" />
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
      <div>
        <label className="block text-[11px] font-medium text-gray-500 mb-1">Expression language</label>
        <select value={config.lang || 'python'} onChange={e => onChange('lang', e.target.value)} className={`${base} text-xs`}>
          <option value="python">Python</option>
          <option value="javascript">JavaScript</option>
        </select>
      </div>
      <label className="block text-[11px] font-medium text-gray-500">Rules — first match wins; otherwise the <b>default</b> output</label>
      {rules.map((r, i) => (
        <div key={i} className="border border-gray-200 rounded-lg p-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold text-orange-600">Output {i}</span>
            <button onClick={() => remove(i)} className="text-gray-300 hover:text-red-500"><Trash2 size={12} /></button>
          </div>
          <input value={r.label || ''} onChange={e => update(i, { label: e.target.value })} placeholder="Output label (optional)" className={`${base} text-xs`} />
          <input value={r.condition || ''} onFocus={() => onFocusField && onFocusField('rules')} onChange={e => update(i, { condition: e.target.value })}
            placeholder="Condition, e.g. {{Code.output}} > 1 && {{Code.output}} < 3" className={`${base} font-mono text-xs`} />
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
      <div className="flex items-start gap-2 p-2.5 rounded-lg bg-indigo-50/60 border border-indigo-100">
        <Sparkles size={14} className="text-indigo-500 shrink-0 mt-0.5" />
        <p className="text-[11px] text-indigo-700/90 leading-relaxed">
          This is a self-contained AI agent: it has <b>every tool</b> (web search, browser, files, shell, MCP) and
          loops to gather accurate data before answering. Just give it a provider, model, and the task.
        </p>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-gray-500 mb-1">Provider</label>
        <select value={config.api_provider_id || ''} onChange={e => { onChange('api_provider_id', e.target.value); onChange('model', '') }} className={base}>
          <option value="">Default provider</option>
          {(providers || []).map(p => <option key={p.id} value={p.id}>{p.name} ({p.provider})</option>)}
        </select>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-gray-500 mb-1">Model</label>
        <ModelSelect value={config.model || ''} models={models} onChange={v => onChange('model', v)}
          placeholder={config.api_provider_id ? 'Select or type a model' : 'Default model'} />
      </div>
      <Field label="System prompt (the agent's role & rules)" type="textarea" value={config.system || ''} placeholder="You are a financial news research analyst…" onChange={v => onChange('system', v)} onFocus={() => onFocusField && onFocusField('system')} dragActive={dragActive} onDropToken={dropToken && dropToken('system')} />
      <Field label="Prompt — the task (templates: {{nodeId.field}})" type="textarea" value={config.prompt || ''} onChange={v => onChange('prompt', v)} onFocus={() => onFocusField && onFocusField('prompt')} dragActive={dragActive} onDropToken={dropToken && dropToken('prompt')} />
      <Field label="Max tool-call rounds" type="number" value={config.max_iterations ?? ''} placeholder="12" onChange={v => onChange('max_iterations', v)} />
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
                      onClose, onRename, onConfig, onFocusField, onInsert, onDelete, onStep, onStepOnly, hasInput, onStop,
                      onExecuteNode, prevNodes, nextNodes, onNavigate }) {
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
          <>
            {hasInput && !isEntry && (
              <button onClick={onStepOnly} title="Re-run only this node with the input captured from the last run — no upstream re-run"
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-orange-600 border border-orange-300 hover:bg-orange-50 rounded-lg">
                <Play size={14} /> This step only
              </button>
            )}
            <button onClick={onStep}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg">
              <Play size={14} /> Execute step
            </button>
          </>
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
              onInsert={onInsert} onDragStart={() => setDragActive(true)} onDragEnd={() => setDragActive(false)}
              onExecute={onExecuteNode} stepping={stepping} />
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
            {meta.custom === 'set' && <SetConfig config={config} onChange={onConfig} onFocusField={onFocusField} />}
            {(meta.fields || []).filter(({ showIf }) => !showIf || showIf(config)).map(({ key, showIf, ...f }) => (
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

// JSON config fields → CodeMirror JSON editor (highlighting, line numbers, live
// validation, {{token}} pills, drop-at-caret). Local text state avoids reformat/
// cursor-jump while typing; parse-up stores a dict when valid (set_node needs one),
// else the raw string so the run still has something + the linter flags it.
function JsonEditorField({ value, onChange, onFocus }) {
  const [text, setText] = useState(() =>
    typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : (value ?? ''))
  const [fmtErr, setFmtErr] = useState(false)
  const push = v => { setText(v); let p = v; try { p = JSON.parse(v) } catch { /* keep raw string */ } onChange(p) }
  const format = () => {
    try { const pretty = JSON.stringify(JSON.parse(text), null, 2); setText(pretty); onChange(JSON.parse(text)); setFmtErr(false) }
    catch { setFmtErr(true) }
  }
  return (
    <div>
      <div className="flex items-center justify-end mb-1">
        {fmtErr && <span className="text-[10px] text-red-500 mr-auto">Invalid JSON — can’t format</span>}
        <button type="button" onClick={format}
          className="flex items-center gap-1 text-[11px] text-indigo-600 hover:bg-indigo-50 px-1.5 py-0.5 rounded">
          <Sparkles size={11} /> Format
        </button>
      </div>
      <CodeEditor value={text} language="json" onChange={v => { setFmtErr(false); push(v) }} onFocus={onFocus} />
    </div>
  )
}

// Path input with a "Browse" button that opens a server-side folder browser, so the
// user can pick a file/location instead of knowing the absolute path.
function FilePathField({ value, placeholder, onChange, onFocus, pick = 'read' }) {
  const [open, setOpen] = useState(false)
  const base = "flex-1 text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-400 font-mono text-xs"
  return (
    <div className="flex items-center gap-1.5">
      <input type="text" value={value || ''} placeholder={placeholder} onFocus={onFocus}
        onChange={e => onChange(e.target.value)} className={base} />
      <button type="button" onClick={() => setOpen(true)}
        className="shrink-0 flex items-center gap-1 text-xs px-2.5 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">
        <FolderOpen size={13} /> Browse
      </button>
      {open && <FileBrowser mode={pick} initial={value} onClose={() => setOpen(false)}
        onPick={p => { onChange(p); setOpen(false) }} />}
    </div>
  )
}

function FileBrowser({ mode, initial, onPick, onClose }) {
  const listDir = useOrgStore(s => s.listDir)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [fname, setFname] = useState('')
  const load = async (path) => {
    setLoading(true); setErr('')
    const d = await listDir(path || '')
    if (d) setData(d); else setErr('Cannot open this folder')
    setLoading(false)
  }
  useEffect(() => { load(initial || '') }, [])   // initial path → backend resolves to its dir
  const join = (dir, name) => `${dir.replace(/\/$/, '')}/${name}`
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-[640px] max-w-[92vw] h-[70vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
          <FolderOpen size={16} className="text-indigo-600" />
          <span className="text-sm font-semibold text-gray-800">{mode === 'write' ? 'Choose where to save' : 'Choose a file'}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700"><X size={18} /></button>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 bg-gray-50">
          <button disabled={!data?.parent} onClick={() => load(data.parent)}
            className="text-xs px-2 py-1 border border-gray-200 rounded-lg hover:bg-white disabled:opacity-40">↑ Up</button>
          <code className="flex-1 text-[11px] text-gray-600 truncate">{data?.path || '…'}</code>
          {data?.home && <button onClick={() => load(data.home)} className="text-xs px-2 py-1 border border-gray-200 rounded-lg hover:bg-white">Home</button>}
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? <div className="flex items-center justify-center h-full text-gray-400 gap-2"><Loader2 size={18} className="animate-spin" /></div>
            : err ? <p className="p-4 text-xs text-red-500">{err}</p>
            : (data?.entries || []).length === 0 ? <p className="p-4 text-xs text-gray-400">Empty folder.</p>
            : data.entries.map(en => (
              <button key={en.name} onClick={() => en.type === 'dir' ? load(join(data.path, en.name))
                : mode === 'write' ? setFname(en.name) : onPick(join(data.path, en.name))}
                className="w-full flex items-center gap-2 px-4 py-1.5 text-left text-sm hover:bg-indigo-50">
                {en.type === 'dir' ? <Folder size={14} className="text-indigo-500 shrink-0" /> : <FileText size={14} className="text-gray-400 shrink-0" />}
                <span className="flex-1 truncate text-gray-700">{en.name}</span>
                {en.type === 'file' && <span className="text-[10px] text-gray-400">{en.size} B</span>}
              </button>
            ))}
        </div>
        {mode === 'write' && (
          <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-100">
            <input value={fname} onChange={e => setFname(e.target.value)} placeholder="filename.json"
              className="flex-1 text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-400 font-mono text-xs" />
            <button disabled={!fname.trim() || !data} onClick={() => onPick(join(data.path, fname.trim()))}
              className="text-sm px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg disabled:opacity-40">Use this path</button>
          </div>
        )}
        {mode !== 'write' && <div className="px-4 py-2.5 border-t border-gray-100 text-[11px] text-gray-400">Click a file to select it, or a folder to open it.</div>}
      </div>
    </div>
  )
}

function Field({ label, type, value, onChange, options, placeholder, agents, onFocus, dragActive, onDropToken, error, pickMode }) {
  // Text/textarea fields accept dragged {{tokens}} from the INPUT pane. We DON'T
  // intercept the drop — textareas/inputs natively insert dropped text/plain at the
  // drop caret and fire onChange. Intercepting (preventDefault) would force it to
  // the start. We only add the highlight ring while a drag is active.
  const droppable = !!onDropToken && (type === 'textarea' || type === 'json' || type === undefined || type === 'text')
  const ring = dragActive && droppable ? ' ring-2 ring-indigo-300 bg-indigo-50/40' : (error ? ' border-red-400 ring-1 ring-red-300' : '')
  const dropProps = {}
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
  } else if (type === 'json') {
    input = <JsonEditorField value={value} onChange={onChange} onFocus={onFocus} />
  } else if (type === 'textarea') {
    const val = typeof value === 'object' ? JSON.stringify(value, null, 2) : (value ?? '')
    input = <textarea value={val} placeholder={placeholder} rows={5} onFocus={onFocus} {...dropProps}
      onChange={e => onChange(e.target.value)}
      className={`${base} font-mono text-xs resize-y`} />
  } else if (type === 'number') {
    input = <input type="number" value={value} placeholder={placeholder} onFocus={onFocus}
      onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} className={base} />
  } else if (type === 'filepath') {
    input = <FilePathField value={value} placeholder={placeholder} onChange={onChange}
      pick={pickMode} onFocus={onFocus} {...dropProps} />
  } else {
    input = <input type="text" value={value} placeholder={placeholder} onFocus={onFocus} {...dropProps} onChange={e => onChange(e.target.value)} className={base} />
  }
  return <div>{label && <label className="block text-[11px] font-medium text-gray-500 mb-1">{label}</label>}{input}
    {error && <p className="text-[11px] text-red-500 mt-1 break-words">{error}</p>}</div>
}

function CodeConfig({ config, onChange, onFocusField, dragActive, dropToken }) {
  const formatCode = useOrgStore(s => s.formatCode)
  const [busy, setBusy] = useState(false)
  const lang = config.language || 'python'
  // Flag JS syntax errors as you type. Tokens resolve to literals at runtime,
  // so replace {{...}} with `null` before parsing. Python has no browser parser —
  // it stays flagged on actual run (shown in OUTPUT).
  const codeErr = useMemo(() => {
    if (lang !== 'javascript' || !config.code) return null
    try { new Function(config.code.replace(/\{\{[^}]+\}\}/g, 'null')); return null }
    catch (e) { return e.message }
  }, [config.code, lang])
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
        <CodeEditor value={config.code ?? ''} language={lang} error={codeErr}
          onChange={v => onChange('code', v)} onFocus={() => onFocusField && onFocusField('code')} />
        {codeErr && <p className="text-[11px] text-red-500 mt-1 break-words">{codeErr}</p>}
      </div>
    </>
  )
}

// Language config for the editor: the CodeMirror extension + the Lezer parser
// used for linting. JSON, JS and Python all supported.
function langExt(language) {
  if (language === 'json') return json()
  if (language === 'javascript') return javascript()
  return python()
}
function langParser(language) {
  if (language === 'json') return jsonLanguage.parser
  if (language === 'javascript') return javascriptLanguage.parser
  return pythonLanguage.parser
}

// Live syntax linter. We parse a TOKEN-MASKED copy so runtime {{tokens}} aren't
// flagged: in JSON a token becomes a same-length string literal ("___"), elsewhere
// a same-length `_` identifier — positions stay aligned. Lezer error nodes → red.
function maskTokens(s, language) {
  return s.replace(/\{\{[^}]*\}\}/g, m =>
    language === 'json' ? '"' + '_'.repeat(Math.max(0, m.length - 2)) + '"' : '_'.repeat(m.length))
}
function syntaxLinter(language) {
  const parser = langParser(language)
  return linter(view => {
    const doc = view.state.doc
    const text = maskTokens(doc.toString(), language)
    if (!text.trim()) return []
    const diags = []
    parser.parse(text).iterate({
      enter: node => {
        if (node.type.isError) {
          const from = Math.min(node.from, doc.length)
          const to = Math.min(Math.max(node.to, from + 1), doc.length)
          diags.push({ from, to, severity: 'error', message: 'Syntax error' })
        }
      },
    })
    return diags
  }, { delay: 400 })
}

// Render each {{token}} as a single highlighted pill so the code highlighter
// doesn't colour its insides like real code (which looked "broken"). Purely visual.
const WF_TOKEN_RE = /\{\{[^}]*\}\}/g
const tokenMark = Decoration.mark({ class: 'cm-wf-token' })
const tokenHighlighter = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view) }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view) }
  build(view) {
    const b = new RangeSetBuilder()
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to)
      let m
      WF_TOKEN_RE.lastIndex = 0
      while ((m = WF_TOKEN_RE.exec(text))) b.add(from + m.index, from + m.index + m[0].length, tokenMark)
    }
    return b.finish()
  }
}, { decorations: v => v.decorations })
const tokenTheme = EditorView.theme({
  '.cm-wf-token': { backgroundColor: 'rgba(99,102,241,0.12)', borderRadius: '3px' },
  '.cm-wf-token, .cm-wf-token span': { color: '#4f46e5' },
})

// CodeMirror editor — syntax highlighting, line numbers, live error linting, {{token}}
// pills, and native drag-drop that inserts the dragged token at the drop caret.
function CodeEditor({ value, language, error, onChange, onFocus }) {
  const ext = useMemo(() => [
    langExt(language), syntaxLinter(language), lintGutter(), tokenHighlighter, tokenTheme,
  ], [language])
  return (
    <div className={`rounded-lg overflow-hidden border ${error ? 'border-red-400' : 'border-gray-200'}`}>
      <CodeMirror
        value={value || ''} extensions={ext} onChange={onChange} onFocus={onFocus}
        minHeight="120px" maxHeight="340px"
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false, autocompletion: false }}
        className="text-xs" />
    </div>
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
          <div className="pt-1">
            <label className="block text-[11px] font-medium text-gray-500 mb-1">Respond</label>
            <select value={config.responseMode || 'auto'} onChange={e => onChange('responseMode', e.target.value)} className={base}>
              <option value="auto">Automatically (final node output)</option>
              <option value="respond">Using "Respond to Webhook" node</option>
            </select>
            <p className="text-[10px] text-gray-400 mt-1">
              {(config.responseMode || 'auto') === 'respond'
                ? 'The caller receives the payload from your Respond to Webhook node (only on live calls — a Test returns an ack).'
                : 'The caller receives the last node’s output. Add a Respond to Webhook node + pick the option above to control the response.'}
            </p>
          </div>
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
        <JsonEditorField value={config.sample} onChange={v => onChange('sample', v)} />
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
  // Native drop inserts at the caret (see Field) — don't intercept.
  const dropProps = () => ({})
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
          {config.bodyType === 'raw'
            ? <textarea value={config.body ?? ''} onFocus={() => onFocusField && onFocusField('body')}
                onChange={e => onChange('body', e.target.value)} {...dropProps('body')} rows={4}
                placeholder="raw body…" className={`${base} font-mono text-xs${ring}`} />
            : <CodeEditor value={config.body ?? ''} language="json"
                onChange={v => onChange('body', v)} onFocus={() => onFocusField && onFocusField('body')} />}
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

// Edit Fields (Set) — n8n-style: Manual Mapping (typed Name/Type/Value rows, drag
// input fields in or Add Field) or JSON (one object). Manual rows → `fields`, JSON → `assignments`.
const SET_TYPES = ['String', 'Number', 'Boolean', 'Array', 'Object']
function tokenToName(t) {
  const m = t.match(/\{\{\s*([^}]+?)\s*\}\}/)
  return ((m ? m[1] : t).split('.').pop() || '').trim()
}
function SetConfig({ config, onChange }) {
  const base = "w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-400"
  const mode = config.mode || (config.assignments ? 'json' : 'manual')
  const fields = config.fields || []
  const setFields = f => onChange('fields', f)
  const updateField = (i, patch) => setFields(fields.map((r, j) => j === i ? { ...r, ...patch } : r))
  const addField = (preset = {}) => setFields([...fields, { name: '', type: 'string', value: '', ...preset }])
  const onDropZone = e => { e.preventDefault(); const t = e.dataTransfer.getData('text/plain'); if (t) addField({ name: tokenToName(t), value: t }) }
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[11px] font-medium text-gray-500 mb-1">Mode</label>
        <select value={mode} onChange={e => onChange('mode', e.target.value)} className={base}>
          <option value="manual">Manual Mapping</option>
          <option value="json">JSON</option>
        </select>
      </div>

      {mode === 'json' ? (
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1">Fields to set (JSON: name → value/template)</label>
          <JsonEditorField value={config.assignments} onChange={v => onChange('assignments', v)} />
        </div>
      ) : (
        <div className="space-y-2">
          <label className="block text-[11px] font-medium text-gray-500">Fields to Set</label>
          {fields.map((f, i) => (
            <div key={i} className="border border-gray-200 rounded-lg p-2 space-y-1.5 bg-gray-50/50">
              <div className="flex items-center gap-1.5">
                <input value={f.name || ''} onChange={e => updateField(i, { name: e.target.value })} placeholder="Field name" className={base} />
                <button onClick={() => setFields(fields.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500 shrink-0" title="Remove"><Trash2 size={13} /></button>
              </div>
              <select value={f.type || 'string'} onChange={e => updateField(i, { type: e.target.value })} className={`${base} text-xs`}>
                {SET_TYPES.map(t => <option key={t} value={t.toLowerCase()}>{t}</option>)}
              </select>
              <input value={f.value || ''} onChange={e => updateField(i, { value: e.target.value })}
                placeholder="Value (drag a field or type; supports {{tokens}})" className={`${base} font-mono text-xs`} />
            </div>
          ))}
          <div onDragOver={e => e.preventDefault()} onDrop={onDropZone}
            className="border border-dashed border-gray-300 rounded-lg px-3 py-3 text-center text-[11px] text-gray-400">
            Drag input fields here&nbsp;·&nbsp;
            <button onClick={() => addField()} className="text-indigo-600 hover:underline font-medium">Add Field</button>
          </div>
        </div>
      )}

      <div className="border-t border-gray-100 pt-3 flex items-center justify-between">
        <label className="text-xs text-gray-600">Include other input fields</label>
        <Toggle on={!config.keep_only} onClick={() => onChange('keep_only', !config.keep_only)} />
      </div>
    </div>
  )
}

export default function WorkflowEditor(props) {
  return <ReactFlowProvider><EditorInner {...props} /></ReactFlowProvider>
}
