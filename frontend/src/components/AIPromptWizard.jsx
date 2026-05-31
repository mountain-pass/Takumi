// AIPromptWizard — render-prop component for AI system prompt generation.
// Children receive ({ trigger, actions }) to place the button and action bar.
import React, { useState } from 'react'
import { Sparkles, RotateCcw, Check, Loader2 } from 'lucide-react'

export default function AIPromptWizard({ name, role, description, currentPrompt, onAccept, onError, children }) {
  const [loading, setLoading] = useState(false)
  const [hasDraft, setHasDraft] = useState(false)
  const [original, setOriginal] = useState(null)

  function reportError(msg) { if (onError) onError(msg) }

  async function handleGenerate() {
    if (!name && !role) {
      reportError('Fill in the name and role first so the AI has context.')
      return
    }
    setLoading(true)
    reportError('')
    setOriginal(currentPrompt)

    try {
      const res = await fetch('/api/prompt-enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_name: name,
          agent_role: role,
          agent_description: description || '',
          current_prompt: currentPrompt || '',
        }),
      })
      if (!res.ok) {
        const text = await res.text()
        let msg = text
        try { msg = JSON.parse(text).detail || text } catch {}
        throw new Error(msg)
      }
      const data = await res.json()
      onAccept(data.prompt)
      setHasDraft(true)
    } catch (e) {
      reportError(e.message || 'Failed to generate prompt')
    } finally {
      setLoading(false)
    }
  }

  function handleAcceptFinal() {
    setHasDraft(false)
    setOriginal(null)
  }

  function handleRevert() {
    onAccept(original)
    setHasDraft(false)
    setOriginal(null)
  }

  function handleCancel() {
    onAccept(original)
    setHasDraft(false)
    setOriginal(null)
  }

  const trigger = !hasDraft ? (
    <button
      type="button"
      onClick={handleGenerate}
      disabled={loading}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-50 rounded-lg border border-indigo-100 transition-colors"
    >
      {loading
        ? <><Loader2 size={12} className="animate-spin" /> Generating…</>
        : <><Sparkles size={12} /> Enhance with AI</>
      }
    </button>
  ) : null

  const actions = hasDraft ? (
    <div className="flex items-center gap-2 pt-1">
      <button type="button" onClick={handleRevert}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
        <RotateCcw size={12} /> Revert
      </button>
      <button type="button" onClick={handleCancel}
        className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors">
        Cancel
      </button>
      <div className="flex-1" />
      <button type="button" onClick={handleAcceptFinal}
        className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors">
        <Check size={12} /> Accept
      </button>
    </div>
  ) : null

  if (typeof children === 'function') {
    return children({ trigger, actions })
  }

  return trigger
}
