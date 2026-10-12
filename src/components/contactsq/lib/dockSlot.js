/**
 * The page-level agent column. ContactsQView owns a right-hand slot that runs from the top of the nav to the bottom
 * of the page (owner 2026-10-10: the sidebar gets the vertical space; the nav fills the width up to it). The address
 * book portals its docked agent into the slot and reports whether it is docked; width is the whole shell, so the
 * dock decision never flips because the dock itself took space.
 */
import { createContext } from 'react'

export const DockSlotContext = createContext(null) // { slot: HTMLElement|null, width: number|null, setDocked: (bool) => void }
