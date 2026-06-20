import { useRef } from 'react'

/**
 * Consistent modal-backdrop dismissal for the whole app.
 *
 * A modal should close ONLY when a click both *starts* and *ends* on the
 * backdrop itself. A drag that begins inside the modal (e.g. selecting text in
 * a textarea) and releases over the backdrop must NOT close it.
 *
 * Spread the returned props onto the full-screen backdrop element:
 *   const dismiss = useBackdropDismiss(onClose)
 *   <div className="fixed inset-0 …" {...dismiss}> <Panel/> </div>
 *
 * The mousedown bubbles from inner elements to the backdrop, so a press that
 * originates inside the panel sets the flag false (target !== currentTarget)
 * and the subsequent click is ignored.
 */
export function useBackdropDismiss(onClose) {
  const downOnBackdrop = useRef(false)
  return {
    onMouseDown: (e) => { downOnBackdrop.current = e.target === e.currentTarget },
    onClick: (e) => {
      if (downOnBackdrop.current && e.target === e.currentTarget) onClose()
      downOnBackdrop.current = false
    },
  }
}
