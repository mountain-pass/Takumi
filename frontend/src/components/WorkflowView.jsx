import React from 'react'
import { GitBranch } from 'lucide-react'

export default function WorkflowView() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-3">
      <GitBranch size={40} strokeWidth={1.5} />
      <p className="text-sm font-medium">Workflows coming soon</p>
      <p className="text-xs text-gray-400 max-w-xs text-center">Create multi-step workflows that agents can execute on demand or via cron jobs.</p>
    </div>
  )
}
