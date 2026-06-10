/**
 * InterviewWizard — "Not sure which agent? Interview them."
 * The Manager writes role-specific questions, candidate OpenRouter models answer
 * them in-character, and the Manager ranks which model best fits the role.
 *
 * Steps: 1) OpenRouter provider · 2) Questions + constraints ·
 *        3) Pick models to compare · 4) Run interviews + recommendation.
 */
import React, { useState, useEffect, useRef } from 'react'
import { X, Loader2, Plus, Trash2, Search, Trophy, Check, KeyRound, Sparkles } from 'lucide-react'

const CONSTRAINTS = [
  { key: 'max_cost', label: 'Cost-efficient' },
  { key: 'needs_tools', label: 'Tool calling' },
  { key: 'needs_browser', label: 'Web browsing' },
  { key: 'needs_vision', label: 'Vision (sees images)' },
  { key: 'needs_image', label: 'Image generation' },
]

const perM = (p) => p ? `$${(p * 1e6).toFixed(2)}/M` : 'free'

export default function InterviewWizard({ agentForm, onPick, onClose }) {
  const [step, setStep] = useState(1)
  const [shared, setShared] = useState({ constraints: {}, questions: [], selected: [] })
  const patch = (p) => setShared(s => ({ ...s, ...p }))
  const downOnBackdrop = useRef(false)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={e => { downOnBackdrop.current = e.target === e.currentTarget }}
      onClick={e => { if (e.target === e.currentTarget && downOnBackdrop.current) onClose() }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col" onMouseDown={() => { downOnBackdrop.current = false }}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Trophy size={18} className="text-amber-500" /> Interview the agents
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">Step {step} of 4 — the Manager interviews models for the <b>{agentForm.role || 'agent'}</b> role</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <Stepper step={step} />
          {step === 1 && <StepProvider onNext={() => setStep(2)} />}
          {step === 2 && <StepQuestions agentForm={agentForm} onState={patch} shared={shared} onNext={() => setStep(3)} onBack={() => setStep(1)} />}
          {step === 3 && <StepModels shared={shared} onState={patch} onNext={() => setStep(4)} onBack={() => setStep(2)} />}
          {step === 4 && <StepRun agentForm={agentForm} shared={shared} onPick={onPick} onBack={() => setStep(3)} />}
        </div>
      </div>
    </div>
  )
}

function Stepper({ step }) {
  const labels = ['Provider', 'Questions', 'Models', 'Results']
  return (
    <div className="flex items-center gap-1.5 mb-5">
      {labels.map((l, i) => (
        <React.Fragment key={l}>
          <div className={`flex items-center gap-1.5 text-xs font-medium ${i + 1 <= step ? 'text-indigo-600' : 'text-gray-300'}`}>
            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${i + 1 < step ? 'bg-indigo-600 text-white' : i + 1 === step ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-400'}`}>
              {i + 1 < step ? <Check size={11} /> : i + 1}
            </span>
            {l}
          </div>
          {i < labels.length - 1 && <div className={`flex-1 h-px ${i + 1 < step ? 'bg-indigo-300' : 'bg-gray-200'}`} />}
        </React.Fragment>
      ))}
    </div>
  )
}

// ── Step 1: OpenRouter provider ───────────────────────────────────────────────
function StepProvider({ onNext }) {
  const [providers, setProviders] = useState(null)
  const [name, setName] = useState('OpenRouter')
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const load = () => fetch('/api/providers').then(r => r.json()).then(setProviders).catch(() => setProviders([]))
  useEffect(() => { load() }, [])

  const openrouter = (providers || []).find(p => (p.provider || '').toLowerCase() === 'openrouter' && p.type === 'llm')

  async function save() {
    if (!key.trim()) { setErr('Enter your OpenRouter API key'); return }
    setSaving(true); setErr('')
    try {
      const r = await fetch('/api/providers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type: 'llm', provider: 'openrouter', api_key: key, base_url: 'https://openrouter.ai/api/v1' }),
      })
      if (!r.ok) throw new Error(await r.text())
      await load()
    } catch (e) { setErr(e.message) } finally { setSaving(false) }
  }

  if (providers === null) return <Loading />
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Interviews run candidate models through <b>OpenRouter</b>, which gives access to all the frontier
        and popular open-weight models behind one key.
      </p>
      {openrouter ? (
        <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700">
          <Check size={16} /> OpenRouter is configured ({openrouter.name}).
        </div>
      ) : (
        <div className="space-y-3 border border-gray-200 rounded-xl p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-700"><KeyRound size={15} /> Add your OpenRouter API key</div>
          <input className="input" placeholder="Provider name" value={name} onChange={e => setName(e.target.value)} />
          <input className="input font-mono" type="password" placeholder="sk-or-..." value={key} onChange={e => setKey(e.target.value)} />
          <p className="text-[11px] text-gray-400">Get a key at openrouter.ai/keys</p>
          {err && <p className="text-xs text-red-600">{err}</p>}
          <button onClick={save} disabled={saving} className="btn-primary text-sm">
            {saving ? <Loader2 size={14} className="animate-spin" /> : 'Save key'}
          </button>
        </div>
      )}
      <div className="flex justify-end">
        <button onClick={onNext} disabled={!openrouter} className="btn-primary disabled:opacity-40">Next</button>
      </div>
    </div>
  )
}

