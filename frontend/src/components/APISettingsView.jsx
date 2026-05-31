/**
 * APISettingsView — manage named API provider configs (LLM, and future types).
 */
import React, { useState } from 'react'
import { Plus, Trash2, CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp, Pencil } from 'lucide-react'
import {
  useProviders, useCreateProvider, useUpdateProvider,
  useDeleteProvider, useTestProvider, useProviderModels,
} from '../hooks/useApi'

const LLM_PROVIDERS = [
  { id: 'anthropic',    label: 'Anthropic',        defaultUrl: 'https://api.anthropic.com' },
  { id: 'openai',       label: 'OpenAI',           defaultUrl: 'https://api.openai.com/v1' },
  { id: 'ollama',       label: 'Ollama',           defaultUrl: 'https://ollama.com' },
  { id: 'gemini',       label: 'Google Gemini',    defaultUrl: 'https://generativelanguage.googleapis.com' },
  { id: 'openrouter',   label: 'OpenRouter',       defaultUrl: 'https://openrouter.ai/api/v1' },
  { id: 'custom',       label: 'Custom',           defaultUrl: '' },
]

const PROVIDER_TYPES = [
  { id: 'llm', label: 'LLM' },
]

function ProviderIcon({ provider }) {
  const colors = {
    anthropic: '#d97706', openai: '#10b981', ollama: '#6366f1',
    gemini: '#3b82f6', openrouter: '#8b5cf6', custom: '#6b7280',
  }
  const label = LLM_PROVIDERS.find(p => p.id === provider)?.label || provider
  return (
    <div
      className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0"
      style={{ backgroundColor: colors[provider] || '#6b7280' }}
    >
      {label[0].toUpperCase()}
    </div>
  )
}

// ── Add / Edit form ───────────────────────────────────────────────────────────

