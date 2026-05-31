/**
 * SetupWizard — first-run onboarding flow.
 * Step 1: Organisation details
 * Step 2: LLM provider + credentials
 * Step 3: Build initial team
 */
import React, { useState, useEffect } from 'react'
import { Building2, Key, Users, ChevronRight, ChevronLeft, Plus, Trash2, CheckCircle, Loader } from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'
import AIPromptWizard from './AIPromptWizard'

const PROVIDERS = [
  { id: 'anthropic',    label: 'Anthropic',        needsKey: true,  needsUrl: false, placeholder: 'sk-ant-...', defaultModel: 'claude-haiku-4-5-20251001' },
  { id: 'openai',       label: 'OpenAI',           needsKey: true,  needsUrl: false, placeholder: 'sk-...',     defaultModel: 'gpt-4o-mini' },
  { id: 'ollama',       label: 'Ollama',           needsKey: false, needsUrl: true,  placeholder: '',            defaultModel: 'gemma3:4b', defaultUrl: 'https://ollama.com', optionalKey: true },
  { id: 'gemini',       label: 'Google Gemini',    needsKey: true,  needsUrl: false, placeholder: 'AIza...',    defaultModel: 'gemini-1.5-flash' },
  { id: 'openrouter',   label: 'OpenRouter',       needsKey: true,  needsUrl: false, placeholder: 'sk-or-...', defaultModel: 'openai/gpt-4o-mini' },
  { id: 'custom',       label: 'Custom / Local',   needsKey: false, needsUrl: true,  placeholder: '',            defaultModel: '', defaultUrl: 'http://localhost:11434/v1', optionalKey: true },
]

const STEP_ICONS = [Building2, Key, Users]
const STEP_LABELS = ['Organisation', 'LLM Setup', 'Your Team']

