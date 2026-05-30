import React from 'react'
import { ShoppingBag } from 'lucide-react'

export default function SkillMarketplaceView() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-3">
      <ShoppingBag size={40} strokeWidth={1.5} />
      <p className="text-sm font-medium">Skill Marketplace coming soon</p>
      <p className="text-xs text-gray-400 max-w-xs text-center">Browse and install new skills to extend what your agents can do.</p>
    </div>
  )
}
