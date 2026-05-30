/**
 * AgentModal — create a new agent or view agent details.
 */
import React, { useState } from 'react'
import { useOrgStore } from '../stores/orgStore'

const PROVIDERS = ['anthropic', 'openai', 'ollama', 'gemini', 'glm', 'minimax']

const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  ollama: 'llama3',
  gemini: 'gemini-1.5-flash',
  glm: 'glm-4-flash',
  minimax: 'abab6.5s-chat',
}

const COLORS = ['#4F46E5', '#DC2626', '#059669', '#D97706', '#7C3AED', '#0891B2', '#DB2777']

export default function AgentModal({ onClose }) {
  const createAgent = useOrgStore(s => s.createAgent)
  const [form, setForm] = useState({
    name: '',
    role: '',
    description: '',
    system_prompt: '',
    llm_provider: 'anthropic',
    llm_model: 'claude-haiku-4-5-20251001',
    avatar_color: '#4F46E5',
    max_context_messages: 20,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function handleSave() {
    if (!form.name || !form.role || !form.system_prompt) {
      setError('Name, role, and system prompt are required.')
      return
    }
    setSaving(true)
    setError('')
    try {
      await createAgent(form)
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
          <label className="space-y-1 col-span-2">
            <span className="text-xs font-medium text-gray-500">System Prompt *</span>
            <textarea
              className="input resize-none"
              rows={4}
              value={form.system_prompt}
              onChange={e => set('system_prompt', e.target.value)}
              placeholder="You are a specialist in... Your job is to..."
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-gray-500">LLM Provider</span>
            <select className="input" value={form.llm_provider} onChange={e => { set('llm_provider', e.target.value); set('llm_model', DEFAULT_MODELS[e.target.value]) }}>
              {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-gray-500">Model</span>
            <input className="input" value={form.llm_model} onChange={e => set('llm_model', e.target.value)} />
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-gray-500">Max context messages</span>
            <input className="input" type="number" min={5} max={100} value={form.max_context_messages} onChange={e => set('max_context_messages', parseInt(e.target.value))} />
          </label>

          <label className="space-y-1">
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

        {error && <p className="text-red-500 text-sm">{error}</p>}

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
      </div>

      <style>{`.input { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 12px; font-size: 14px; outline: none; } .input:focus { ring: 2px solid #6366f1; border-color: #6366f1; }`}</style>
    </div>
  )
}
