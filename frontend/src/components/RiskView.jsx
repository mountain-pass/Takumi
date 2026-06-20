/**
 * RiskView — Risk & Compliance home. Two tabs:
 *  - Policy: the company risk appetite, threshold, ISO 31000 scoring scales,
 *    categories, and a visual 5×5 risk matrix. Consumed by every assessment.
 *  - Register: the log of every risk assessment (score, level, verdict, decision).
 */
import React, { useState, useEffect, useRef } from 'react'
import { ShieldCheck, Loader2, Save, ScrollText, SlidersHorizontal, Trash2, X, MessageSquareText, History, Info, Lock } from 'lucide-react'
import { useBackdropDismiss } from './useBackdropDismiss'

const MODES = [
  { id: 'all', label: 'All tasks', hint: 'Every finished task is reviewed against the policy.' },
  { id: 'unless_excluded', label: 'All tasks, unless excluded', hint: 'Review everything unless you explicitly tell the Manager to exclude a task. Every bypass is recorded in the Audit trail.' },
  { id: 'off', label: 'Off', hint: 'No compliance review.' },
]
// Legacy 'match' value maps to the new bypass mode.
const normMode = (m) => (m === 'match' ? 'unless_excluded' : (m || 'all'))

const LEVELS = [
  { key: 'low', label: 'Low', cls: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'medium', label: 'Medium', cls: 'bg-yellow-100 text-yellow-700 border-yellow-200' },
  { key: 'high', label: 'High', cls: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'critical', label: 'Critical', cls: 'bg-red-100 text-red-700 border-red-200' },
]
const levelOf = (s) => s >= 16 ? 'critical' : s >= 10 ? 'high' : s >= 5 ? 'medium' : 'low'
const cellTone = (s) => s >= 16 ? 'bg-red-400/80' : s >= 10 ? 'bg-orange-400/80' : s >= 5 ? 'bg-yellow-300/80' : 'bg-green-300/70'

// Generic — never change. Appetite lives in the per-policy impact table only.
const SEVERITY_LABELS = ['Insignificant', 'Minor', 'Moderate', 'Major', 'Severe']
const LIKELIHOOD_LABELS = ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain']
const GENERIC_LIKELIHOOD = LIKELIHOOD_LABELS.map(label => ({ label }))
const SEVERITY_SCALE = SEVERITY_LABELS.map(label => ({ label }))
const IMPACT_CATEGORIES = ['financial', 'data_privacy', 'security', 'legal_compliance', 'reputational', 'operational']
const catLabel = (c) => (c || '').replace(/_/g, ' ')

// Coerce any stored impact_table (JSON string or array) into editable rows.
function normImpactTable(raw) {
  let items = raw
  if (typeof raw === 'string') { try { items = JSON.parse(raw || '[]') } catch { items = [] } }
  const byCat = {}
  for (const r of (items || [])) if (r && r.category) byCat[r.category] = r.definitions || []
  return IMPACT_CATEGORIES.map(cat => ({
    category: cat,
    definitions: Array.from({ length: 5 }, (_, i) => (byCat[cat] && byCat[cat][i]) || ''),
  }))
}

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
          <TabBtn active={tab === 'register'} onClick={() => setTab('register')} icon={ScrollText}>Risk Register</TabBtn>
          <TabBtn active={tab === 'audit'} onClick={() => setTab('audit')} icon={History}>Audit</TabBtn>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === 'policy' && <PolicyTab />}
        {tab === 'register' && <RegisterTab />}
        {tab === 'audit' && <AuditTab />}
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

