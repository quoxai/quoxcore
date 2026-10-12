/**
 * ContactsQView: governed contacts at /contacts. The nav comes FIRST, then the page:
 *   Address book (the simple default: search, list, detail, agent chat on the right)
 *   History (figures + the log trail), Compliance, Do-not-contact, Agent permissions, Settings.
 * Collector-native routes; the server is the only source of truth (only the last-open tab is remembered locally).
 * ContactsQ is core-free, so there is no licence gate (see contactsq.json tier).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import AddressBookTab from './AddressBookTab'
import HistoryTab from './HistoryTab'
import DoNotContactTab from './DoNotContactTab'
import GrantsTab from './GrantsTab'
import SettingsTab from './SettingsTab'
import ComplianceTab from './ComplianceTab'
import { ToastProvider } from './toast'
import { initialTab } from './lib/tabs'
import { DockSlotContext } from './lib/dockSlot'
import { BanIcon, BookIcon, ClockIcon, GearIcon, KeyIcon, ShieldIcon } from './icons'
import './contactsq.css'

export const TABS = [
  { key: 'book', label: 'Address book', icon: BookIcon },
  { key: 'history', label: 'History', icon: ClockIcon },
  { key: 'compliance', label: 'Compliance', icon: ShieldIcon },
  { key: 'dnc', label: 'Do-not-contact', icon: BanIcon },
  { key: 'grants', label: 'Agent permissions', icon: KeyIcon },
  { key: 'settings', label: 'Settings', icon: GearIcon },
]
const TAB_KEY = 'contactsq.tab'

function readTab(search) {
  let stored = null
  try { stored = window.localStorage.getItem(TAB_KEY) } catch { /* no storage */ }
  return initialTab({ search, stored })
}

function Content({ orgId }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab] = useState(() => readTab(searchParams.toString()))
  const [stamp, setStamp] = useState(0)
  const [pendingContact, setPendingContact] = useState(null) // a contact opened from History: handed to the address book on mount
  useEffect(() => { try { window.localStorage.setItem(TAB_KEY, tab) } catch { /* convenience only */ } }, [tab])
  const go = (key) => {
    setPendingContact(null)
    setTab(key)
    // ?tab= is rewritten so a refresh lands where the person is; leaving the address book drops the contact deep link.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (key === 'book') next.delete('tab')
      else { next.set('tab', key); next.delete('contact'); next.delete('pane') }
      return next
    }, { replace: true })
  }
  // History and the Compliance bands link to a contact: open it in the address book.
  const openContact = (id) => {
    setPendingContact(id)
    setTab('book')
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete('tab'); next.set('contact', id); next.delete('pane'); return next }, { replace: true })
  }
  // Page shell: [nav + body | agent column]. The column only exists while the address book docks the agent into it.
  const shellRef = useRef(null)
  const [shellWidth, setShellWidth] = useState(null)
  const [slot, setSlot] = useState(null)
  const [docked, setDocked] = useState(false)
  useEffect(() => {
    const el = shellRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(([entry]) => setShellWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const dockCtx = useMemo(() => ({ slot, width: shellWidth, setDocked }), [slot, shellWidth])
  return (
    <ToastProvider>
     <DockSlotContext.Provider value={dockCtx}>
      <div className="cnq-shell" data-docked={docked ? 'true' : undefined} ref={shellRef}>
      <div className="cnq-column">
      <div className="cnq-nav">
        <div className="qx-tabs qx-tabs--glass" role="tablist" aria-label="ContactsQ sections">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={`qx-tab${tab === key ? ' qx-tab--active' : ''}`} onClick={() => go(key)}><Icon />{label}</button>
          ))}
        </div>
      </div>
      <div className="cnq-body" data-tab={tab}>
        {tab === 'book' ? <AddressBookTab orgId={orgId} initialContact={pendingContact} onChanged={() => setStamp((s) => s + 1)} /> : null}
        {tab === 'history' ? <HistoryTab refreshKey={stamp} onOpenContact={openContact} /> : null}
        {tab === 'compliance' ? <ComplianceTab /> : null}
        {tab === 'dnc' ? <DoNotContactTab /> : null}
        {tab === 'grants' ? <GrantsTab /> : null}
        {tab === 'settings' ? <SettingsTab /> : null}
      </div>
      </div>
      <aside className="cnq-dockslot" ref={setSlot} aria-label="ContactsQ agent column" />
      </div>
     </DockSlotContext.Provider>
    </ToastProvider>
  )
}

export default function ContactsQView() {
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id || null
  const [epoch, setEpoch] = useState(0)
  // Remount on org switch so nothing from the old org survives into the new one.
  useEffect(() => {
    const onSwitch = () => setEpoch((e) => e + 1)
    window.addEventListener('quox-org-switch', onSwitch)
    return () => window.removeEventListener('quox-org-switch', onSwitch)
  }, [])
  return (
    <div className="qx-view cnq-view">
      <Content key={`${orgId}:${epoch}`} orgId={orgId} />
    </div>
  )
}
