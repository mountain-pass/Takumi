/**
 * RiskView — Risk & Compliance home. Two tabs:
 *  - Policy: the company risk appetite, threshold, ISO 31000 scoring scales,
 *    categories, and a visual 5×5 risk matrix. Consumed by every assessment.
 *  - Register: the log of every risk assessment (score, level, verdict, decision).
 */
import React, { useState, useEffect } from 'react'
import { ShieldCheck, Loader2, Save, ScrollText, SlidersHorizontal, FileText, Plus, Trash2, X } from 'lucide-react'

const MODES = [
  { id: 'all', label: 'All tasks', hint: 'Every task is reviewed against the org policy.' },
  { id: 'match', label: 'Only matched', hint: 'Only tasks the Manager matches to a policy are reviewed.' },
  { id: 'off', label: 'Off', hint: 'No compliance review.' },
]

const LEVELS = [
  { key: 'low', label: 'Low', cls: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'medium', label: 'Medium', cls: 'bg-yellow-100 text-yellow-700 border-yellow-200' },
  { key: 'high', label: 'High', cls: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'critical', label: 'Critical', cls: 'bg-red-100 text-red-700 border-red-200' },
]
const levelOf = (s) => s >= 16 ? 'critical' : s >= 10 ? 'high' : s >= 5 ? 'medium' : 'low'
const cellTone = (s) => s >= 16 ? 'bg-red-400/80' : s >= 10 ? 'bg-orange-400/80' : s >= 5 ? 'bg-yellow-300/80' : 'bg-green-300/70'

export default function RiskView() {
  const [tab, setTab] = useState('policy')
  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-gray-100 shrink-0">
        <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
          <ShieldCheck size={20} /> Risk &amp; Compliance
        </h1>
        <p className="text-xs text-gray-400 mt-0.5">ISO 31000 risk policy and the assessment register.</p>
        <div className="flex gap-1 mt-3">
          <TabBtn active={tab === 'policy'} onClick={() => setTab('policy')} icon={SlidersHorizontal}>Global Policy</TabBtn>
          <TabBtn active={tab === 'policies'} onClick={() => setTab('policies')} icon={FileText}>Policies</TabBtn>
          <TabBtn active={tab === 'register'} onClick={() => setTab('register')} icon={ScrollText}>Risk Register</TabBtn>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === 'policy' && <PolicyTab />}
        {tab === 'policies' && <PoliciesTab />}
        {tab === 'register' && <RegisterTab />}
      </div>
    </div>
  )
}

function TabBtn({ active, onClick, icon: Icon, children }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
        active ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'}`}>
      <Icon size={13} /> {children}
    </button>
  )
}