// ── Global Policy tab ─────────────────────────────────────────────────────────
// One active policy (created via interview) the agent follows, plus the org-wide
// scoring framework (matrix, scales, categories, mode) and the review lifecycle.
function PolicyTab() {
  const [fw, setFw] = useState(null)            // framework: scales/categories/mode
  const [policies, setPolicies] = useState(null)
  const [active, setActive] = useState(null)    // editable copy of the active policy
  const [interviewing, setInterviewing] = useState(false)
  const [viewing, setViewing] = useState(null)
  const [savedFw, setSavedFw] = useState(false)
  const [savedPol, setSavedPol] = useState(false)
  const [savingFw, setSavingFw] = useState(false)
  const [savingPol, setSavingPol] = useState(false)
  const [reviewing, setReviewing] = useState(false)

  const loadFw = () => fetch('/api/risk/policy').then(r => r.json()).then(setFw).catch(() => setFw({}))
  const loadPolicies = () => fetch('/api/risk/policies').then(r => r.json()).then(list => {
    setPolicies(list)
    setActive(list.find(p => p.is_default) || list[0] || null)
  }).catch(() => setPolicies([]))
  useEffect(() => { loadFw(); loadPolicies() }, [])

  if (!fw || !policies) return <Loading />

  // ── New project: no policy yet → interview to create the global policy ──
  if (policies.length === 0) {
    return (
      <div className="max-w-xl mx-auto px-6 py-16 text-center">
        <ShieldCheck size={36} className="mx-auto mb-3 text-indigo-400" />
        <h2 className="text-base font-bold text-gray-800">Set up your global risk policy</h2>
        <p className="text-sm text-gray-500 mt-1 mb-5">
          The Manager will interview you — one question at a time — about your organisation and risk
          appetite, then draft a policy with a suggested block-at-score and a review cadence you can adjust.
        </p>
        <button onClick={() => setInterviewing(true)}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium">
          <MessageSquareText size={16} /> Start the interview
        </button>
        {interviewing && <PolicyInterview onDone={() => { setInterviewing(false); loadPolicies() }} onClose={() => setInterviewing(false)} />}
      </div>
    )
  }

  const setA = (k, v) => { setActive(p => ({ ...p, [k]: v })); setSavedPol(false) }
  const setFwField = (k, v) => { setFw(p => ({ ...p, [k]: v })); setSavedFw(false) }
  const toggleCat = (c) => {
    const cats = fw.categories || []
    setFwField('categories', cats.includes(c) ? cats.filter(x => x !== c) : [...cats, c])
  }
  async function savePolicy() {
    setSavingPol(true)
    try {
      await fetch('/api/risk/policies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: active.id, name: active.name, body: active.body,
          threshold: active.threshold, review_frequency_months: active.review_frequency_months || 12,
          rationale: active.rationale || '', impact_table: normImpactTable(active.impact_table) }),
      })
      await loadPolicies()
      setSavedPol(true); setTimeout(() => setSavedPol(false), 2500)
    } finally { setSavingPol(false) }
  }
  async function saveFw() {
    setSavingFw(true)
    try {
      await fetch('/api/risk/policy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: fw.categories, likelihood_scale: fw.likelihood_scale,
          consequence_scale: fw.consequence_scale, mode: fw.mode }),
      })
      setSavedFw(true); setTimeout(() => setSavedFw(false), 2500)
    } finally { setSavingFw(false) }
  }
  async function setDefault(id) { await fetch(`/api/risk/policies/${id}/default`, { method: 'POST' }); loadPolicies() }
  async function markReviewed() {
    setReviewing(true)
    try {
      await fetch(`/api/risk/policies/${active.id}/reviewed`, { method: 'POST' })
      await loadPolicies()
    } finally { setReviewing(false) }
  }
  function viewPolicy(id) { setActive(policies.find(p => p.id === id) || null); setSavedPol(false) }
  async function deletePolicy() {
    if (!active || !confirm(`Delete policy "${active.name || 'Untitled'}"? This cannot be undone.`)) return
    await fetch(`/api/risk/policies/${active.id}`, { method: 'DELETE' }); loadPolicies()
  }

  const threshold = active?.threshold || 10
  const lvl = LEVELS.find(l => l.key === levelOf(threshold))
  const mode = normMode(fw.mode)
  return (
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
      {/* ── Active policy header: which policy the agent follows, + actions ── */}
      <Card>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-semibold text-gray-500 shrink-0">Active policy</span>
            <select value={active?.id || ''} onChange={e => viewPolicy(e.target.value)} className="input py-1.5 text-sm min-w-0">
              {policies.map(p => <option key={p.id} value={p.id}>{p.name || 'Untitled'} (block ≥ {p.threshold}){p.is_default ? ' • active' : ''}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {active && (JSON.parse(active.transcript || '[]').length > 0 || active.rationale) &&
              <button onClick={() => setViewing(active)} title="Read the full interview that produced this policy"
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-xl border border-gray-300 text-gray-700 hover:bg-gray-50">
                <MessageSquareText size={14} /> View interview</button>}
            {active && !active.is_default &&
              <button onClick={() => setDefault(active.id)}
                className="px-3 py-2 text-sm font-medium rounded-xl border border-indigo-300 text-indigo-700 hover:bg-indigo-50">Set as active</button>}
            {active &&
              <button onClick={deletePolicy} title="Delete this policy"
                className="px-3 py-2 text-sm font-medium rounded-xl border border-red-200 text-red-600 hover:bg-red-50">Delete</button>}
            <button onClick={() => setInterviewing(true)}
              className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium">
              <MessageSquareText size={14} /> New policy
            </button>
          </div>
        </div>
        {active && (active.is_default
          ? <p className="text-[11px] text-green-600">✓ The agent follows this policy.</p>
          : <p className="text-[11px] text-gray-400">Viewing an inactive policy — "Set as active" to make the agent follow it.</p>)}

        {/* Review lifecycle */}
        {active && (
          <div className={`rounded-xl border p-3 ${active.overdue ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50/60'}`}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-gray-600">
                <b className="text-gray-800">Review:</b> last {active.last_reviewed || 'never'} · next due {active.next_review || '—'} · every {active.review_frequency_months || 12} months
                {active.overdue && <span className="ml-2 text-amber-700 font-semibold">⚠ review due{active.reason ? ` (${active.reason})` : ''}</span>}
              </div>
              <button onClick={markReviewed} disabled={reviewing} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white shrink-0 disabled:opacity-60">
                {reviewing && <Loader2 size={12} className="animate-spin" />}{reviewing ? 'Saving…' : 'Mark reviewed'}</button>
            </div>
          </div>
        )}
      </Card>

      {/* ── The policy document: appetite (impact table) → matrix → summary ── */}
      {active && (
        <Card>
          <CardHeader title="The policy"
            subtitle="Your risk appetite, expressed as the impact table. The likelihood scale and 5×5 matrix are generic — appetite is set here, so one block-at-score applies uniformly."
            info="A policy is YOUR organisation's risk appetite — how much risk you're willing to accept. You can save several, but only one is active (the one the agent follows). It owns the impact table, the block-at-score, the review cadence, and the interview it was derived from. This is the opinionated 'where you draw the line' part — change it per organisation, re-interview, overwrite or delete it freely." />

          <Section title="Impact table — your risk appetite"
            hint="Tune what each severity means per category. Lowering a category's impact lowers its appetite."
            info="The heart of the policy. For each category, it defines what severity 1–5 actually MEANS for you. This is where appetite lives: making 'a large financial loss' only count as Moderate lowers your financial appetite. Because every category is tuned onto the same 1–5 axis, a single block-at-score can apply uniformly — a '5' is equally unacceptable whether it's financial or operational.">
            <ImpactTableEditor table={active.impact_table} onChange={t => setA('impact_table', t)} />
          </Section>

          <Section title="Block-at-score & risk matrix"
            hint="A single uniform threshold across every category. The matrix shows where it bites."
            info="The block-at-score is the single threshold (1–25) at or above which work is blocked. Higher = more risk-tolerant (only the most severe work is blocked); lower = cautious. The 5×5 matrix (likelihood × consequence) is the generic measuring instrument — it shows which cells fall at or above your threshold.">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm text-gray-700">Block at score</span>
              <input type="number" min={1} max={25} value={threshold} onChange={e => setA('threshold', Math.max(1, Math.min(25, parseInt(e.target.value || '1', 10) || 1)))} className="w-20 input text-right" />
              <span className={`text-[11px] px-2 py-0.5 rounded border ${lvl.cls}`}>{lvl.label}+ blocked</span>
              <span className="text-sm text-gray-700 ml-3">Review every</span>
              <input type="number" min={1} max={60} value={active.review_frequency_months || 12} onChange={e => setA('review_frequency_months', Math.max(1, Math.min(60, parseInt(e.target.value || '12', 10) || 12)))} className="w-20 input text-right" />
              <span className="text-sm text-gray-700">months</span>
            </div>
            <div className="mt-4 flex justify-center"><RiskMatrix threshold={threshold} like={GENERIC_LIKELIHOOD} cons={SEVERITY_SCALE} /></div>
          </Section>

          <Section title="Summary (optional prose)"
            hint="A plain-language summary. Keep it consistent with the impact table above."
            info="An optional human-readable summary of the policy. It's for people to read — the agent scores against the impact table, not this text — so keep it consistent with the table above.">
            <textarea rows={4} className="input resize-y" value={active.body || ''} onChange={e => setA('body', e.target.value)} />
          </Section>

          <div className="flex items-center gap-3 pt-1">
            <button onClick={savePolicy} disabled={savingPol} className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium disabled:opacity-60">
              {savingPol ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {savingPol ? 'Saving…' : 'Save policy'}</button>
            {savedPol && <span className="text-xs text-green-600">Saved ✓</span>}
          </div>
        </Card>
      )}

      {/* ── Org-wide scoring framework: mode, generic scale, categories ── */}
      <Card>
        <CardHeader title="Scoring framework"
          subtitle="Org-wide settings shared by every policy — how much work is reviewed, the generic likelihood scale, and which categories are scored."
          info="The framework is the shared, generic scoring machinery every policy is measured with — the ruler, not where you draw the line. It holds the likelihood scale, the 5×5 matrix maths, the categories, and the review mode. It doesn't express appetite; swap policies and the framework stays identical. In short: the framework is HOW risk is measured; the policy is WHERE you decide it's too much." />

        <Section title="Compliance review mode"
          hint="How much work the Risk & Compliance agent gates (requires a Risk & Compliance agent)."
          info="Controls HOW MUCH work goes through compliance review. 'All tasks' reviews everything; 'All tasks, unless excluded' reviews everything unless you explicitly tell the Manager to skip a task (each bypass is logged in the Audit tab); 'Off' disables review entirely.">
          <div className="space-y-2">
            {MODES.map(m => (
              <button key={m.id} onClick={() => setFwField('mode', m.id)}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl border transition-colors ${mode === m.id ? 'border-indigo-400 bg-indigo-50 ring-1 ring-indigo-200' : 'border-gray-200 hover:bg-gray-50'}`}>
                <div className="flex items-center gap-2">
                  <span className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${mode === m.id ? 'border-indigo-500 bg-indigo-500' : 'border-gray-300'}`} />
                  <span className="text-sm font-semibold text-gray-800">{m.label}</span>
                </div>
                <div className="text-[11px] text-gray-400 mt-0.5 ml-6">{m.hint}</div>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Likelihood scale (1–5) — generic"
          hint="The same generic likelihood scale applies to every policy. Consequence severity lives in each policy's impact table."
          info="Defines how PROBABLE something is, from Rare (1) to Almost certain (5). It's generic and shared by every policy — it almost never changes. Likelihood × consequence gives the 1–25 score. Note: consequence severity is NOT set here; that lives in each policy's impact table.">
          <ScaleEditor scale={fw.likelihood_scale} onChange={s => setFwField('likelihood_scale', s)} />
        </Section>

        <Section title="Risk categories"
          hint="Which categories the agent scores against."
          info="The set of risk categories the agent scores every task against (financial, data privacy, security, legal/compliance, reputational, operational). The overall score is the highest category risk, so turning a category off means it's no longer considered.">
          <div className="flex flex-wrap gap-2">
            {(fw.all_categories || fw.categories || []).map(c => {
              const on = (fw.categories || []).includes(c)
              return (
                <button key={c} onClick={() => toggleCat(c)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border capitalize ${on ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                  {c.replace('_', ' ')}
                </button>
              )
            })}
          </div>
        </Section>

        <div className="flex items-center gap-3 pt-1">
          <button onClick={saveFw} disabled={savingFw} className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium disabled:opacity-60">
            {savingFw ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {savingFw ? 'Saving…' : 'Save framework'}</button>
          {savedFw && <span className="text-xs text-green-600">Saved ✓</span>}
        </div>
      </Card>

      {interviewing && <PolicyInterview onDone={() => { setInterviewing(false); loadPolicies() }} onClose={() => setInterviewing(false)} />}
      {viewing && <TranscriptViewer policy={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

function Card({ children }) {
  return <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5 space-y-5">{children}</div>
}

// Click-to-open (i) tooltip explaining what a section is for.
function InfoTip({ text }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  return (
    <span ref={ref} className="relative inline-flex align-middle">
      <button type="button" onClick={() => setOpen(o => !o)} title="What's this?"
        className={`text-gray-300 hover:text-indigo-500 transition-colors ${open ? 'text-indigo-500' : ''}`}>
        <Info size={13} />
      </button>
      {open && (
        <span className="absolute left-1/2 -translate-x-1/2 top-6 z-30 w-64 rounded-xl border border-gray-200 bg-white p-3 text-[11px] leading-relaxed text-gray-600 shadow-lg normal-case font-normal tracking-normal">
          {text}
        </span>
      )}
    </span>
  )
}

function CardHeader({ title, subtitle, info }) {
  return (
    <div className="border-b border-gray-100 pb-3">
      <h2 className="text-base font-bold text-gray-900 flex items-center gap-1.5">
        {title}{info && <InfoTip text={info} />}
      </h2>
      {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
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

// The impact table IS the policy: per category, what each severity 1–5 means.
// Editing the cells tunes appetite so one block-at-score applies uniformly.
function ImpactTableEditor({ table, onChange }) {
  const rows = normImpactTable(table)
  const setCell = (ri, ci, v) => onChange(rows.map((r, i) => i === ri
    ? { ...r, definitions: r.definitions.map((d, j) => (j === ci ? v : d)) } : r))
  return (
    <div className="overflow-x-auto border border-gray-200 rounded-xl">
      <table className="text-[11px] border-collapse w-full">
        <thead>
          <tr className="bg-gray-50">
            <th className="text-left px-2 py-1.5 font-semibold text-gray-500 sticky left-0 bg-gray-50">Category</th>
            {SEVERITY_LABELS.map((s, i) => (
              <th key={i} className="px-2 py-1.5 font-semibold text-gray-500 text-left min-w-[140px]">{i + 1} · {s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r.category} className="border-t border-gray-100 align-top">
              <td className="px-2 py-1.5 font-medium text-gray-700 capitalize sticky left-0 bg-white">{catLabel(r.category)}</td>
              {r.definitions.map((d, ci) => (
                <td key={ci} className="px-1 py-1">
                  <textarea rows={2} className="w-full text-[11px] leading-snug border border-gray-200 rounded p-1 resize-y focus:border-indigo-300 focus:outline-none"
                    value={d} onChange={e => setCell(ri, ci, e.target.value)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Read-only impact table for the policy document.
function ImpactTableView({ table }) {
  const rows = normImpactTable(table)
  return (
    <div className="overflow-x-auto border border-gray-200 rounded-xl">
      <table className="text-[11px] border-collapse w-full">
        <thead>
          <tr className="bg-gray-50">
            <th className="text-left px-2 py-1.5 font-semibold text-gray-500 sticky left-0 bg-gray-50">Category</th>
            {SEVERITY_LABELS.map((s, i) => (
              <th key={i} className="px-2 py-1.5 font-semibold text-gray-500 text-left min-w-[130px]">{i + 1} · {s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.category} className="border-t border-gray-100 align-top">
              <td className="px-2 py-1.5 font-medium text-gray-700 capitalize sticky left-0 bg-white">{catLabel(r.category)}</td>
              {r.definitions.map((d, ci) => (
                <td key={ci} className="px-2 py-1.5 text-gray-600">{d || '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RiskMatrix({ threshold, like = [], cons = [] }) {
  const rows = [5, 4, 3, 2, 1] // consequence high → low
  const cols = [1, 2, 3, 4, 5]
  const gridCols = { display: 'grid', gridTemplateColumns: '6rem repeat(5, 3.25rem)', gap: '0.25rem' }
  return (
    <div className="inline-flex items-stretch gap-1.5 text-[10px] select-none">
      {/* Consequence axis (vertical) */}
      <div className="flex items-center pb-8">
        <span className="font-semibold uppercase tracking-wider text-gray-400 whitespace-nowrap"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>Consequence →</span>
      </div>

      <div>
        <div style={gridCols}>
          {/* corner + likelihood headers */}
          <div />
          {cols.map(l => (
            <div key={l} className="text-center leading-tight pb-0.5" title={like[l - 1]?.definition || like[l - 1]?.label}>
              <div className="font-bold text-gray-600">{l}</div>
              <div className="text-gray-400 truncate">{like[l - 1]?.label || ''}</div>
            </div>
          ))}

          {/* rows: consequence label + cells */}
          {rows.map(c => (
            <React.Fragment key={c}>
              <div className="flex flex-col items-end justify-center pr-2 text-right leading-tight" title={cons[c - 1]?.definition || ''}>
                <span className="font-bold text-gray-600">{c}</span>
                <span className="text-gray-400">{cons[c - 1]?.label || ''}</span>
              </div>
              {cols.map(l => {
                const s = l * c
                const blocked = s >= threshold
                return (
                  <div key={l}
                    className={`h-10 rounded-lg flex items-center justify-center font-bold text-gray-800 transition-shadow ${cellTone(s)} ${
                      blocked ? 'ring-2 ring-gray-900/70 shadow-sm' : 'opacity-80'}`}
                    title={`Likelihood ${l} × Consequence ${c} = ${s}${blocked ? ' — blocked' : ''}`}>
                    {blocked
                      ? <span className="flex items-center gap-0.5"><Lock size={9} className="opacity-60" />{s}</span>
                      : <span className="text-[11px]">{s}</span>}
                  </div>
                )
              })}
            </React.Fragment>
          ))}

          {/* bottom likelihood axis (aligned under the cells) */}
          <div />
          <div className="col-span-5 text-center font-semibold uppercase tracking-wider text-gray-400 pt-1">Likelihood →</div>
        </div>

        {/* legend */}
        <div className="flex items-center gap-1.5 text-gray-400 mt-2" style={{ paddingLeft: '6.25rem' }}>
          <span className="inline-flex items-center justify-center w-4 h-4 rounded ring-2 ring-gray-900/70 bg-gray-100"><Lock size={8} /></span>
          at / above the block-at-score ({threshold}) — blocked
        </div>
      </div>
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

// ── Audit tab ─────────────────────────────────────────────────────────────────
// A trail of executed tasks and compliance governance events (passes, holds,
// approvals/rejections, and user-requested bypasses) for later review.
const AUDIT_KINDS = {
  compliance: { label: 'Compliance', cls: 'bg-indigo-50 text-indigo-600 border-indigo-200' },
  task: { label: 'Task', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  tool: { label: 'Tool', cls: 'bg-gray-100 text-gray-500 border-gray-200' },
  web: { label: 'Web', cls: 'bg-sky-50 text-sky-600 border-sky-200' },
  mcp: { label: 'MCP', cls: 'bg-violet-50 text-violet-600 border-violet-200' },
  shell: { label: 'Shell', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  browser: { label: 'Browser', cls: 'bg-teal-50 text-teal-600 border-teal-200' },
  risk: { label: 'Risk', cls: 'bg-rose-50 text-rose-600 border-rose-200' },
  model: { label: 'Model', cls: 'bg-fuchsia-50 text-fuchsia-600 border-fuchsia-200' },
}

function AuditTab() {
  const [rows, setRows] = useState(null)
  const [onlyCompliance, setOnlyCompliance] = useState(false)
  useEffect(() => {
    fetch('/api/risk/audit?days=30&limit=500').then(r => r.json()).then(setRows).catch(() => setRows([]))
  }, [])
  if (!rows) return <Loading />
  const shown = onlyCompliance ? rows.filter(r => r.kind === 'compliance') : rows
  return (
    <div className="max-w-4xl mx-auto px-6 py-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-gray-400">Audit trail of executed tasks and compliance decisions (last 30 days). Read-only.</p>
        <label className="flex items-center gap-1.5 text-xs text-gray-600 shrink-0 cursor-pointer">
          <input type="checkbox" checked={onlyCompliance} onChange={e => setOnlyCompliance(e.target.checked)} />
          Compliance only
        </label>
      </div>
      {shown.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <History size={28} className="mx-auto mb-2 opacity-40" />
          <p className="text-sm">No audit entries yet.</p>
        </div>
      ) : shown.map(r => {
        const k = AUDIT_KINDS[r.kind] || AUDIT_KINDS.tool
        return (
          <div key={r.id} className={`flex items-start gap-3 p-3 rounded-xl border ${r.ok ? 'border-gray-200' : 'border-amber-200 bg-amber-50/40'}`}>
            <span className={`text-[10px] px-2 py-0.5 rounded border shrink-0 mt-0.5 ${k.cls}`}>{k.label}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800">{(r.action || '').replace(/_/g, ' ') || 'event'}</p>
              {r.summary && <p className="text-[12px] text-gray-500 break-words">{r.summary}</p>}
              {r.agent_name && <p className="text-[10px] text-gray-400 mt-0.5">{r.agent_name}</p>}
            </div>
            <span className="text-[10px] text-gray-400 shrink-0 w-28 text-right">{(r.created_at || '').slice(0, 16).replace('T', ' ')}</span>
          </div>
        )
      })}
    </div>
  )
}

function PolicyInterview({ onDone, onClose }) {
  const [msgs, setMsgs] = useState([])          // {role, content}
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(true)
  const [final, setFinal] = useState(null)      // {name, appetite, threshold, rationale}
  const [saving, setSaving] = useState(false)
  const endRef = useRef(null)
  const started = useRef(false)
  const taRef = useRef(null)

  // Auto-grow the answer box with content, up to half the viewport, then scroll.
  function autosize() {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.5) + 'px'
  }
  useEffect(() => { autosize() }, [input])

  async function step(history) {
    setBusy(true)
    try {
      const r = await fetch('/api/risk/interview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history }),
      })
      const d = await r.json()
      if (d.type === 'final') {
        setFinal({ name: d.name || 'Risk Policy', appetite: d.appetite || '', threshold: d.threshold || 10,
          review_frequency_months: d.review_frequency_months || 12, rationale: d.rationale || '',
          impact_table: d.impact_table || [] })
      } else if (d.type === 'scenario') {
        setMsgs(m => [...m, { role: 'assistant', content: d.scenario || '…', options: d.options || [], scenario: true }])
      } else {
        setMsgs(m => [...m, { role: 'assistant', content: d.question || '…' }])
      }
    } finally { setBusy(false) }
  }
  useEffect(() => { if (started.current) return; started.current = true; step([]) }, [])  // once, even under StrictMode
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs, final])

  // Strip UI-only fields before sending history to the backend.
  const asHistory = (list) => list.map(({ role, content }) => ({ role, content }))
  function answer(text) {
    if (!text || busy) return
    const next = [...msgs, { role: 'user', content: text }]
    setMsgs(next); setInput('')
    step(asHistory(next))
  }
  function send() {
    const text = input.trim()
    if (!text || busy) return
    const next = [...msgs, { role: 'user', content: text }]
    setMsgs(next); setInput('')
    step(asHistory(next))
  }
  async function save() {
    setSaving(true)
    await fetch('/api/risk/policies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // A freshly interviewed policy becomes the active global policy (the user can
      // switch back via the selector).
      body: JSON.stringify({ name: final.name, body: final.appetite, threshold: final.threshold,
        review_frequency_months: final.review_frequency_months || 12, rationale: final.rationale || '',
        impact_table: final.impact_table || [], transcript: msgs, make_default: true }),
    })
    setSaving(false); onDone()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" {...useBackdropDismiss(onClose)}>
      <div className={`bg-white rounded-2xl shadow-2xl w-full ${final ? 'max-w-3xl' : 'max-w-xl'} max-h-[88vh] flex flex-col`}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2"><MessageSquareText size={16} className="text-indigo-500" /> Policy interview</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        {!final ? (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {msgs.map((m, i) => {
                const isLast = i === msgs.length - 1
                return (
                  <div key={i} className="space-y-2">
                    <div className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm text-left ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-800'}`}>
                        {m.scenario && <span className="block text-[10px] font-semibold text-indigo-500 uppercase mb-1">Scenario — would this be acceptable?</span>}
                        {m.content}
                      </div>
                    </div>
                    {/* Calibration choices — pick your view, or type your own below. */}
                    {m.scenario && isLast && !busy && (m.options || []).length > 0 && (
                      <div className="flex flex-wrap gap-2 pl-1">
                        {m.options.map((o, j) => (
                          <button key={j} onClick={() => answer(o)}
                            className="px-3 py-1.5 rounded-full border border-indigo-200 text-indigo-700 text-xs hover:bg-indigo-50">{o}</button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
              {busy && <div className="flex justify-start"><div className="bg-gray-100 rounded-2xl px-3.5 py-2"><Loader2 size={14} className="animate-spin text-gray-400" /></div></div>}
              <div ref={endRef} />
            </div>
            <div className="px-4 py-3 border-t border-gray-100 flex gap-2 items-end">
              <textarea ref={taRef} rows={1} className="input flex-1 resize-none overflow-y-auto leading-relaxed"
                placeholder="Type your answer… (Enter to send, Shift+Enter for a new line)" value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} disabled={busy} />
              <button onClick={send} disabled={busy || !input.trim()} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium disabled:opacity-40 shrink-0">Send</button>
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            <p className="text-xs text-gray-500">The Manager drafted this from your answers. The <b>impact table</b> is the policy — it encodes your appetite per category. Adjust any cell, then save.</p>
            <label className="block space-y-1"><span className="text-[11px] font-semibold text-gray-400 uppercase">Name</span>
              <input className="input" value={final.name} onChange={e => setFinal({ ...final, name: e.target.value })} /></label>

            <div className="space-y-1">
              <span className="text-[11px] font-semibold text-gray-400 uppercase">Impact table (your risk appetite)</span>
              <ImpactTableEditor table={final.impact_table} onChange={t => setFinal({ ...final, impact_table: t })} />
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm text-gray-700">Block at score (applies uniformly)</span>
              <input type="number" min={1} max={25} className="input w-20 text-right" value={final.threshold}
                onChange={e => setFinal({ ...final, threshold: Math.max(1, Math.min(25, parseInt(e.target.value || '1', 10) || 1)) })} />
              <span className={`text-[11px] px-2 py-0.5 rounded border ${LEVELS.find(l => l.key === levelOf(final.threshold)).cls}`}>{LEVELS.find(l => l.key === levelOf(final.threshold)).label}+ blocked</span>
            </div>
            <div><RiskMatrix threshold={final.threshold} like={GENERIC_LIKELIHOOD} cons={SEVERITY_SCALE} /></div>

            <label className="block space-y-1"><span className="text-[11px] font-semibold text-gray-400 uppercase">Summary (optional prose — should match the table)</span>
              <textarea className="input resize-y" rows={4} value={final.appetite} onChange={e => setFinal({ ...final, appetite: e.target.value })} /></label>
            {final.rationale && <p className="text-[11px] text-gray-500 bg-amber-50 border border-amber-100 rounded-lg p-2"><b>Why this block-at:</b> {final.rationale}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setFinal(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-xl">Back to interview</button>
              <button onClick={save} disabled={saving || !final.name.trim()} className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl disabled:opacity-40">{saving ? 'Saving…' : 'Save policy'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TranscriptViewer({ policy, onClose }) {
  const transcript = JSON.parse(policy.transcript || '[]')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" {...useBackdropDismiss(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h3 className="text-sm font-bold text-gray-900">How "{policy.name}" was derived</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div className="flex flex-wrap gap-2 text-[11px] mb-1">
            {policy.created_at && <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-500">interviewed {(policy.created_at || '').slice(0, 10)}</span>}
            <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-600">block ≥ {policy.threshold}</span>
            <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-500">review every {policy.review_frequency_months || 12} months</span>
          </div>
          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase mb-1">Impact table (the appetite)</p>
            <ImpactTableView table={policy.impact_table} />
          </div>
          {policy.rationale && (
            <div className="rounded-lg bg-amber-50 border border-amber-100 p-3">
              <p className="text-[11px] font-semibold text-amber-700 uppercase mb-1">How the block-at-score was derived</p>
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{policy.rationale}</p>
            </div>
          )}
          {transcript.length === 0 && <p className="text-sm text-gray-400">No interview transcript (created manually).</p>}
          {transcript.length > 0 && <p className="text-[11px] font-semibold text-gray-400 uppercase">Interview</p>}
          {transcript.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm text-left ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700'}`}>{m.content}</div>
            </div>
          ))}
          <div className="border-t border-gray-100 pt-3">
            <p className="text-[11px] font-semibold text-gray-400 uppercase mb-1">Resulting policy</p>
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{policy.body}</p>
          </div>
        </div>
      </div>
    </div>
  )
}


function Section({ title, hint, info, children }) {
  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          {title}{info && <InfoTip text={info} />}
        </h2>
        {hint && <p className="text-[11px] text-gray-400">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

function Loading() {
  return <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-indigo-500" /></div>
}
