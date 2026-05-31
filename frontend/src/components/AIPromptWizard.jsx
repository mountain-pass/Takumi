/**
 * AIPromptWizard — button + inline review UI for AI-generated system prompts.
 * Calls /api/prompt-enhance, shows the result for review, and lets the user
 * accept, edit, or revert to the original.
 */
import React, { useState } from 'react'
import { Sparkles, RotateCcw, Check, Loader2 } from 'lucide-react'

export default function AIPromptWizard({ name, role, description, currentPrompt, onAccept, onError }) {
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState(null)
  const [original, setOriginal] = useState(null)

  function reportError(msg) {
    if (onError) onError(msg)
  }

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
      setDraft(data.prompt)
    } catch (e) {
      reportError(e.message || 'Failed to generate prompt')
    } finally {
      setLoading(false)
    }
  }

  function handleAccept() {
    onAccept(draft)
    setDraft(null)
    setOriginal(null)
  }

  function handleRevert() {
    onAccept(original)
    setDraft(null)
    setOriginal(null)
  }

  function handleDismiss() {
    setDraft(null)
    setOriginal(null)
  }

  if (draft !== null) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold text-indigo-500 uppercase tracking-wide flex items-center gap-1">
            <Sparkles size={11} /> AI-generated prompt
          </span>
          <span className="text-[10px] text-gray-400">Review and edit below</span>
        </div>
        <textarea
          className="w-full border border-indigo-200 bg-indigo-50/50 rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-400 resize-none"
          rows={8}
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />
        <div className="flex gap-2">
          <button
            onClick={handleRevert}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <RotateCcw size={12} /> Revert
          </button>
          <button
            onClick={handleDismiss}
            className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
          >
            Cancel
          </button>
          <div className="flex-1" />
          <button
            onClick={handleAccept}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
          >
            <Check size={12} /> Accept
          </button>
        </div>
      </div>
    )
  }

  return (
    <button
      onClick={handleGenerate}
      disabled={loading}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-50 rounded-lg border border-indigo-100 transition-colors"
    >
      {loading
        ? <><Loader2 size={12} className="animate-spin" /> Generating…</>
        : <><Sparkles size={12} /> AI Wizard</>
      }
    </button>
  )
}
