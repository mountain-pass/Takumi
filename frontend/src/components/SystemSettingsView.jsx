/**
 * SystemSettingsView — manage system LLM provider, org name, and onboarding settings.
 */
import React, { useState, useEffect } from 'react'
import { Settings, CheckCircle, Loader2, Save } from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', needsUrl: false, defaultModel: 'claude-haiku-4-5-20251001' },
  { id: 'openai',    label: 'OpenAI',    needsUrl: false, defaultModel: 'gpt-4o-mini' },
  { id: 'ollama',    label: 'Ollama',    needsUrl: true,  defaultModel: 'gemma3:4b', defaultUrl: 'https://ollama.com' },
  { id: 'gemini',    label: 'Google Gemini', needsUrl: false, defaultModel: 'gemini-1.5-flash' },
  { id: 'glm',       label: 'GLM (Zhipu)', needsUrl: false, defaultModel: 'glm-4-flash' },
  { id: 'minimax',   label: 'MiniMax',   needsUrl: false, defaultModel: 'abab6.5s-chat' },
  { id: 'custom',    label: 'Custom / OpenAI-compatible', needsUrl: true, defaultModel: 'default', defaultUrl: 'http://localhost:11434/v1' },
]

export default function SystemSettingsView() {
  const saveLLMSettings = useOrgStore(s => s.saveLLMSettings)
  const saveOrg = useOrgStore(s => s.saveOrg)
  const testLLM = useOrgStore(s => s.testLLM)

  const [orgName, setOrgName] = useState('')
  const [orgDesc, setOrgDesc] = useState('')
  const [providerId, setProviderId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [availableModels, setAvailableModels] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [testMsg, setTestMsg] = useState('')

  useEffect(() => {
    fetch('/api/org').then(r => r.json()).then(d => {
      setOrgName(d.org_name || '')
      setOrgDesc(d.org_description || '')
      setProviderId(d.llm_provider || 'anthropic')
      setApiKey(d.llm_api_key || '')
      setBaseUrl(d.llm_base_url || '')
      setModel(d.llm_model || '')
      setLoading(false)
      if (d.llm_provider === 'ollama') fetchOllamaModels(d.llm_base_url, d.llm_api_key)
    }).catch(() => setLoading(false))
  }, [])

  function fetchOllamaModels(url, key) {
    const params = new URLSearchParams()
    if (url || baseUrl) params.set('base_url', url || baseUrl)
    if (key || apiKey) params.set('api_key', key || apiKey)
    fetch(`/api/ollama/models?${params}`).then(r => r.json()).then(d => {
      if (d.models?.length) setAvailableModels(d.models)
    }).catch(() => {})
  }

  const provider = PROVIDERS.find(p => p.id === providerId) || PROVIDERS[0]

  function selectProvider(id) {
    const p = PROVIDERS.find(x => x.id === id)
    setProviderId(id)
    setModel(p.defaultModel)
    if (p.defaultUrl) setBaseUrl(p.defaultUrl)
    else setBaseUrl('')
    setAvailableModels([])
    setTestResult(null)
    setSaved(false)
    if (id === 'ollama') fetchOllamaModels(p.defaultUrl, apiKey)
  }

  async function handleTest() {
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

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    try {
      await saveOrg(orgName, orgDesc)
      await saveLLMSettings({ llm_provider: providerId, llm_api_key: apiKey, llm_base_url: baseUrl, llm_model: model })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e) {
      setTestResult('error')
      setTestMsg(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-indigo-500" />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto py-8 px-6 space-y-8">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <Settings size={20} /> System Settings
          </h1>
          <p className="text-sm text-gray-500 mt-1">Manage your organisation and LLM configuration.</p>
        </div>

        {/* Organisation */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Organisation</h2>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">Name</span>
            <input
              className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="Organisation name"
              value={orgName}
              onChange={e => { setOrgName(e.target.value); setSaved(false) }}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">Description <span className="text-gray-400 font-normal">(optional)</span></span>
            <textarea
              className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
              rows={2}
              placeholder="What does this organisation do?"
              value={orgDesc}
              onChange={e => { setOrgDesc(e.target.value); setSaved(false) }}
            />
          </label>
        </div>

        <hr className="border-gray-200" />

        {/* LLM Provider */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">LLM Provider</h2>
          <div className="grid grid-cols-3 gap-2">
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
        </div>

        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">API Key</span>
            <input
              type="password"
              className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent font-mono"
              placeholder="Enter API key"
              value={apiKey}
              onChange={e => { setApiKey(e.target.value); setTestResult(null); setSaved(false) }}
            />
          </label>

          {provider.needsUrl && (
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-gray-700">Base URL</span>
              <input
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent font-mono"
                placeholder="http://localhost:11434"
                value={baseUrl}
                onChange={e => { setBaseUrl(e.target.value); setTestResult(null); setSaved(false) }}
              />
            </label>
          )}

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">Default Model</span>
            {availableModels.length > 0 ? (
              <select
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent font-mono bg-white"
                value={model}
                onChange={e => { setModel(e.target.value); setTestResult(null); setSaved(false) }}
              >
                {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent font-mono"
                value={model}
                onChange={e => { setModel(e.target.value); setTestResult(null); setSaved(false) }}
                placeholder="e.g. gemma3:4b"
              />
            )}
          </label>
        </div>

        {/* Test result */}
        {testResult && (
          <div className={`flex items-start gap-2 p-3 rounded-xl text-sm ${testResult === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {testResult === 'ok' ? <CheckCircle size={16} className="mt-0.5 shrink-0" /> : <span className="shrink-0">✕</span>}
            {testResult === 'ok' ? `Connected — model replied: "${testMsg}"` : testMsg}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={handleTest}
            disabled={testing}
            className="flex items-center justify-center gap-2 px-5 py-2.5 border border-indigo-300 text-indigo-600 hover:bg-indigo-50 rounded-xl text-sm font-medium transition-colors disabled:opacity-40"
          >
            {testing ? <><Loader2 size={14} className="animate-spin" /> Testing…</> : 'Test Connection'}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-medium transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <><CheckCircle size={14} /> Saved</> : <><Save size={14} /> Save Settings</>}
          </button>
        </div>
      </div>
    </div>
  )
}
