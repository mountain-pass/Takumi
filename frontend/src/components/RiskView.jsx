/**
 * RiskView — Risk & Compliance home. Two tabs:
 *  - Policy: the company risk appetite, threshold, ISO 31000 scoring scales,
 *    categories, and a visual 5×5 risk matrix. Consumed by every assessment.
 *  - Register: the log of every risk assessment (score, level, verdict, decision).
 */
import React, { useState, useEffect, useRef } from 'react'
import { ShieldCheck, Loader2, Save, ScrollText, SlidersHorizontal, Trash2, X, MessageSquareText } from 'lucide-react'

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
          <TabBtn active={tab === 'register'} onClick={() => setTab('register')} icon={ScrollText}>Risk Register</TabBtn>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === 'policy' && <PolicyTab />}
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
    await fetch('/api/risk/policies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: active.id, name: active.name, body: active.body,
        threshold: active.threshold, review_frequency_months: active.review_frequency_months || 12,
        rationale: active.rationale || '' }),
    })
    setSavedPol(true); setTimeout(() => setSavedPol(false), 2500); loadPolicies()
  }
  async function saveFw() {
    await fetch('/api/risk/policy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories: fw.categories, likelihood_scale: fw.likelihood_scale,
        consequence_scale: fw.consequence_scale, mode: fw.mode }),
    })
    setSavedFw(true); setTimeout(() => setSavedFw(false), 2500)
  }
  async function setDefault(id) { await fetch(`/api/risk/policies/${id}/default`, { method: 'POST' }); loadPolicies() }
  async function markReviewed() { await fetch(`/api/risk/policies/${active.id}/reviewed`, { method: 'POST' }); loadPolicies() }
  function viewPolicy(id) { setActive(policies.find(p => p.id === id) || null); setSavedPol(false) }
  async function deletePolicy() {
    if (!active || !confirm(`Delete policy "${active.name || 'Untitled'}"? This cannot be undone.`)) return
    await fetch(`/api/risk/policies/${active.id}`, { method: 'DELETE' }); loadPolicies()
  }

  const threshold = active?.threshold || 10
  const lvl = LEVELS.find(l => l.key === levelOf(threshold))
  return (
    <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
      {/* Policy selector — view/edit any policy; the agent follows whichever is active */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-gray-500 shrink-0">Policy:</span>
          <select value={active?.id || ''} onChange={e => viewPolicy(e.target.value)} className="input py-1 text-sm min-w-0">
            {policies.map(p => <option key={p.id} value={p.id}>{p.name || 'Untitled'} (block ≥ {p.threshold}){p.is_default ? ' • active' : ''}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {active && !active.is_default &&
            <button onClick={() => setDefault(active.id)}
              className="px-3 py-2 text-sm font-medium rounded-xl border border-indigo-300 text-indigo-700 hover:bg-indigo-50">Set as active</button>}
          {active && policies.length > 1 &&
            <button onClick={deletePolicy} title="Delete this policy"
              className="px-3 py-2 text-sm font-medium rounded-xl border border-red-200 text-red-600 hover:bg-red-50">Delete</button>}
          <button onClick={() => setInterviewing(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium">
            <MessageSquareText size={14} /> New policy
          </button>
        </div>
      </div>
      {active && active.is_default
        ? <p className="text-[11px] text-green-600 -mt-3">✓ The agent follows this policy.</p>
        : <p className="text-[11px] text-gray-400 -mt-3">Viewing an inactive policy — "Set as active" to make the agent follow it.</p>}

      {active && (
        <>
          {/* Review status banner */}
          <div className={`rounded-xl border p-3 ${active.overdue ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50/60'}`}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-gray-600">
                <b className="text-gray-800">Review:</b> last {active.last_reviewed || 'never'} · next due {active.next_review || '—'} · every {active.review_frequency_months || 12} months
                {active.overdue && <span className="ml-2 text-amber-700 font-semibold">⚠ review due{active.reason ? ` (${active.reason})` : ''}</span>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {(JSON.parse(active.transcript || '[]').length > 0 || active.rationale) &&
                  <button onClick={() => setViewing(active)} className="text-[11px] text-gray-500 hover:underline">Review policy</button>}
                <button onClick={markReviewed} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white">Mark reviewed</button>
              </div>
            </div>
          </div>

          {/* Appetite + threshold (per active policy) */}
          <Section title="Risk appetite / policy" hint="Injected into every assessment so the agent scores against your specification.">
            <textarea rows={6} className="input resize-y" value={active.body || ''} onChange={e => setA('body', e.target.value)} />
          </Section>
          <Section title="Block at score & review cadence">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm text-gray-700">Block at score</span>
              <input type="number" min={1} max={25} value={threshold} onChange={e => setA('threshold', Math.max(1, Math.min(25, parseInt(e.target.value || '1', 10) || 1)))} className="w-20 input text-right" />
              <span className={`text-[11px] px-2 py-0.5 rounded border ${lvl.cls}`}>{lvl.label}+ blocked</span>
              <span className="text-sm text-gray-700 ml-3">Review every</span>
              <input type="number" min={1} max={60} value={active.review_frequency_months || 12} onChange={e => setA('review_frequency_months', Math.max(1, Math.min(60, parseInt(e.target.value || '12', 10) || 12)))} className="w-20 input text-right" />
              <span className="text-sm text-gray-700">months</span>
            </div>
            <div className="mt-3"><RiskMatrix threshold={threshold} like={fw.likelihood_scale} cons={fw.consequence_scale} /></div>
            <div className="flex items-center gap-3 mt-3">
              <button onClick={savePolicy} className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium"><Save size={14} /> Save policy</button>
              {savedPol && <span className="text-xs text-green-600">Saved ✓</span>}
            </div>
          </Section>
        </>
      )}

      <hr className="border-gray-200" />
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Scoring framework (org-wide)</p>

      {/* Compliance mode */}
      <Section title="Compliance review mode" hint="How much work the Risk & Compliance agent gates (requires a Risk & Compliance agent).">
        <div className="grid grid-cols-3 gap-2">
          {MODES.map(m => (
            <button key={m.id} onClick={() => setFwField('mode', m.id)}
              className={`text-left px-3 py-2 rounded-xl border text-xs ${(fw.mode || 'all') === m.id ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:bg-gray-50'}`}>
              <div className="font-semibold text-gray-800">{m.label}</div>
              <div className="text-[10px] text-gray-400 mt-0.5">{m.hint}</div>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Likelihood scale (1–5)" hint="Define what each level means so scoring is consistent and auditable.">
        <ScaleEditor scale={fw.likelihood_scale} onChange={s => setFwField('likelihood_scale', s)} />
      </Section>
      <Section title="Consequence / impact scale (1–5)" hint="Define the impact at each level (financial, data, legal, reputational…).">
        <ScaleEditor scale={fw.consequence_scale} onChange={s => setFwField('consequence_scale', s)} />
      </Section>
      <Section title="Risk categories" hint="Which categories the agent scores against.">
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
      <div className="flex items-center gap-3">
        <button onClick={saveFw} className="flex items-center gap-1.5 px-4 py-2 bg-gray-700 hover:bg-gray-800 text-white rounded-xl text-sm font-medium"><Save size={14} /> Save framework</button>
        {savedFw && <span className="text-xs text-green-600">Saved ✓</span>}
      </div>

      {interviewing && <PolicyInterview onDone={() => { setInterviewing(false); loadPolicies() }} onClose={() => setInterviewing(false)} />}
      {viewing && <TranscriptViewer policy={viewing} onClose={() => setViewing(null)} />}
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

function PolicyInterview({ onDone, onClose }) {
  const [msgs, setMsgs] = useState([])          // {role, content}
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(true)
  const [final, setFinal] = useState(null)      // {name, appetite, threshold, rationale}
  const [saving, setSaving] = useState(false)
  const endRef = useRef(null)
  const started = useRef(false)

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
          review_frequency_months: d.review_frequency_months || 12, rationale: d.rationale || '' })
      } else {
        setMsgs(m => [...m, { role: 'assistant', content: d.question || '…' }])
      }
    } finally { setBusy(false) }
  }
  useEffect(() => { if (started.current) return; started.current = true; step([]) }, [])  // once, even under StrictMode
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs, final])

  function send() {
    const text = input.trim()
    if (!text || busy) return
    const next = [...msgs, { role: 'user', content: text }]
    setMsgs(next); setInput('')
    step(next)
  }
  async function save() {
    setSaving(true)
    await fetch('/api/risk/policies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // A freshly interviewed policy becomes the active global policy (the user can
      // switch back via the selector).
      body: JSON.stringify({ name: final.name, body: final.appetite, threshold: final.threshold,
        review_frequency_months: final.review_frequency_months || 12, rationale: final.rationale || '',
        transcript: msgs, make_default: true }),
    })
    setSaving(false); onDone()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2"><MessageSquareText size={16} className="text-indigo-500" /> Policy interview</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        {!final ? (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {msgs.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-800'}`}>{m.content}</div>
                </div>
              ))}
              {busy && <div className="flex justify-start"><div className="bg-gray-100 rounded-2xl px-3.5 py-2"><Loader2 size={14} className="animate-spin text-gray-400" /></div></div>}
              <div ref={endRef} />
            </div>
            <div className="px-4 py-3 border-t border-gray-100 flex gap-2">
              <input className="input flex-1" placeholder="Type your answer…" value={input}
                onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} disabled={busy} />
              <button onClick={send} disabled={busy || !input.trim()} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium disabled:opacity-40">Send</button>
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            <p className="text-xs text-gray-500">The Manager drafted this from your answers. Review and adjust the block-at-score before saving.</p>
            <label className="block space-y-1"><span className="text-[11px] font-semibold text-gray-400 uppercase">Name</span>
              <input className="input" value={final.name} onChange={e => setFinal({ ...final, name: e.target.value })} /></label>
            <label className="block space-y-1"><span className="text-[11px] font-semibold text-gray-400 uppercase">Risk appetite / policy</span>
              <textarea className="input resize-y" rows={7} value={final.appetite} onChange={e => setFinal({ ...final, appetite: e.target.value })} /></label>
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-700">Block at score</span>
              <input type="number" min={1} max={25} className="input w-20 text-right" value={final.threshold}
                onChange={e => setFinal({ ...final, threshold: Math.max(1, Math.min(25, parseInt(e.target.value || '1', 10) || 1)) })} />
              <span className="text-[11px] text-gray-400">Manager suggested {final.threshold} — override if you prefer.</span>
            </div>
            {final.rationale && <p className="text-[11px] text-gray-500 bg-amber-50 border border-amber-100 rounded-lg p-2"><b>Why:</b> {final.rationale}</p>}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h3 className="text-sm font-bold text-gray-900">How "{policy.name}" was derived</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div className="flex flex-wrap gap-2 text-[11px] mb-1">
            <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-600">block ≥ {policy.threshold}</span>
            <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-500">review every {policy.review_frequency_months || 12} months</span>
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
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700'}`}>{m.content}</div>
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