function ProviderForm({ initial, onSave, onCancel, saving }) {
  const [name, setName] = useState(initial?.name || '')
  const [type, setType] = useState(initial?.type || 'llm')
  const [provider, setProvider] = useState(initial?.provider || 'anthropic')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(initial?.base_url || LLM_PROVIDERS[0].defaultUrl)
  const [testResult, setTestResult] = useState(null)
  const [testMsg, setTestMsg] = useState('')
  const [testing, setTesting] = useState(false)

  function handleProviderChange(id) {
    setProvider(id)
    const def = LLM_PROVIDERS.find(p => p.id === id)
    setBaseUrl(def?.defaultUrl || '')
    setTestResult(null)
    const wasAutoFilled = !name || LLM_PROVIDERS.some(p => p.label === name)
    if (wasAutoFilled) setName(def?.label || '')
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch('/api/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm_provider: provider, llm_api_key: apiKey, llm_base_url: baseUrl, llm_model: '' }),
      })
      if (!res.ok) {
        const text = await res.text()
        let msg = text
        try { msg = JSON.parse(text).detail || text } catch {}
        throw new Error(msg)
      }
      const data = await res.json()
      setTestResult('ok')
      setTestMsg(data.response || 'Connected!')
    } catch (e) {
      setTestResult('error')
      setTestMsg(e.message)
    } finally {
      setTesting(false)
    }
  }

  function handleSubmit(e) {
    e.preventDefault()
    onSave({ name, type, provider, api_key: apiKey, base_url: baseUrl })
  }

  const isEdit = !!initial

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs font-medium text-gray-500 mb-1">Display Name</label>
          <input
            required
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400"
            placeholder="e.g. My Anthropic Key"
            value={name} onChange={e => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
          <select
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400 bg-white"
            value={type} onChange={e => setType(e.target.value)}
          >
            {PROVIDER_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Provider</label>
          <select
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400 bg-white"
            value={provider} onChange={e => handleProviderChange(e.target.value)}
          >
            {LLM_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>

        <div className="col-span-2">
          <label className="block text-xs font-medium text-gray-500 mb-1">
            API Key {isEdit && <span className="text-gray-400">(leave blank to keep existing)</span>}
          </label>
          <input
            type="password"
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400"
            placeholder={isEdit ? '••••••••' : 'Enter API key'}
            value={apiKey} onChange={e => { setApiKey(e.target.value); setTestResult(null) }}
          />
        </div>

        <div className="col-span-2">
          <label className="block text-xs font-medium text-gray-500 mb-1">Base URL</label>
          <input
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400"
            placeholder="https://api.example.com/v1"
            value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setTestResult(null) }}
          />
        </div>
      </div>

      {/* Test Connection */}
      <button
        type="button"
        onClick={handleTest}
        disabled={testing}
        className="w-full flex items-center justify-center gap-2 border border-indigo-300 text-indigo-600 hover:bg-indigo-50 rounded-xl py-2 text-sm font-medium transition-colors disabled:opacity-40"
      >
        {testing ? <><Loader2 size={13} className="animate-spin" /> Testing…</> : 'Test Connection'}
      </button>

      {testResult && (
        <div className={`flex items-start gap-2 p-2.5 rounded-xl text-xs ${testResult === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {testResult === 'ok'
            ? <><CheckCircle size={13} className="mt-0.5 shrink-0" /> Connected — "{testMsg}"</>
            : <><XCircle size={13} className="mt-0.5 shrink-0" /> {testMsg}</>}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onCancel}
          className="flex-1 border border-gray-200 rounded-xl py-2 text-sm hover:bg-gray-50">
          Cancel
        </button>
        <button type="submit" disabled={saving}
          className="flex-1 bg-indigo-600 text-white rounded-xl py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2">
          {saving && <Loader2 size={14} className="animate-spin" />}
          {isEdit ? 'Save Changes' : 'Add Provider'}
        </button>
      </div>
    </form>
  )
}

// ── Provider card ─────────────────────────────────────────────────────────────

function ProviderCard({ provider, onDeleted }) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [testResult, setTestResult] = useState(null) // 'ok' | 'error'
  const [testMsg, setTestMsg] = useState('')

  const updateMut  = useUpdateProvider()
  const deleteMut  = useDeleteProvider()
  const testMut    = useTestProvider()
  const { data: modelsData, isFetching: loadingModels } = useProviderModels(expanded ? provider.id : null)

  async function handleTest() {
    setTestResult(null)
    try {
      const res = await testMut.mutateAsync(provider.id)
      setTestResult('ok')
      setTestMsg(res.response || 'Connected!')
    } catch (e) {
      setTestResult('error')
      setTestMsg(e.message)
    }
  }

  async function handleSave(data) {
    await updateMut.mutateAsync({ id: provider.id, ...data })
    setEditing(false)
  }

  async function handleDelete() {
    if (!confirm(`Remove "${provider.name}"?`)) return
    await deleteMut.mutateAsync(provider.id)
    onDeleted?.()
  }

  const typeLabel = PROVIDER_TYPES.find(t => t.id === provider.type)?.label || provider.type
  const providerLabel = LLM_PROVIDERS.find(p => p.id === provider.provider)?.label || provider.provider

  return (
    <div className="border border-gray-200 rounded-2xl bg-white shadow-sm overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <ProviderIcon provider={provider.provider} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-800 truncate">{provider.name}</p>
          <p className="text-xs text-gray-400">{typeLabel} · {providerLabel}
            {provider.api_key_set && <span className="ml-2 text-green-600 font-medium">● Key saved</span>}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setEditing(e => !e)}
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <Pencil size={14} />
          </button>
          <button onClick={handleDelete} disabled={deleteMut.isPending}
            className="p-1.5 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500">
            <Trash2 size={14} />
          </button>
          <button onClick={() => setExpanded(e => !e)}
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100">
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Edit form */}
      {editing && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3">
          <ProviderForm
            initial={provider}
            saving={updateMut.isPending}
            onSave={handleSave}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}

      {/* Expanded details */}
      {expanded && !editing && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-3">
          {/* Test connection */}
          <div className="flex items-center gap-2">
            <button onClick={handleTest} disabled={testMut.isPending}
              className="flex items-center gap-2 px-3 py-1.5 border border-gray-200 rounded-xl text-xs font-medium hover:bg-gray-50 disabled:opacity-50">
              {testMut.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
              Test Connection
            </button>
            {testResult === 'ok' && (
              <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                <CheckCircle size={12} /> {testMsg}
              </span>
            )}
            {testResult === 'error' && (
              <span className="flex items-center gap-1 text-xs text-red-500">
                <XCircle size={12} /> {testMsg}
              </span>
            )}
          </div>

          {/* Available models */}
          <div>
            <p className="text-xs font-medium text-gray-500 mb-1.5">Available Models</p>
            {loadingModels ? (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <Loader2 size={12} className="animate-spin" /> Loading models…
              </div>
            ) : modelsData?.models?.length ? (
              <div className="flex flex-wrap gap-1.5">
                {modelsData.models.map(m => (
                  <span key={m} className="px-2 py-0.5 bg-gray-100 rounded-lg text-xs text-gray-600 font-mono">{m}</span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400">No models found</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function APISettingsView() {
  const { data: providers = [], isLoading } = useProviders()
  const createMut = useCreateProvider()
  const [showAdd, setShowAdd] = useState(false)

  async function handleCreate(data) {
    await createMut.mutateAsync(data)
    setShowAdd(false)
  }

  const llmProviders = providers.filter(p => p.type === 'llm')

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-gray-800">API Providers</h1>
          <p className="text-xs text-gray-400 mt-0.5">Manage API credentials for your agents</p>
        </div>
        <button
          onClick={() => setShowAdd(s => !s)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700">
          <Plus size={14} /> Add Provider
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">

        {/* Add form */}
        {showAdd && (
          <div className="border border-indigo-200 rounded-2xl bg-indigo-50/50 p-4">
            <p className="text-sm font-semibold text-gray-700 mb-3">New Provider</p>
            <ProviderForm
              saving={createMut.isPending}
              onSave={handleCreate}
              onCancel={() => setShowAdd(false)}
            />
          </div>
        )}

        {/* LLM section */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-3">LLM Providers</p>
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          ) : llmProviders.length === 0 && !showAdd ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
              <p className="text-sm">No LLM providers configured yet.</p>
              <button onClick={() => setShowAdd(true)}
                className="text-indigo-600 text-sm font-medium hover:underline">
                + Add your first provider
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {llmProviders.map(p => (
                <ProviderCard key={p.id} provider={p} />
              ))}
            </div>
          )}
        </div>

        {/* Future sections placeholder */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-3">Other Integrations</p>
          <div className="border border-dashed border-gray-200 rounded-2xl p-6 text-center text-gray-400 text-sm">
            Twitter, Yahoo Finance, and more — coming soon
          </div>
        </div>
      </div>
    </div>
  )
}
