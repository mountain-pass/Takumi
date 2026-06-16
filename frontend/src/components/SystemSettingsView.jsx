/**
 * SystemSettingsView — manage system LLM provider, org name, and onboarding settings.
 */
import React, { useState, useEffect } from 'react'
import { Settings, CheckCircle, Loader2, Save, Trash2, AlertTriangle, Download, Upload } from 'lucide-react'
import { useOrg, useOllamaModels, useSaveOrg, useSaveLLMSettings, useTestLLM } from '../hooks/useApi'
import { useOrgStore } from '../stores/orgStore'

const PROVIDERS = [
  { id: 'anthropic',    label: 'Anthropic',      needsUrl: false, defaultModel: 'claude-haiku-4-5-20251001' },
  { id: 'openai',       label: 'OpenAI',         needsUrl: false, defaultModel: 'gpt-4o-mini' },
  { id: 'ollama',       label: 'Ollama',         needsUrl: true,  defaultModel: 'gemma3:4b', defaultUrl: 'https://ollama.com' },
  { id: 'gemini',       label: 'Google Gemini',  needsUrl: false, defaultModel: 'gemini-1.5-flash' },
  { id: 'openrouter',   label: 'OpenRouter',     needsUrl: false, defaultModel: 'openai/gpt-4o-mini' },
  { id: 'custom',       label: 'Custom',         needsUrl: true,  defaultModel: '', defaultUrl: 'http://localhost:11434/v1' },
]