// ── Policy tab ────────────────────────────────────────────────────────────────
function PolicyTab() {
  const [policy, setPolicy] = useState(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/risk/policy').then(r => r.json()).then(setPolicy).catch(() => setPolicy({}))
  }, [])
  if (!policy) return <Loading />

  const set = (k, v) => { setPolicy(p => ({ ...p, [k]: v })); setSaved(false) }
  const toggleCat = (c) => {
    const cats = policy.categories || []
    set('categories', cats.includes(c) ? cats.filter(x => x !== c) : [...cats, c])
  }
  async function save() {
    setSaving(true); setSaved(false)
    await fetch('/api/risk/policy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threshold: policy.threshold, appetite: policy.appetite, categories: policy.categories,
        likelihood_scale: policy.likelihood_scale, consequence_scale: policy.consequence_scale,
        mode: policy.mode,
      }),
    })
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2500)
  }

  const threshold = policy.threshold || 10
  return (
    <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
      {/* Compliance mode */}
      <Section title="Compliance review mode"
        hint="Decide how much work the Risk & Compliance agent gates (requires a Risk & Compliance agent).">
        <div className="grid grid-cols-3 gap-2">
          {MODES.map(m => (
            <button key={m.id} onClick={() => set('mode', m.id)}
              className={`text-left px-3 py-2 rounded-xl border text-xs ${
                (policy.mode || 'all') === m.id ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:bg-gray-50'}`}>
              <div className="font-semibold text-gray-800">{m.label}</div>
              <div className="text-[10px] text-gray-400 mt-0.5">{m.hint}</div>
            </button>
          ))}
        </div>
      </Section>

      {/* Appetite */}
      <Section title="Company risk appetite / policy"
        hint="Free-text policy injected into every assessment so the agent scores against your specification.">
        <textarea rows={4} className="input resize-y" value={policy.appetite || ''}
          onChange={e => set('appetite', e.target.value)} />
      </Section>

      {/* Threshold + matrix */}
      <Section title="Risk threshold & matrix"
        hint="Scores at or above the threshold are sent back for one self-remediation attempt, then held for approval.">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-sm text-gray-700">Block at score</span>
          <input type="number" min={1} max={25} value={threshold}
            onChange={e => set('threshold', Math.max(1, Math.min(25, parseInt(e.target.value || '1', 10) || 1)))}
            className="w-20 input text-right" />
          <span className={`text-[11px] px-2 py-0.5 rounded border ${LEVELS.find(l => l.key === levelOf(threshold)).cls}`}>
            {LEVELS.find(l => l.key === levelOf(threshold)).label}+ blocked
          </span>
        </div>
        <RiskMatrix threshold={threshold} like={policy.likelihood_scale} cons={policy.consequence_scale} />
        <div className="flex flex-wrap gap-2 mt-3">
          {LEVELS.map(l => <span key={l.key} className={`text-[10px] px-2 py-0.5 rounded border ${l.cls}`}>{l.label}</span>)}
        </div>
      </Section>

      {/* Scales with definitions */}
      <Section title="Likelihood scale (1–5)" hint="Define what each level means so scoring is consistent and auditable.">
        <ScaleEditor scale={policy.likelihood_scale} onChange={s => set('likelihood_scale', s)} />
      </Section>
      <Section title="Consequence / impact scale (1–5)" hint="Define the impact at each level (financial, data, legal, reputational…).">
        <ScaleEditor scale={policy.consequence_scale} onChange={s => set('consequence_scale', s)} />
      </Section>

      {/* Categories */}
      <Section title="Risk categories" hint="Which categories the agent scores against.">
        <div className="flex flex-wrap gap-2">
          {(policy.all_categories || policy.categories || []).map(c => {
            const on = (policy.categories || []).includes(c)
            return (
              <button key={c} onClick={() => toggleCat(c)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border capitalize ${
                  on ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                {c.replace('_', ' ')}
              </button>
            )
          })}
        </div>
      </Section>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium disabled:opacity-50">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save policy
        </button>
        {saved && <span className="text-xs text-green-600">Saved ✓</span>}
      </div>
    </div>
  )
}

function ScaleEditor({ scale = [], onChange }) {
  const setField = (i, field, v) => onChange(scale.map((x, j) => (j === i ? { ...x, [field]: v } : x)))
  return (
    <div className="space-y-2">
      {scale.map((lvl, i) => (
        <div key={i} className="flex gap-2 items-start">
          <span className="w-4 text-xs text-gray-400 mt-2 text-right shrink-0">{i + 1}</span>
          <input className="input w-32 shrink-0" placeholder="Label" value={lvl.label || ''}
            onChange={e => setField(i, 'label', e.target.value)} />
          <textarea className="input flex-1 text-xs leading-relaxed resize-y" rows={2}
            placeholder="Definition / criteria for this level" value={lvl.definition || ''}
            onChange={e => setField(i, 'definition', e.target.value)} />
        </div>
      ))}
    </div>
  )
}

function RiskMatrix({ threshold, like = [], cons = [] }) {
  const rows = [5, 4, 3, 2, 1] // consequence high → low
  return (
    <div className="inline-block text-[10px]">
      <div className="flex">
        <div className="w-24" />
        {[1, 2, 3, 4, 5].map(l => (
          <div key={l} className="w-12 text-center text-gray-400 truncate" title={like[l - 1]?.definition || like[l - 1]?.label}>{l}</div>
        ))}
      </div>
      {rows.map(c => (
        <div key={c} className="flex items-center">
          <div className="w-24 text-right pr-2 text-gray-400 truncate" title={cons[c - 1]?.definition || ''}>{c} {cons[c - 1]?.label || ''}</div>
          {[1, 2, 3, 4, 5].map(l => {
            const s = l * c
            const blocked = s >= threshold
            return (
              <div key={l} className={`w-12 h-9 m-px rounded flex items-center justify-center font-semibold text-gray-800 ${cellTone(s)} ${blocked ? 'ring-2 ring-gray-800/40' : ''}`}>
                {s}
              </div>
            )
          })}
        </div>
      ))}
      <div className="flex mt-1"><div className="w-24" /><div className="text-gray-400">Likelihood → · ⬛ ring = at/above threshold</div></div>
    </div>
  )
}

// ── Register tab ──────────────────────────────────────────────────────────────
function RegisterTab() {
  const [rows, setRows] = useState(null)
  useEffect(() => {
    fetch('/api/risk/register?limit=100').then(r => r.json()).then(setRows).catch(() => setRows([]))
  }, [])
  if (!rows) return <Loading />
  if (rows.length === 0) return (
    <div className="text-center py-16 text-gray-400">
      <ScrollText size={28} className="mx-auto mb-2 opacity-40" />
      <p className="text-sm">No risk assessments yet.</p>
    </div>
  )
  const decisionTone = { proceed: 'text-green-600', remediated: 'text-blue-600', held: 'text-amber-600', approved: 'text-green-600', rejected: 'text-red-600', review: 'text-amber-600' }
  return (
    <div className="max-w-4xl mx-auto px-6 py-5 space-y-2">
      {rows.map(r => {
        const lv = LEVELS.find(l => l.key === r.level) || LEVELS[0]
        return (
          <div key={r.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-200">
            <span className={`text-[10px] px-2 py-0.5 rounded border shrink-0 ${lv.cls}`}>{lv.label} {r.score}/25</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800 truncate">{r.subject || 'Assessment'}</p>
              {r.rationale && <p className="text-[11px] text-gray-500 truncate">{r.rationale}</p>}
              {r.findings?.length > 0 && (
                <p className="text-[11px] text-red-600 truncate">⚠️ {r.findings.map(f => f.type || f).join(', ')}</p>
              )}
            </div>
            <span className={`text-[11px] font-medium shrink-0 ${decisionTone[r.decision] || 'text-gray-500'}`}>{r.decision}</span>
            <span className="text-[10px] text-gray-400 shrink-0 w-24 text-right">{(r.created_at || '').slice(0, 16).replace('T', ' ')}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Policies tab (named, matchable) ───────────────────────────────────────────
function PoliciesTab() {
  const [policies, setPolicies] = useState(null)
  const [editing, setEditing] = useState(null) // policy object or {} for new

  const load = () => fetch('/api/risk/policies').then(r => r.json()).then(setPolicies).catch(() => setPolicies([]))
  useEffect(() => { load() }, [])

  async function save(p) {
    await fetch('/api/risk/policies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, name: p.name, body: p.body, threshold: p.threshold ?? 10, enabled: p.enabled ?? true }),
    })
    setEditing(null); load()
  }
  async function remove(id) {
    if (!confirm('Delete this policy?')) return
    await fetch(`/api/risk/policies/${id}`, { method: 'DELETE' }); load()
  }

  if (!policies) return <Loading />
  return (
    <div className="max-w-3xl mx-auto px-6 py-6 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500 max-w-md">
          Named policies the Manager matches tasks against (in "Only matched" mode). Each is summarised by an agent so tasks can be linked to it.
        </p>
        <button onClick={() => setEditing({ name: '', body: '', threshold: 10, enabled: true })}
          className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium shrink-0">
          <Plus size={14} /> New policy
        </button>
      </div>
      {policies.length === 0 && <p className="text-sm text-gray-400 py-8 text-center border border-dashed border-gray-200 rounded-xl">No policies yet.</p>}
      {policies.map(p => (
        <div key={p.id} className="border border-gray-200 rounded-xl p-3">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-800">{p.name || 'Untitled'}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">block ≥ {p.threshold}</span>
                {!p.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-400">disabled</span>}
              </div>
              {p.summary && <p className="text-[11px] text-gray-500 mt-0.5">{p.summary}</p>}
            </div>
            <button onClick={() => setEditing(p)} className="text-[11px] text-indigo-600 hover:underline shrink-0">Edit</button>
            <button onClick={() => remove(p.id)} className="p-1 text-gray-300 hover:text-red-500 shrink-0"><Trash2 size={14} /></button>
          </div>
        </div>
      ))}
      {editing && <PolicyEditor policy={editing} onSave={save} onClose={() => setEditing(null)} />}
    </div>
  )
}

function PolicyEditor({ policy, onSave, onClose }) {
  const [p, setP] = useState(policy)
  const set = (k, v) => setP(x => ({ ...x, [k]: v }))
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h3 className="text-sm font-bold text-gray-900">{p.id ? 'Edit policy' : 'New policy'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3">
          <input className="input" placeholder="Policy name (e.g. Customer Data Handling)" value={p.name} onChange={e => set('name', e.target.value)} />
          <textarea className="input resize-y" rows={6} placeholder="Describe what this policy governs — the kinds of work, data, or actions it covers and the rules…" value={p.body} onChange={e => set('body', e.target.value)} />
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">Block at score</span>
            <input type="number" min={1} max={25} className="input w-20 text-right" value={p.threshold} onChange={e => set('threshold', Math.max(1, Math.min(25, parseInt(e.target.value || '1', 10) || 1)))} />
            <label className="flex items-center gap-1.5 text-sm text-gray-600 ml-2">
              <input type="checkbox" checked={p.enabled} onChange={e => set('enabled', e.target.checked)} /> Enabled
            </label>
          </div>
          <p className="text-[11px] text-gray-400">On save, an agent generates a one-line summary used to match tasks to this policy.</p>
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-xl">Cancel</button>
          <button onClick={() => onSave(p)} disabled={!p.name.trim()} className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl disabled:opacity-40">Save policy</button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, hint, children }) {
  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
        {hint && <p className="text-[11px] text-gray-400">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

function Loading() {
  return <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-indigo-500" /></div>
}
