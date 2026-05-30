import React from 'react'
import { KeyRound } from 'lucide-react'

export default function APISettingsView() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-3">
      <KeyRound size={40} strokeWidth={1.5} />
      <p className="text-sm font-medium">API Keys coming soon</p>
      <p className="text-xs text-gray-400 max-w-xs text-center">Centralised store for all API keys your agents need — add them manually or via chat.</p>
    </div>
  )
}
