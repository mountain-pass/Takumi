/**
 * AgentModal — create a new agent or view agent details.
 */
import React, { useState, useEffect, useRef } from 'react'
import { Pencil, Trophy } from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'
import { useProviders, useProviderModels, useCreateAgent } from '../hooks/useApi'
import AIPromptWizard from './AIPromptWizard'
import InterviewWizard from './InterviewWizard'
import { useBackdropDismiss } from './useBackdropDismiss'

const COLORS = ['#4F46E5', '#DC2626', '#059669', '#D97706', '#7C3AED', '#0891B2', '#DB2777']
const BROWSER_TOOLS = ['browser_navigate', 'browser_read', 'browser_click', 'browser_type', 'browser_back', 'browser_screenshot']
const RISK_TOOLS = ['assess_risk', 'scan_secrets', 'review_outbound', 'risk_register']

export default function AgentModal({ onClose }) {
  const createAgentMut = useCreateAgent()
  const navigateTo = useOrgStore(s => s.navigateTo)
  const { data: providers = [] } = useProviders()
  const llmProviders = providers.filter(p => p.type === 'llm')

  const [form, setForm] = useState({
    name: '',
    role: '',
    description: '',
    system_prompt: '',
    api_provider_id: '',
    llm_model: '',
    avatar_color: '#4F46E5',
    skills: ['web_search', 'web_fetch'],
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [mcpServers, setMcpServers] = useState([])
  const [showInterview, setShowInterview] = useState(false)
  const backdropDismiss = useBackdropDismiss(onClose)

  // Wizard recommended a model — set it (+ the OpenRouter provider) on the form.
  async function applyInterviewPick(modelId) {
    try {
      const providers = await fetch('/api/providers').then(r => r.json())
      const or = providers.find(p => (p.provider || '').toLowerCase() === 'openrouter' && p.type === 'llm')
      if (or) {
        set('api_provider_id', or.id)
        set('llm_provider', 'openrouter')
      }
      set('llm_model', modelId)
    } catch {}
    setShowInterview(false)
  }

  useEffect(() => {
    fetch('/api/mcp/servers')
      .then(r => r.ok ? r.json() : [])
      .then(setMcpServers)
      .catch(() => {})
  }, [])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const selectedProvider = llmProviders.find(p => p.id === form.api_provider_id)
  const { data: modelsData } = useProviderModels(selectedProvider?.id)
  const models = modelsData?.models || []

  async function handleSave() {
    if (!form.name || !form.role || !form.system_prompt) {
      setError('Name, role, and system prompt are required.')
      return
    }
    setSaving(true)
    setError('')
    try {
      await createAgentMut.mutateAsync(form)
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      {...backdropDismiss}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col"
      >
        <h2 className="text-lg font-bold text-gray-900 px-6 pt-6 pb-4 border-b border-gray-100 shrink-0">Add Agent</h2>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 col-span-2">
            <span className="text-xs font-medium text-gray-500">Name *</span>
            <input className="input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Data Analyst" />
          </label>
          <label className="space-y-1 col-span-2">
            <span className="text-xs font-medium text-gray-500">Role *</span>
            <input className="input" value={form.role} onChange={e => set('role', e.target.value)} placeholder="e.g. Senior Data Analyst" />
          </label>
          <label className="space-y-1 col-span-2">
            <span className="text-xs font-medium text-gray-500">Description</span>
            <input className="input" value={form.description} onChange={e => set('description', e.target.value)} placeholder="What this agent specialises in" />
          </label>
          <div className="space-y-1 col-span-2">
            <AIPromptWizard
              name={form.name}
              role={form.role}
              description={form.description}
              currentPrompt={form.system_prompt}
              onAccept={prompt => set('system_prompt', prompt)}
              onError={setError}
            >
              {({ trigger, actions }) => (
                <>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-gray-500">System Prompt *</span>
                    {trigger}
                  </div>
                  <textarea
                    className="input resize-y min-h-[100px]"
                    rows={4}
                    value={form.system_prompt}
                    onChange={e => set('system_prompt', e.target.value)}
                    placeholder="You are a specialist in... Your job is to..."
                  />
                  {actions}
                </>
              )}
            </AIPromptWizard>
          </div>

          {/* Not sure which model? Interview candidates */}
          <button
            type="button"
            onClick={() => setShowInterview(true)}
            className="group col-span-2 w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl border border-indigo-200 bg-indigo-50/60 hover:bg-indigo-50 hover:border-indigo-300 transition-colors text-left"
          >
            <span className="shrink-0 w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center">
              <Trophy size={15} className="text-indigo-600" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold text-indigo-700">Not sure which model?</span>
              <span className="block text-xs text-indigo-600/80">Let the Manager interview candidates and recommend the best fit.</span>
            </span>
            <span className="shrink-0 text-indigo-400 group-hover:text-indigo-600 group-hover:translate-x-0.5 transition-all">→</span>
          </button>

          {/* Provider from API providers */}
          <label className="space-y-1">
            <span className="text-xs font-medium text-gray-500">LLM Provider</span>
            {llmProviders.length > 0 ? (
              <select
                className="input"
                value={form.api_provider_id}
                onChange={e => {
                  const pid = e.target.value
                  const prov = llmProviders.find(p => p.id === pid)
                  set('api_provider_id', pid)
                  set('llm_model', '')
                  if (prov) set('llm_provider', prov.provider)
                }}
              >
                <option value="">Select provider…</option>
                {llmProviders.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.provider ? p.provider.charAt(0).toUpperCase() + p.provider.slice(1) : 'Unknown'})
                  </option>
                ))}
              </select>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 flex-1">No providers configured</span>
                <button
                  type="button"
                  onClick={() => { onClose(); navigateTo('api') }}
                  className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg border border-indigo-200"
                >
                  <Pencil size={11} /> Add
                </button>
              </div>
            )}
          </label>

          {/* Model from provider's model list */}
          <label className="space-y-1">
            <span className="text-xs font-medium text-gray-500">Model</span>
            {models.length > 0 ? (
              <select
                className="input"
                value={form.llm_model}
                onChange={e => set('llm_model', e.target.value)}
              >
                <option value="">Select model…</option>
                {models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input className="input" value={form.llm_model} onChange={e => set('llm_model', e.target.value)} placeholder="Enter model name" />
            )}
          </label>

          {/* Skills */}
          <div className="space-y-1 col-span-2">
            <span className="text-xs font-medium text-gray-500">Skills</span>
            <div className="flex flex-wrap gap-3 pt-1">
              {[
                { id: 'web_search', label: 'Web Search', desc: 'Search the internet' },
                { id: 'web_fetch', label: 'Web Fetch', desc: 'Read web pages' },
                { id: 'read_file', label: 'Read File', desc: 'Read local files' },
                { id: 'write_file', label: 'Write File', desc: 'Create/edit files' },
                { id: 'list_files', label: 'List Files', desc: 'Browse directories' },
                { id: 'run_shell', label: 'Run Shell', desc: 'Execute commands' },
                { id: 'create_artifact', label: 'Create Artifact', desc: 'Rich HTML output' },
              ].map(skill => (
                <label key={skill.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.skills.includes(skill.id)}
                    onChange={e => {
                      if (e.target.checked) {
                        set('skills', [...form.skills, skill.id])
                      } else {
                        set('skills', form.skills.filter(s => s !== skill.id))
                      }
                    }}
                    className="w-3.5 h-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-xs text-gray-700">{skill.label}</span>
                  <span className="text-[10px] text-gray-400">— {skill.desc}</span>
                </label>
              ))}
              {/* Browser control — one toggle enables the whole tool group */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={BROWSER_TOOLS.every(t => form.skills.includes(t))}
                  onChange={e => {
                    const rest = form.skills.filter(s => !BROWSER_TOOLS.includes(s))
                    set('skills', e.target.checked ? [...rest, ...BROWSER_TOOLS] : rest)
                  }}
                  className="w-3.5 h-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-xs text-gray-700">Browser</span>
                <span className="text-[10px] text-gray-400">— control desktop Chrome</span>
              </label>
              {/* Risk & Compliance — one toggle enables the risk-scorer tools */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={RISK_TOOLS.every(t => form.skills.includes(t))}
                  onChange={e => {
                    const rest = form.skills.filter(s => !RISK_TOOLS.includes(s))
                    set('skills', e.target.checked ? [...rest, ...RISK_TOOLS] : rest)
                  }}
                  className="w-3.5 h-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-xs text-gray-700">Risk &amp; Compliance</span>
                <span className="text-[10px] text-gray-400">— ISO 31000 risk scoring</span>
              </label>
            </div>
          </div>

          {/* MCP servers (per-server access) */}
          {mcpServers.length > 0 && (
            <div className="space-y-1 col-span-2">
              <span className="text-xs font-medium text-gray-500">MCP Tools</span>
              <div className="flex flex-wrap gap-3 pt-1">
                {mcpServers.map(srv => {
                  const token = `mcp:${srv.id}`
                  const toolCount = (srv.tools || []).length
                  return (
                    <label key={srv.id} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.skills.includes(token)}
                        onChange={e => {
                          if (e.target.checked) set('skills', [...form.skills, token])
                          else set('skills', form.skills.filter(s => s !== token))
                        }}
                        className="w-3.5 h-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="text-xs text-gray-700">{srv.name}</span>
                      <span className="text-[10px] text-gray-400">
                        — {srv.status === 'connected' ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : srv.status}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          <label className="space-y-1 col-span-2">
            <span className="text-xs font-medium text-gray-500">Colour</span>
            <div className="flex gap-2 flex-wrap pt-1">
              {COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set('avatar_color', c)}
                  className="w-6 h-6 rounded-full border-2 transition-all"
                  style={{ backgroundColor: c, borderColor: form.avatar_color === c ? '#111' : 'transparent' }}
                />
              ))}
            </div>
          </label>
        </div>

          {error && <p className="text-red-500 text-sm bg-red-50 border border-red-100 rounded-xl px-3 py-2">{error}</p>}
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-gray-100 shrink-0">
          <button onClick={onClose} className="flex-1 border border-gray-200 rounded-xl py-2 text-sm hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl py-2 text-sm font-medium"
          >
            {saving ? 'Adding…' : 'Add Agent'}
          </button>
        </div>
      </div>

      {showInterview && (
        <InterviewWizard
          agentForm={form}
          onPick={applyInterviewPick}
          onClose={() => setShowInterview(false)}
        />
      )}
    </div>
  )
}
