/**
 * AgentModal — create a new agent or view agent details.
 */
import React, { useState } from 'react'
import { Pencil } from 'lucide-react'
import { useOrgStore } from '../stores/orgStore'
import { useProviders, useProviderModels, useCreateAgent } from '../hooks/useApi'
import AIPromptWizard from './AIPromptWizard'

const COLORS = ['#4F46E5', '#DC2626', '#059669', '#D97706', '#7C3AED', '#0891B2', '#DB2777']

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
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-gray-900">Add Agent</h2>

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

          {/* Provider from API providers */}
          <label className="space-y-1">
            <span className="text-xs font-medium text-gray-500">LLM Provider</span>
            {llmProviders.length > 0 ? (
              <select
                className="input"
                value={form.api_provider_id}
                onChange={e => { set('api_provider_id', e.target.value); set('llm_model', '') }}
              >
                <option value="">Select provider…</option>
                {llmProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
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

        <div className="flex gap-3 pt-2">
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

        {error && <p className="text-red-500 text-sm bg-red-50 border border-red-100 rounded-xl px-3 py-2">{error}</p>}
      </div>

      <style>{`.input { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 12px; font-size: 14px; outline: none; background: white; } .input:focus { border-color: #6366f1; }`}</style>
    </div>
  )
}
