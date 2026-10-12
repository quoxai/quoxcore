/**
 * ProxmoxContextMenu — Right-click floating menu for VM/CT actions.
 *
 * Positioned at mouse cursor, shows contextual actions for the VM/CT.
 * Closes on click-outside, Escape, or scroll.
 */

import { useEffect, useRef } from 'react'
import { buildVMActions } from './vmActions'
import './proxmox-context-menu.css'

export function ProxmoxContextMenu({ vm, position, onAction, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    function handleEscape(e) {
      if (e.key === 'Escape') onClose()
    }
    function handleScroll() {
      onClose()
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    document.addEventListener('scroll', handleScroll, true)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
      document.removeEventListener('scroll', handleScroll, true)
    }
  }, [onClose])

  if (!vm || !position) return null

  const actions = buildVMActions(vm)

  // Position the menu, clamping to viewport
  const style = {
    position: 'fixed',
    left: Math.min(position.x, window.innerWidth - 200),
    top: Math.min(position.y, window.innerHeight - (actions.length * 36 + 48)),
    zIndex: 9999,
  }

  return (
    <div className="pxm" style={style} ref={ref}>
      <div className="pxm-header">
        <span className="pxm-header__name">{vm.name || `${vm.type === 'lxc' ? 'CT' : 'VM'} ${vm.vmid}`}</span>
        <span className="pxm-header__node">{vm.node}</span>
      </div>
      <div className="pxm-divider" />
      {actions.map(action => (
        <button
          key={action.id}
          className={`pxm-item ${action.danger ? 'pxm-item--danger' : ''}`}
          onClick={() => { onAction(action); onClose() }}
        >
          <span className="pxm-item__icon">{action.icon}</span>
          <span className="pxm-item__label">{action.label}</span>
        </button>
      ))}
    </div>
  )
}

export default ProxmoxContextMenu
