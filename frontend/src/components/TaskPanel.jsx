/**
 * TaskPanel — submit tasks + view task list.
 */
import React, { useState } from 'react'
import { useOrgStore } from '../stores/orgStore'

const STATUS_STYLE = {
  pending: 'bg-gray-100 text-gray-600',
  in_progress: 'bg-amber-100 text-amber-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
}

export default function TaskPanel() {
  const tasks = useOrgStore(s => s.tasks)
  const submitTask = useOrgStore(s => s.submitTask)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    try {
      await submitTask(title.trim(), description.trim())
      setTitle('')
      setDescription('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700">Tasks</h2>
      </div>

      {/* Submit form */}
      <form onSubmit={handleSubmit} className="p-4 border-b border-gray-100 space-y-2">
        <input
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
          placeholder="Task title..."
          value={title}
          onChange={e => setTitle(e.target.value)}
        />
        <textarea
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
          placeholder="Describe what you need..."
          rows={3}
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
        <button
          type="submit"
          disabled={submitting || !title.trim()}
          className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg py-2 text-sm font-medium transition-colors"
        >
          {submitting ? 'Submitting…' : 'Submit Task'}
        </button>
      </form>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2 scrollbar-thin">
        {tasks.length === 0 && (
          <p className="text-center text-gray-300 text-sm mt-4">No tasks yet.</p>
        )}
        {tasks.slice().reverse().map(task => (
          <div key={task.id} className="bg-white rounded-xl p-3 shadow-sm border border-gray-100">
            <div className="flex items-start justify-between gap-2 mb-1">
              <span className="text-sm font-medium text-gray-800 leading-tight">{task.title}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${STATUS_STYLE[task.status] || 'bg-gray-100'}`}>
                {task.status.replace('_', ' ')}
              </span>
            </div>
            {task.description && (
              <p className="text-xs text-gray-400 mb-1 line-clamp-2">{task.description}</p>
            )}
            {task.result && (
              <p className="text-xs text-gray-600 bg-gray-50 rounded-lg p-2 mt-1 line-clamp-3">
                {task.result}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
