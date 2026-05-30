import React from 'react'
import { Network } from 'lucide-react'

export default function OrganisationView() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-3">
      <Network size={40} strokeWidth={1.5} />
      <p className="text-sm font-medium">Organisation coming soon</p>
      <p className="text-xs text-gray-400 max-w-xs text-center">Add and manage agents, define roles, set reporting lines and communication rules.</p>
    </div>
  )
}