function StepBar({ current }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {STEP_LABELS.map((label, i) => {
        const Icon = STEP_ICONS[i]
        const done = i < current
        const active = i === current
        return (
          <React.Fragment key={i}>
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all
              ${active ? 'bg-indigo-600 text-white' : done ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-100 text-gray-400'}`}>
              <Icon size={14} />
              {label}
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div className={`flex-1 h-px ${done ? 'bg-indigo-300' : 'bg-gray-200'}`} />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

// ── Step 1 ────────────────────────────────────────────────────────────────────

function StepOrg({ onNext }) {
  const saveOrg = useOrgStore(s => s.saveOrg)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [saving, setSaving] = useState(false)

  async function next() {
    if (!name.trim()) return
    setSaving(true)
    await saveOrg(name.trim(), desc.trim())
    setSaving(false)
    onNext()
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Name your organisation</h2>
        <p className="text-gray-500 mt-1">This is the AI company you're building. Give it a name and purpose.</p>
      </div>

      <div className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-700">Organisation name *</span>
          <input
            className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="e.g. Acme AI Corp"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && next()}
            autoFocus
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-700">Description <span className="text-gray-400 font-normal">(optional)</span></span>
          <textarea
            className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
            rows={3}
            placeholder="What does this organisation do?"
            value={desc}
            onChange={e => setDesc(e.target.value)}
          />
        </label>
      </div>

      <button
        onClick={next}
        disabled={!name.trim() || saving}
        className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-xl py-3 font-medium transition-colors"
      >
        {saving ? <Loader size={16} className="animate-spin" /> : <>Continue <ChevronRight size={16} /></>}
      </button>
    </div>
  )
}

// ── Step 2 ────────────────────────────────────────────────────────────────────

function StepLLM({ onNext, onBack }) {
  const saveLLMSettings = useOrgStore(s => s.saveLLMSettings)
  const testLLM = useOrgStore(s => s.testLLM)

  const [providerId, setProviderId] = useState('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [availableModels, setAvailableModels] = useState([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [testMsg, setTestMsg] = useState('')
  const [saving, setSaving] = useState(false)

  const provider = PROVIDERS.find(p => p.id === providerId)

  // Pre-fill from backend on mount
  useEffect(() => {
    fetch('/api/org').then(r => r.json()).then(d => {
      const pid = d.llm_provider || 'anthropic'
      const p = PROVIDERS.find(x => x.id === pid) || PROVIDERS[0]
      setProviderId(pid)
      setApiKey(d.llm_api_key || '')
      setBaseUrl(d.llm_base_url || p.defaultUrl || '')
      setModel(d.llm_model || p.defaultModel || '')
      fetchModels(pid, d.llm_api_key || '', d.llm_base_url || p.defaultUrl || '')
    }).catch(() => {})
  }, [])

  async function fetchModels(pid, key, url) {
    setFetchingModels(true)
    setAvailableModels([])
    try {
      const res = await fetch('/api/llm/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm_provider: pid, llm_api_key: key, llm_base_url: url, llm_model: '' }),
      })
      const data = await res.json()
      if (data.models?.length) {
        setAvailableModels(data.models)
        setModel(prev => data.models.includes(prev) ? prev : data.models[0])
      }
    } catch {}
    setFetchingModels(false)
  }

  function selectProvider(id) {
    const p = PROVIDERS.find(x => x.id === id)
    setProviderId(id)
    setModel(p.defaultModel || '')
    setBaseUrl(p.defaultUrl || '')
    setApiKey('')
    setAvailableModels([])
    setTestResult(null)
    // Fetch models immediately for providers that don't need a key
    if (!p.needsKey || p.optionalKey) {
      fetchModels(id, '', p.defaultUrl || '')
    }
  }

  async function handleFetchModels() {
    await fetchModels(providerId, apiKey, baseUrl)
  }

  async function runTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await testLLM({ llm_provider: providerId, llm_api_key: apiKey, llm_base_url: baseUrl, llm_model: model })
      setTestResult('ok')
      setTestMsg(res.response || 'Connected!')
    } catch (e) {
      setTestResult('error')
      setTestMsg(e.message)
    } finally {
      setTesting(false)
    }
  }

  async function next() {
    setSaving(true)
    await saveLLMSettings({ llm_provider: providerId, llm_api_key: apiKey, llm_base_url: baseUrl, llm_model: model })
    try {
      await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Default',
          type: 'llm',
          provider: providerId,
          api_key: apiKey,
          base_url: baseUrl,
        }),
      })
    } catch {}
    setSaving(false)
    onNext(providerId, model)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Connect an LLM</h2>
        <p className="text-gray-500 mt-1">Your agents need a brain. Pick a provider and enter your credentials.</p>
      </div>

      {/* Provider grid */}
      <div className="grid grid-cols-2 gap-2">
        {PROVIDERS.map(p => (
          <button
            key={p.id}
            onClick={() => selectProvider(p.id)}
            className={`text-left px-3 py-2.5 rounded-xl border text-sm font-medium transition-all
              ${providerId === p.id ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 hover:border-gray-300 text-gray-700'}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Credentials */}
      <div className="space-y-3">
        {(provider.needsKey || provider.optionalKey) && (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">
              API Key {provider.optionalKey && <span className="text-gray-400 font-normal">(optional)</span>}
            </span>
            <input
              type="password"
              className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent font-mono"
              placeholder={provider.placeholder || 'Enter API key'}
              value={apiKey}
              onChange={e => { setApiKey(e.target.value); setTestResult(null); setAvailableModels([]) }}
            />
          </label>
        )}

        {provider.needsUrl && (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">Base URL</span>
            <input
              className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent font-mono"
              placeholder="http://localhost:11434"
              value={baseUrl}
              onChange={e => { setBaseUrl(e.target.value); setTestResult(null); setAvailableModels([]) }}
            />
          </label>
        )}

        {/* Model selector */}
        <div className="block space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">Default model</span>
            <button
              type="button"
              onClick={handleFetchModels}
              disabled={fetchingModels}
              className="text-xs text-indigo-600 hover:text-indigo-800 disabled:opacity-40 flex items-center gap-1"
            >
              {fetchingModels ? <Loader size={12} className="animate-spin" /> : null}
              {fetchingModels ? 'Loading…' : 'Load Models'}
            </button>
          </div>
          {availableModels.length > 0 ? (
            <select
              className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent font-mono bg-white"
              value={model}
              onChange={e => { setModel(e.target.value); setTestResult(null) }}
            >
              {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input
              className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent font-mono"
              value={model}
              onChange={e => { setModel(e.target.value); setTestResult(null) }}
              placeholder={fetchingModels ? 'Loading models…' : 'e.g. claude-haiku-4-5-20251001'}
            />
          )}
        </div>
      </div>

      {/* Test connection */}
      <button
        onClick={runTest}
        disabled={testing || !model}
        className="w-full flex items-center justify-center gap-2 border border-indigo-300 text-indigo-600 hover:bg-indigo-50 rounded-xl py-2.5 text-sm font-medium transition-colors disabled:opacity-40"
      >
        {testing ? <><Loader size={14} className="animate-spin" /> Testing…</> : 'Test Connection'}
      </button>

      {testResult && (
        <div className={`flex items-start gap-2 p-3 rounded-xl text-sm ${testResult === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {testResult === 'ok' ? <CheckCircle size={16} className="mt-0.5 shrink-0" /> : <span className="shrink-0">✕</span>}
          {testResult === 'ok' ? `Connected — model replied: "${testMsg}"` : testMsg}
        </div>
      )}

      <div className="flex gap-3">
        <button onClick={onBack} className="flex items-center gap-1 px-4 py-3 border border-gray-200 rounded-xl text-sm hover:bg-gray-50">
          <ChevronLeft size={16} /> Back
        </button>
        <button
          onClick={next}
          disabled={saving || !model}
          className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-xl py-3 font-medium transition-colors"
        >
          {saving ? <Loader size={16} className="animate-spin" /> : <>Continue <ChevronRight size={16} /></>}
        </button>
      </div>
    </div>
  )
}

// ── Step 3 ────────────────────────────────────────────────────────────────────

const BLANK_AGENT = { name: '', role: '', description: '', system_prompt: '', llm_provider: 'ollama', llm_model: 'llama3', avatar_color: '#4F46E5' }
const COLORS = ['#4F46E5', '#DC2626', '#059669', '#D97706', '#7C3AED', '#0891B2', '#DB2777']

function AgentForm({ onAdd, llmProvider, llmModel }) {
  const [form, setForm] = useState({ ...BLANK_AGENT, llm_provider: llmProvider, llm_model: llmModel })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function add() {
    if (!form.name || !form.role || !form.system_prompt) { setError('Name, role, and system prompt are required.'); return }
    setSaving(true)
    setError('')
    try {
      await onAdd(form)
      setForm({ ...BLANK_AGENT, llm_provider: llmProvider, llm_model: llmModel })
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border border-gray-200 rounded-xl p-4 space-y-3 bg-gray-50">
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-gray-500">Name *</span>
          <input className="input" value={form.name} onChange={e => upd('name', e.target.value)} placeholder="e.g. Research Analyst" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-gray-500">Role *</span>
          <input className="input" value={form.role} onChange={e => upd('role', e.target.value)} placeholder="e.g. Senior Researcher" />
        </label>
        <label className="block space-y-1 col-span-2">
          <span className="text-xs font-medium text-gray-500">Description</span>
          <input className="input" value={form.description} onChange={e => upd('description', e.target.value)} placeholder="What this agent specialises in" />
        </label>
        <div className="block space-y-1 col-span-2">
          <AIPromptWizard
            name={form.name}
            role={form.role}
            description={form.description}
            currentPrompt={form.system_prompt}
            onAccept={prompt => upd('system_prompt', prompt)}
            onError={setError}
          >
            {({ trigger, actions }) => (
              <>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-gray-500">System Prompt *</span>
                  {trigger}
                </div>
                <textarea
                  className="input resize-y min-h-[80px]"
                  rows={4}
                  value={form.system_prompt}
                  onChange={e => upd('system_prompt', e.target.value)}
                  placeholder="You are a specialist in… Your job is to…"
                />
                {actions}
              </>
            )}
          </AIPromptWizard>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-gray-500">Model</span>
          <input className="input font-mono text-xs" value={form.llm_model} onChange={e => upd('llm_model', e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-gray-500">Colour</span>
          <div className="flex gap-1.5 pt-1 flex-wrap">
            {COLORS.map(c => (
              <button key={c} type="button" onClick={() => upd('avatar_color', c)}
                className="w-5 h-5 rounded-full border-2 transition-all"
                style={{ backgroundColor: c, borderColor: form.avatar_color === c ? '#111' : 'transparent' }} />
            ))}
          </div>
        </label>
      </div>
      {error && <p className="text-red-500 text-xs">{error}</p>}
      <button onClick={add} disabled={saving}
        className="w-full flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-lg py-2 text-sm font-medium transition-colors">
        {saving ? <Loader size={13} className="animate-spin" /> : <><Plus size={13} /> Add Agent</>}
      </button>
    </div>
  )
}

function StepTeam({ onNext, onBack, llmProvider = 'ollama', llmModel = 'gemma3:4b' }) {
  const createAgent = useOrgStore(s => s.createAgent)
  const completeSetup = useOrgStore(s => s.completeSetup)
  const [agents, setAgents] = useState([])
  const [showForm, setShowForm] = useState(true)
  const [launching, setLaunching] = useState(false)
  const [ceoReady, setCeoReady] = useState(false)

  useEffect(() => {
    fetch('/api/agents/bootstrap-ceo', { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        setCeoReady(true)
        setAgents([{ name: data.config?.name || 'CEO', role: data.config?.role || 'Chief Executive Officer', avatar_color: data.config?.avatar_color || '#DC2626' }])
      })
      .catch(() => setCeoReady(true))
  }, [])

  async function addAgent(form) {
    await createAgent(form)
    setAgents(prev => [...prev, form])
    setShowForm(false)
  }

  async function launch() {
    setLaunching(true)
    await completeSetup()
    onNext()
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Build your team</h2>
        <p className="text-gray-500 mt-1">Add specialist agents. The CEO agent is already included.</p>
      </div>

      {/* Existing agents */}
      {agents.length > 0 && (
        <div className="space-y-2">
          {agents.map((a, i) => (
            <div key={i} className="flex items-center gap-3 p-3 bg-white border border-gray-200 rounded-xl">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0" style={{ backgroundColor: a.avatar_color }}>
                {a.name[0]}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{a.name}</p>
                <p className="text-xs text-gray-500 truncate">{a.role}</p>
              </div>
              <button onClick={() => setAgents(prev => prev.filter((_, j) => j !== i))} className="ml-auto text-gray-400 hover:text-red-500">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {showForm
        ? <AgentForm onAdd={addAgent} llmProvider={llmProvider} llmModel={llmModel} />
        : (
          <button onClick={() => setShowForm(true)}
            className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-gray-300 hover:border-indigo-400 hover:text-indigo-600 text-gray-500 rounded-xl py-3 text-sm font-medium transition-colors">
            <Plus size={16} /> Add another agent
          </button>
        )}

      <div className="flex gap-3">
        <button onClick={onBack} className="flex items-center gap-1 px-4 py-3 border border-gray-200 rounded-xl text-sm hover:bg-gray-50">
          <ChevronLeft size={16} /> Back
        </button>
        <button
          onClick={launch}
          disabled={launching}
          className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-xl py-3 font-medium transition-colors"
        >
          {launching ? <Loader size={16} className="animate-spin" /> : 'Launch Organisation →'}
        </button>
      </div>
    </div>
  )
}

// ── Wizard shell ──────────────────────────────────────────────────────────────

export default function SetupWizard() {
  const [step, setStep] = useState(0)
  const [llmSettings, setLlmSettings] = useState({ provider: 'ollama', model: 'gemma3:4b' })

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-xl p-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-bold text-lg">T</div>
          <div>
            <h1 className="text-base font-bold text-gray-900">Takumi</h1>
            <p className="text-xs text-gray-500">AI Organisation Platform</p>
          </div>
        </div>

        <StepBar current={step} />

        {step === 0 && <StepOrg onNext={() => setStep(1)} />}
        {step === 1 && <StepLLM onNext={(provider, model) => { setLlmSettings({ provider, model }); setStep(2) }} onBack={() => setStep(0)} />}
        {step === 2 && <StepTeam onNext={() => {}} onBack={() => setStep(1)} llmProvider={llmSettings.provider} llmModel={llmSettings.model} />}
      </div>

      <style>{`
        .input {
          width: 100%;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 8px 12px;
          font-size: 13px;
          outline: none;
          background: white;
        }
        .input:focus { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.15); }
      `}</style>
    </div>
  )
}