// ── Step 2: Questions + constraints ───────────────────────────────────────────
function StepQuestions({ agentForm, shared, onState, onNext, onBack }) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const constraints = shared.constraints || {}
  const questions = shared.questions || []

  function toggle(k) { onState({ constraints: { ...constraints, [k]: !constraints[k] } }) }

  async function generate() {
    setLoading(true); setErr('')
    try {
      const r = await fetch('/api/interview/questions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: agentForm.role, description: agentForm.description, system_prompt: agentForm.system_prompt, constraints }),
      })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      onState({ questions: d.questions })
    } catch (e) { setErr(e.message) } finally { setLoading(false) }
  }

  const setQ = (i, v) => onState({ questions: questions.map((q, j) => j === i ? v : q) })
  const delQ = (i) => onState({ questions: questions.filter((_, j) => j !== i) })
  const addQ = () => onState({ questions: [...questions, ''] })

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">What matters for this role?</p>
        <div className="flex flex-wrap gap-2">
          {CONSTRAINTS.map(c => (
            <button key={c.key} onClick={() => toggle(c.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${constraints[c.key] ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Interview questions</p>
          <button onClick={generate} disabled={loading} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {questions.length ? 'Regenerate' : 'Let the Manager write them'}
          </button>
        </div>
        {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
        {questions.length === 0 && !loading && (
          <p className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-200 rounded-xl">
            Pick your priorities above, then let the Manager draft the questions. You can edit them.
          </p>
        )}
        <div className="space-y-2">
          {questions.map((q, i) => (
            <div key={i} className="flex gap-2 items-start">
              <span className="text-xs text-gray-400 mt-2 w-4 text-right">{i + 1}</span>
              <textarea className="input flex-1 text-sm leading-relaxed resize-y min-h-[72px]" rows={3} value={q} onChange={e => setQ(i, e.target.value)} />
              <button onClick={() => delQ(i)} className="p-1.5 text-gray-300 hover:text-red-500 mt-1"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        {questions.length > 0 && (
          <button onClick={addQ} className="mt-2 flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700"><Plus size={12} /> Add question</button>
        )}
      </div>

      <div className="flex justify-between">
        <button onClick={onBack} className="btn-ghost">Back</button>
        <button onClick={onNext} disabled={questions.filter(q => q.trim()).length < 1} className="btn-primary disabled:opacity-40">Next</button>
      </div>
    </div>
  )
}

// ── Step 3: Pick models ───────────────────────────────────────────────────────
function StepModels({ shared, onState, onNext, onBack }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [search, setSearch] = useState('')
  const selected = shared.selected || []

  useEffect(() => {
    fetch('/api/openrouter/models').then(async r => {
      if (!r.ok) throw new Error(await r.text())
      return r.json()
    }).then(setData).catch(e => setErr(e.message))
  }, [])

  if (err) return <div className="text-sm text-red-600 py-6">{err}</div>
  if (!data) return <Loading label="Fetching models from OpenRouter…" />

  const byId = Object.fromEntries(data.models.map(m => [m.id, m]))
  const curated = data.curated.map(id => byId[id]).filter(Boolean)
  const q = search.trim().toLowerCase()
  // Top section: search results when searching, else the curated top list. Always
  // hide ones already selected (they live in the bottom "Selected" section).
  const pool = q
    ? data.models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    : curated
  const available = pool.filter(m => !selected.includes(m.id)).slice(0, 30)
  const selectedModels = selected.map(id => byId[id]).filter(Boolean)

  const add = (id) => onState({ selected: [...selected, id] })
  const remove = (id) => onState({ selected: selected.filter(x => x !== id) })

  const Badges = ({ m }) => (
    <div className="flex items-center gap-1.5 shrink-0">
      {m.vision && <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-600">vision</span>}
      {m.tools && <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600">tools</span>}
      <span className="text-[10px] text-gray-400 tabular-nums w-14 text-right">{perM(m.prompt_price)}</span>
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Search at the top */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input autoFocus className="input pl-9" placeholder="Search all OpenRouter models…"
          value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {/* Available pool */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
          {q ? `Results (${available.length})` : 'Top models'}
        </p>
        <div className="space-y-1.5 max-h-[34vh] overflow-y-auto pr-1">
          {available.length === 0 && <p className="text-sm text-gray-400 py-3 text-center">No matches.</p>}
          {available.map(m => (
            <button key={m.id} type="button" onClick={() => add(m.id)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-xl border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50/50 transition-colors text-left">
              <Plus size={15} className="text-indigo-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{m.name}</p>
                <p className="text-[11px] text-gray-400 truncate">{m.id}</p>
              </div>
              <Badges m={m} />
            </button>
          ))}
        </div>
      </div>

      {/* Selected basket */}
      <div className="border-t border-gray-100 pt-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
          Selected to interview ({selectedModels.length})
        </p>
        {selectedModels.length === 0 ? (
          <p className="text-sm text-gray-400 py-3 text-center border border-dashed border-gray-200 rounded-xl">
            Search and click models above to add them here.
          </p>
        ) : (
          <div className="space-y-1.5">
            {selectedModels.map(m => (
              <div key={m.id} className="flex items-center gap-3 px-3 py-2 rounded-xl border border-indigo-300 bg-indigo-50">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{m.name}</p>
                  <p className="text-[11px] text-gray-400 truncate">{m.id}</p>
                </div>
                <Badges m={m} />
                <button onClick={() => remove(m.id)} className="p-1 text-gray-400 hover:text-red-500 shrink-0"><X size={15} /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-between items-center">
        <button onClick={onBack} className="btn-ghost">Back</button>
        <button onClick={onNext} disabled={selected.length < 1} className="btn-primary disabled:opacity-40">
          Run interviews ({selected.length})
        </button>
      </div>
    </div>
  )
}

// ── Step 4: Run + results ─────────────────────────────────────────────────────
function StepRun({ agentForm, shared, onPick, onBack }) {
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    fetch('/api/interview/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: agentForm.role, description: agentForm.description, system_prompt: agentForm.system_prompt,
        questions: (shared.questions || []).filter(q => q.trim()),
        model_ids: shared.selected, constraints: shared.constraints, max_cost_per_model: 1.0,
      }),
    }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json() })
      .then(setResult).catch(e => setErr(e.message))
  }, [])

  if (err) return <div className="space-y-4"><p className="text-sm text-red-600">{err}</p><button onClick={onBack} className="btn-ghost">Back</button></div>
  if (!result) return <Loading label={`Interviewing ${shared.selected.length} models — the Manager is asking and scoring…`} />

  const rec = result.recommendation || {}
  const ranking = (rec.ranking || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0))
  const costFor = (id) => result.transcripts.find(t => t.model_id === id)?.cost ?? 0
  const rows = ranking.length ? ranking : result.transcripts.map(t => ({ model_id: t.model_id, score: 0, verdict: t.error || '' }))

  return (
    <div className="space-y-4">
      {rec.summary && <p className="text-sm text-gray-600 bg-amber-50 border border-amber-200 rounded-xl p-3">{rec.summary}</p>}
      <div className="space-y-2">
        {rows.map(row => {
          const best = row.model_id === rec.recommended
          return (
            <div key={row.model_id} className={`flex items-center gap-3 p-3 rounded-xl border ${best ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
              {best && <Trophy size={16} className="text-amber-500 shrink-0" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{row.model_id} {best && <span className="text-[10px] text-amber-600 font-semibold">· recommended</span>}</p>
                {row.verdict && <p className="text-xs text-gray-500 truncate">{row.verdict}</p>}
                <p className="text-[10px] text-gray-400">interview cost ${costFor(row.model_id)}</p>
              </div>
              {typeof row.score === 'number' && row.score > 0 && (
                <span className="text-sm font-bold text-gray-700 tabular-nums shrink-0">{row.score}</span>
              )}
              <button onClick={() => onPick(row.model_id)} className="btn-primary text-xs shrink-0">Use this</button>
            </div>
          )
        })}
      </div>
      <p className="text-[11px] text-gray-400 text-right">Total interview cost: ${result.total_cost}</p>
      <div className="flex justify-between">
        <button onClick={onBack} className="btn-ghost">Back</button>
      </div>
    </div>
  )
}

function Loading({ label }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-gray-400">
      <Loader2 size={26} className="animate-spin text-indigo-500" />
      {label && <p className="text-sm text-center max-w-sm">{label}</p>}
    </div>
  )
}