export default function SystemSettingsView() {
  const { data: orgData, isLoading: loading } = useOrg()
  const saveOrgMut = useSaveOrg()
  const saveLLMMut = useSaveLLMSettings()
  const testLLMMut = useTestLLM()
  const fetchOrg = useOrgStore(s => s.fetchOrg)

  const [orgName, setOrgName] = useState('')
  const [orgDesc, setOrgDesc] = useState('')
  const [providerId, setProviderId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [saved, setSaved] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [testMsg, setTestMsg] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Populate form from cached org data
  const populated = React.useRef(false)
  useEffect(() => {
    if (!orgData || populated.current) return
    populated.current = true
    setOrgName(orgData.org_name || '')
    setOrgDesc(orgData.org_description || '')
    setProviderId(orgData.llm_provider || 'anthropic')
    setApiKey(orgData.llm_api_key || '')
    setBaseUrl(orgData.llm_base_url || '')
    setModel(orgData.llm_model || '')
  }, [orgData])

  const { data: ollamaData } = useOllamaModels(
    providerId === 'ollama' ? baseUrl : null,
    providerId === 'ollama' ? apiKey : null,
  )
  const availableModels = ollamaData?.models || []

  const provider = PROVIDERS.find(p => p.id === providerId) || PROVIDERS[0]

  function selectProvider(id) {
    const p = PROVIDERS.find(x => x.id === id)
    setProviderId(id)
    setModel(p.defaultModel)
    if (p.defaultUrl) setBaseUrl(p.defaultUrl)
    else setBaseUrl('')
    setTestResult(null)
    setSaved(false)
  }

  async function handleTest() {
    setTestResult(null)
    try {
      const res = await testLLMMut.mutateAsync({ llm_provider: providerId, llm_api_key: apiKey, llm_base_url: baseUrl, llm_model: model })
      setTestResult('ok')
      setTestMsg(res.response || 'Connected!')
    } catch (e) {
      setTestResult('error')
      setTestMsg(e.message)
    }
  }

  async function handleSave() {
    setSaved(false)
    try {
      await saveOrgMut.mutateAsync({ org_name: orgName, org_description: orgDesc })
      await saveLLMMut.mutateAsync({ llm_provider: providerId, llm_api_key: apiKey, llm_base_url: baseUrl, llm_model: model })
      // Refresh the Zustand store so the sidebar (which reads orgName from the
      // store) picks up the new name/description immediately.
      await fetchOrg()
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e) {
      setTestResult('error')
      setTestMsg(e.message)
    }
  }

  async function handleDeleteOrg() {
    setDeleting(true)
    try {
      const res = await fetch('/api/org/reset', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to reset')
      // Reload the app — fetchOrg will detect setupDone=false and show the wizard
      fetchOrg()
      window.location.reload()
    } catch (e) {
      setDeleting(false)
      setShowDeleteConfirm(false)
    }
  }

  const saving = saveOrgMut.isPending || saveLLMMut.isPending
  const testing = testLLMMut.isPending

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

        <hr className="border-gray-200" />

        {/* Platform heartbeat */}
        <Heartbeat orgData={orgData} />

        <hr className="border-gray-200" />

        {/* Backup & Restore */}
        <BackupRestore />

        <hr className="border-gray-200" />

        {/* Danger zone */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-red-600 uppercase tracking-wide">Danger Zone</h2>
          <div className="border border-red-200 rounded-xl p-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-gray-900">Delete Organisation</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Permanently delete all data — agents, connections, conversations, API providers, and settings.
                The app will restart from the onboarding wizard.
              </p>
            </div>

            {!showDeleteConfirm ? (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-medium transition-colors"
              >
                <Trash2 size={14} /> Delete Organisation
              </button>
            ) : (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={18} className="text-red-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-red-800">This action cannot be undone</p>
                    <p className="text-xs text-red-600 mt-1">
                      All agents, conversations, messages, API providers, and settings will be permanently deleted.
                      You will be taken back to the onboarding wizard to start fresh.
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="flex-1 border border-gray-200 rounded-xl py-2 text-sm hover:bg-gray-50 font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDeleteOrg}
                    disabled={deleting}
                    className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-xl py-2 text-sm font-medium transition-colors"
                  >
                    {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    {deleting ? 'Deleting…' : 'Yes, delete everything'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Backup & Restore ──────────────────────────────────────────────────────────
function BackupRestore() {
  const [restoring, setRestoring] = React.useState(false)
  const [msg, setMsg] = React.useState(null)   // { ok, text }
  const fileRef = React.useRef(null)

  function download() {
    // Hit the endpoint directly so the browser saves the zip.
    window.location.href = '/api/backup'
  }

  async function onFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!confirm('Restore from this backup? It will REPLACE the current agents, connections, providers/keys, and MCP servers.')) return
    setRestoring(true); setMsg(null)
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await fetch('/api/restore', { method: 'POST', body })
      if (!res.ok) throw new Error(await res.text())
      const d = await res.json()
      const n = d.imported?.agents ?? 0
      setMsg({ ok: true, text: `Restored ${n} agents, ${d.agent_files} files, and all settings. Reloading…` })
      setTimeout(() => window.location.reload(), 1500)
    } catch (err) {
      setMsg({ ok: false, text: `Restore failed: ${err.message}` })
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Backup &amp; Restore</h2>
      <div className="border border-gray-200 rounded-xl p-4 space-y-3">
        <p className="text-xs text-gray-500">
          Export your whole organisation — agents and their files (agent.md, soul.md, memory.md),
          the connections between them, API providers &amp; keys, and MCP servers — into a single zip.
          Restore it on a fresh machine to recreate everything.
        </p>
        <div className="flex flex-wrap gap-2">
          <button onClick={download}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium transition-colors">
            <Download size={14} /> Download backup (.zip)
          </button>
          <button onClick={() => fileRef.current?.click()} disabled={restoring}
            className="flex items-center gap-2 px-4 py-2 border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-xl text-sm font-medium transition-colors disabled:opacity-50">
            {restoring ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {restoring ? 'Restoring…' : 'Restore from backup'}
          </button>
          <input ref={fileRef} type="file" accept=".zip" className="hidden" onChange={onFile} />
        </div>
        {msg && (
          <p className={`text-xs ${msg.ok ? 'text-green-600' : 'text-red-600'}`}>{msg.text}</p>
        )}
        <p className="text-[11px] text-amber-600">
          ⚠️ The backup contains your API keys in plain text — store it securely. Restoring replaces existing config.
        </p>
      </div>
    </div>
  )
}

// ── Platform heartbeat ────────────────────────────────────────────────────────
function Heartbeat({ orgData }) {
  const [mins, setMins] = React.useState(5)
  const [saved, setSaved] = React.useState(false)
  const init = React.useRef(false)
  React.useEffect(() => {
    if (orgData && !init.current) {
      init.current = true
      const secs = orgData.heartbeat_interval || 300
      setMins(Math.max(1, Math.round(secs / 60)))
    }
  }, [orgData])

  async function save() {
    setSaved(false)
    await fetch('/api/settings/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: Math.max(30, mins * 60) }),
    })
    setSaved(true); setTimeout(() => setSaved(false), 2500)
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Platform Heartbeat</h2>
      <div className="border border-gray-200 rounded-xl p-4 space-y-3">
        <p className="text-xs text-gray-500">
          How often the platform checks each agent's checklist for due tasks (daily SOPs and scheduled jobs)
          and triggers them. The Manager also posts a daily update once per day.
        </p>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-700">Check every</span>
          <input type="number" min={1} step={1} value={mins}
            onChange={e => { setMins(Math.max(1, parseInt(e.target.value || '1', 10) || 1)); setSaved(false) }}
            className="w-20 border border-gray-300 rounded-xl px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-300" />
          <span className="text-sm text-gray-700">minute{mins === 1 ? '' : 's'}</span>
          <button onClick={save}
            className="ml-auto px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium">
            Save
          </button>
          {saved && <span className="text-xs text-green-600">Saved ✓</span>}
        </div>
      </div>
    </div>
  )
}
