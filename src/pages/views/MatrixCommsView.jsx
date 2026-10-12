/**
 * MATRIX-P4 — MatrixCommsView ("Rooms")
 *
 * Quox's comms surface: a Spaces-style room list (left, grouped into Agent
 * rooms / Team channels / DMs / a pending Invitations group) + a selected
 * room timeline with clear sender identity + witnessed affordance (center)
 * + composer. Header shows the room name, a "witnessed" evidence pill,
 * joined-member chips (agents accented), and the invite-agent control.
 *
 * Backed by matrixClient.js (matrix-js-sdk, in-memory access token only —
 * see hard rule in that file). Reuses existing global glass utility classes
 * (qx-view/qx-card/qx-row/qx-pill/qx-chip/qx-tip/glass-btn/glass-input) —
 * no new CSS file, per house style.
 *
 * BUG FIX (M-P4): the joined-rooms filter previously used a strict
 * `getMyMembership() === 'join'` equality check. Any room whose membership
 * read as anything other than the literal string 'join' at the moment of a
 * given refreshRooms() call (e.g. a transient/undefined value while a
 * membership state event is still being processed by the SDK) was silently
 * dropped from the list forever until the next refresh recomputed it —
 * producing the reported "room list renders blank while getRooms() clearly
 * has entries" symptom. The filter now excludes only the states that should
 * genuinely never show in the main list (pending invite — shown separately
 * — left, banned) and treats everything else as visible.
 *
 * MATRIX-P5 — UI/UX pass: an IRC-style right "People" panel (Agents /
 * People rosters with avatars, role/network sub-labels, presence dots),
 * consecutive-sender message grouping, and a SCOPED Matrix-movie phosphor
 * green theme (see `matrix-comms-theme.css` + the `matrix-comms-theme`
 * class on the view root) applied only to this surface.
 */

import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { getMatrixClient, resolveDisplayName, resolveAvatar, isAuthedMatrixMediaUrl, resolveAuthedMediaBlobUrl, buildAuthedMediaDownloadUrl } from '../../services/matrixClient'
import { listAssistants } from '../../services/entityRegistry'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { useAuth } from '../../contexts/AuthContext'
import { listTeams, provisionTeamRoom } from '../../services/teamService'
import Modal from '../../components/ui/Modal'
import './matrix-comms-theme.css'

// Agents live on the homeserver as `@_quoxagent_<id>:quox` (appservice-managed).
const AGENT_USER_PREFIX = '@_quoxagent_'
const AGENT_USER_DOMAIN = ':quox'

function isAgentUserId(userId) {
  return typeof userId === 'string' && userId.startsWith(AGENT_USER_PREFIX)
}

// QUOXCHAT-PRO P2: incoming website chats land as Matrix rooms whose
// ai.quox.room node_type is 'quoxchat' (backend contract, sibling stream).
// The website visitor is puppeted as '@_quoxagent_qc_<id>:quox'. NOTE: that
// localpart sits INSIDE the '_quoxagent_' namespace, so isAgentUserId()
// matches visitors too. Every agent-specific affordance (green accent, role
// pill, witnessed shield, thinking indicator) must check this first.
const VISITOR_USER_PREFIX = `${AGENT_USER_PREFIX}qc_`

function isVisitorUserId(userId) {
  return typeof userId === 'string' && userId.startsWith(VISITOR_USER_PREFIX)
}

// Room memberships that should never appear in the main (joined) list —
// pending invites get their own section above it; left/banned rooms are
// stale. Everything else (join, knock, or any value the SDK hasn't fully
// settled yet) is treated as visible. See BUG FIX note in the file header.
const HIDDEN_FROM_MAIN_LIST = new Set(['invite', 'leave', 'ban'])

// ── Inline SVG icons (house style: every button gets one) ──────────────────

const SendIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
)

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
  </svg>
)

const RoomIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'rgba(255,255,255,0.5)' }}>
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
  </svg>
)

const MediaIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'rgba(255,255,255,0.6)' }}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </svg>
)

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

const PaperclipIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
  </svg>
)

const CheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

const XIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

const UserPlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
    <circle cx="8.5" cy="7" r="4" />
    <line x1="20" y1="8" x2="20" y2="14" />
    <line x1="17" y1="11" x2="23" y2="11" />
  </svg>
)

const MailIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <path d="M22 6l-10 7L2 6" />
    <rect x="2" y="4" width="20" height="16" rx="2" />
  </svg>
)

// Agent messages / agent rooms — a small circuit/core glyph.
const AgentGlyphIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
  </svg>
)

// Team channels — multiple people.
const TeamGlyphIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'rgba(255,255,255,0.55)' }}>
    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 00-3-3.87" />
    <path d="M16 3.13a4 4 0 010 7.75" />
  </svg>
)

// DMs — a single person.
const DMGlyphIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'rgba(255,255,255,0.55)' }}>
    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
)

// Bridged-network badges: recognizable monochrome brand marks (owner ask),
// tinted via currentColor so each surface (tab, pill, badge) sets the color.
// Telegram: the paper-plane-in-circle mark.
const TelegramGlyphIcon = ({ size = 11 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="0" style={{ fill: 'currentColor' }} aria-hidden="true">
    <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm4.9 6.88l-1.62 7.68c-.12.56-.44.7-.9.44l-2.48-1.84-1.2 1.16c-.13.14-.24.25-.5.25l.18-2.54 4.62-4.2c.2-.18-.04-.28-.31-.1l-5.71 3.62-2.46-.77c-.53-.17-.54-.54.11-.8l9.6-3.72c.45-.16.84.11.67.82z" />
  </svg>
)

// Slack: the four-lozenge lattice mark.
const SlackGlyphIcon = ({ size = 11 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="0" style={{ fill: 'currentColor' }} aria-hidden="true">
    <path d="M5.1 15.16a2.05 2.05 0 11-2.05-2.05H5.1v2.05zm1.03 0a2.05 2.05 0 114.1 0v5.14a2.05 2.05 0 11-4.1 0v-5.14zM8.18 5.1a2.05 2.05 0 112.05-2.05V5.1H8.18zm0 1.03a2.05 2.05 0 110 4.1H3.05a2.05 2.05 0 110-4.1h5.13zM18.9 8.84a2.05 2.05 0 112.05 2.05H18.9V8.84zm-1.03 0a2.05 2.05 0 11-4.1 0V3.7a2.05 2.05 0 114.1 0v5.14zM15.82 18.9a2.05 2.05 0 11-2.05 2.05V18.9h2.05zm0-1.03a2.05 2.05 0 110-4.1h5.13a2.05 2.05 0 110 4.1h-5.13z" />
  </svg>
)

// Discord: the face mark, for bridged discord puppets if they appear.
const DiscordGlyphIcon = ({ size = 11 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="0" style={{ fill: 'currentColor' }} aria-hidden="true">
    <path d="M20.3 4.4A19.8 19.8 0 0015.9 3l-.2.4c1.6.4 2.5 1 3.3 1.7A13.4 13.4 0 0012 3.9c-1.5 0-3.4.3-5 1.2.8-.7 1.7-1.3 3.2-1.7L10 3a19.7 19.7 0 00-4.4 1.4C2.8 8.5 2 12.5 2.4 16.4c1.8 1.3 3.5 2.1 5.2 2.6l.9-1.4c-.9-.3-1.7-.8-2.5-1.4l.6-.5c1.5.7 3.2 1.1 5.4 1.1s3.9-.4 5.4-1.1l.6.5c-.8.6-1.6 1.1-2.5 1.4l.9 1.4c1.7-.5 3.4-1.3 5.2-2.6.5-4.5-.7-8.4-3.3-12zM9.7 14.2c-.8 0-1.5-.8-1.5-1.7 0-1 .7-1.7 1.5-1.7s1.5.8 1.5 1.7c0 1-.7 1.7-1.5 1.7zm4.6 0c-.8 0-1.5-.8-1.5-1.7 0-1 .7-1.7 1.5-1.7s1.5.8 1.5 1.7c0 1-.7 1.7-1.5 1.7z" />
  </svg>
)

// The witnessed-evidence affordance — a shield with a checkmark.
const ShieldCheckIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <polyline points="9 12 11 14 15 10" />
  </svg>
)

// People-panel collapse toggle chevron.
const ChevronIcon = ({ direction = 'right' }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor', transform: direction === 'left' ? 'rotate(180deg)' : undefined }}>
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

// Add-reaction affordance (hover-revealed on a message row) + the emoji
// picker popover it opens (MATRIX-P5b).
const SmileyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <circle cx="12" cy="12" r="10" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
    <line x1="9" y1="9" x2="9.01" y2="9" />
    <line x1="15" y1="9" x2="15.01" y2="9" />
  </svg>
)

// Scroll-to-bottom affordance (MATRIX-P5c).
const ArrowDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <polyline points="19 12 12 19 5 12" />
  </svg>
)

// Small download glyph for media thumbnails, video overlays, file chips
// and the lightbox (ROOMS-MEDIA thumbnails pass).
const DownloadIcon = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <line x1="12" y1="4" x2="12" y2="15" />
    <polyline points="6 10 12 16 18 10" />
    <line x1="5" y1="20" x2="19" y2="20" />
  </svg>
)

// Expand-to-lightbox glyph (video overlay button).
const ExpandIcon = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <polyline points="15 4 20 4 20 9" />
    <polyline points="9 20 4 20 4 15" />
    <line x1="20" y1="4" x2="14" y2="10" />
    <line x1="4" y1="20" x2="10" y2="14" />
  </svg>
)

// Favourite star (ROOMS-FAV): outline normally, amber-filled when the room
// is tagged m.favourite. Colour comes from currentColor so the active state
// is set by the .mc-*--active classes in matrix-comms-theme.css.
const StarIcon = ({ filled = false }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
)

// Kebab (three-dot) trigger for the row context menu.
const KebabIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" strokeWidth="0">
    <circle cx="12" cy="5" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="19" r="1.7" />
  </svg>
)

// Context-menu item glyphs: view profile, agent settings, start chat.
const ProfileIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
)

const GearIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33 1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82 1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
  </svg>
)

const ChatBubbleIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
  </svg>
)

// Header wordmark mark (owner ask, item: header branding): a small rooms
// glyph in the phosphor green, leading "Quox MATRIX Rooms".
const RoomsMarkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"
    style={{ stroke: 'var(--matrix-green, #39ff6a)', opacity: 0.9, flexShrink: 0 }} aria-hidden="true">
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    <line x1="8" y1="9" x2="16" y2="9" />
    <line x1="8" y1="13" x2="13" y2="13" />
  </svg>
)

// Context-menu glyphs for the room-row actions and the person info flyout.
const InfoIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
)

const TagIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
    <line x1="7" y1="7" x2="7.01" y2="7" />
  </svg>
)

const TrashIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </svg>
)

const EraserIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <path d="M20 20H7l-4-4a1.5 1.5 0 010-2.1L13.6 3.3a1.5 1.5 0 012.1 0l5 5a1.5 1.5 0 010 2.1L12 19" />
    <line x1="9" y1="8.5" x2="15.5" y2="15" />
  </svg>
)

// QuoxChat website-visitor rooms (QUOXCHAT-PRO P2): a chat bubble with
// typing dots. Colour comes from currentColor so callers tint it (teal via
// .mc-bridge--quoxchat / .mc-quoxchat-room-glyph in matrix-comms-theme.css).
const QuoxChatGlyphIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    <line x1="8" y1="10" x2="8.01" y2="10" />
    <line x1="12" y1="10" x2="12.01" y2="10" />
    <line x1="16" y1="10" x2="16.01" y2="10" />
  </svg>
)

// Bigger, faint-green empty-state glyphs (MATRIX-P5c) — deliberately larger
// and lower-contrast than the inline icons above; only used in the two
// "nothing here yet" panels.
const EmptyRoomIcon = () => (
  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'var(--matrix-green, #39ff6a)', opacity: 0.55 }}>
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
  </svg>
)

const EmptyMessagesIcon = () => (
  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'var(--matrix-green, #39ff6a)', opacity: 0.55 }}>
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    <line x1="8" y1="9" x2="16" y2="9" />
    <line x1="8" y1="13" x2="13" y2="13" />
  </svg>
)

// ── Helpers ──────────────────────────────────────────────────────────────

function formatTimestamp(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ── Timeline timestamps (MATRIX-P5c) ────────────────────────────────────────
//
// Compact per-message-group time (Slack/Discord/iMessage pattern): "now" /
// "Xm" for anything in the last hour, otherwise a plain clock time (same
// day) or short date (older). `referenceNow` is threaded through from a
// component-level ticking clock so "2m" advances to "3m" without needing a
// re-fetch — it's a pure UI clock, not a data refresh.
function formatCompactTime(ts, referenceNow) {
  if (!ts) return ''
  const now = referenceNow || Date.now()
  const diffMs = now - ts
  if (diffMs < 45 * 1000) return 'now'
  if (diffMs < 60 * 60 * 1000) return `${Math.max(1, Math.round(diffMs / 60000))}m`
  const d = new Date(ts)
  const nowDate = new Date(now)
  const sameDay = d.toDateString() === nowDate.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// Full absolute datetime for the hover tooltip/title on a compact timestamp.
function formatAbsoluteTooltip(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleString([], {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// Calendar-day key for grouping day separators — local time, not UTC, so
// "today"/"yesterday" match the viewer's own day boundary.
function dayKeyFor(ts) {
  return new Date(ts).toDateString()
}

// Day-separator pill label: "Today" / "Yesterday" / "20 July 2026".
function formatDaySeparatorLabel(ts) {
  const d = new Date(ts)
  const now = new Date()
  const startOfDay = (date) => {
    const c = new Date(date)
    c.setHours(0, 0, 0, 0)
    return c.getTime()
  }
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })
}

// Last message preview for the room row (ROOMS-GREEN, mockup parity): a
// short sender name ("You" for the local user, first word of the resolved
// display name otherwise), the truncated body, and the timestamp so the
// row can show "WARDEN: 0 anomalies overnight" + a relative time.
function lastActivityPreview(room, client, selfUserId) {
  const events = room.getLiveTimeline?.()?.getEvents() || []
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.getType() !== 'm.room.message') continue
    const content = ev.getContent()
    const raw = content.body ? String(content.body) : (content.msgtype ? `${content.msgtype.replace('m.', '')} attachment` : '')
    const text = raw.length > 44 ? `${raw.slice(0, 44)}…` : raw
    const senderId = ev.getSender()
    const sender = senderId === selfUserId
      ? 'You'
      : (resolveDisplayName(senderId, { member: ev.sender, client }) || '').split(/\s+/)[0] || ''
    return { text, ts: ev.getTs(), sender }
  }
  return { text: '', ts: 0, sender: '' }
}

// Sender of the LAST m.room.message in a room (QUOXCHAT-PRO P2 waiting
// detection). A quoxchat room whose last message came from the visitor
// puppet is "waiting" even when read receipts say read: the customer spoke
// last and nobody has replied yet.
function lastMessageSender(room) {
  const events = room?.getLiveTimeline?.()?.getEvents() || []
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].getType() === 'm.room.message') return events[i].getSender()
  }
  return null
}

// Detect a bridged network from the room's joined members' MXID namespace.
// Matrix-native rooms (agents-only or plain Quox users) return null — the
// badge is only shown when the room is actually bridged (per spec §6).
function detectBridgeNetwork(room, selfUserId) {
  const members = room.getJoinedMembers?.() || []
  for (const member of members) {
    if (member.userId === selfUserId) continue
    if (member.userId.startsWith('@telegram_')) {
      return { key: 'telegram', label: 'Telegram', icon: <TelegramGlyphIcon />, color: '#38bdf8', borderColor: 'rgba(56,189,248,0.35)' }
    }
    if (member.userId.startsWith('@slack_')) {
      return { key: 'slack', label: 'Slack', icon: <SlackGlyphIcon />, color: '#c084fc', borderColor: 'rgba(168,85,247,0.35)' }
    }
    if (member.userId.startsWith('@discord_')) {
      return { key: 'discord', label: 'Discord', icon: <DiscordGlyphIcon />, color: '#818cf8', borderColor: 'rgba(129,140,248,0.35)' }
    }
  }
  return null
}

// Bridge-tab overlay bucket (owner ask): classify a room as Telegram- or
// Slack-bridged for the room-type tab bar, keying on the SAME
// member-namespace signal detectBridgeNetwork() above uses (a joined member
// whose MXID starts with the bridge puppet prefix '@telegram_' or
// '@slack_'). Overlay semantics like favourites: a bridged room shows in
// its bridge tab AND keeps its normal roomTypeBucket() grouping in 'all'.
function roomBridgeTab(room, selfUserId) {
  return detectBridgeNetwork(room, selfUserId)?.key || null
}

// Classify a joined room for the grouped sidebar: an agent DM (you + one
// agent), a DM (you + one human), or a team channel (3+ participants, or a
// mixed agent+human group).
function classifyRoomType(room, selfUserId) {
  const others = (room.getJoinedMembers?.() || []).filter((m) => m.userId !== selfUserId)
  if (others.length <= 1) {
    return others.some((m) => isAgentUserId(m.userId)) ? 'agents' : 'dms'
  }
  return 'teams'
}

// Room title for display (room list row + header). A 1:1 room's `room.name`
// is computed by matrix-js-sdk from the OTHER member's raw displayname —
// which is exactly the "_quoxagent_sentinel" / "human.<ulid>" raw-id problem
// this fix targets. For 1:1 rooms (agent DM or human DM) resolve the other
// member's identity through the same resolver used everywhere else; group
// rooms (3+ participants) keep their real, user-chosen room name as-is.
function roomDisplayTitle(room, selfUserId, client) {
  if (!room) return ''
  // Provisioned structural rooms (org/division/department/team/agentic_team/commanderq)
  // carry an ai.quox.room state event and a real m.room.name (the breadcrumb, e.g.
  // "QUOX DEVELOPMENT > Creative > Imagery"). They are 2-member (you + one agent) but are
  // NOT DMs, so the matrix-js-sdk 1:1 heuristic below would wrongly show the agent puppet's
  // raw ULID id. Always use the room's own name for these.
  const quoxRoom = room.currentState?.getStateEvents?.('ai.quox.room', '')
  if (quoxRoom) {
    const nm = room.currentState?.getStateEvents?.('m.room.name', '')?.getContent?.()?.name
    if (nm) return nm
  }
  const others = (room.getJoinedMembers?.() || []).filter((m) => m.userId !== selfUserId)
  if (others.length === 1) {
    return resolveDisplayName(others[0].userId, { member: others[0], client })
  }
  return room.name || room.roomId
}

// Sender badge shown inline in the timeline (agent accent / bridge origin).
// Bridged origins render as the small colored source pill (ROOMS-GREEN,
// mockup mcx-bridge parity): telegram blue, slack purple, styled by the
// scoped .mc-bridge--* classes in matrix-comms-theme.css.
function senderBadge(userId) {
  // Visitor puppets FIRST: their localpart also matches the agent prefix
  // (see VISITOR_USER_PREFIX note above), but they are customers, not
  // agents. They render with their native displayname + a teal pill.
  if (isVisitorUserId(userId)) {
    return { type: 'quoxchat', label: 'Website visitor', icon: <QuoxChatGlyphIcon size={11} />, className: 'mc-bridge mc-bridge--quoxchat' }
  }
  if (isAgentUserId(userId)) {
    return { type: 'agent', label: 'Agent', icon: <AgentGlyphIcon />, className: 'qx-pill--info' }
  }
  if (userId?.startsWith('@telegram_')) {
    return { type: 'telegram', label: 'Telegram', icon: <TelegramGlyphIcon />, className: 'mc-bridge mc-bridge--telegram' }
  }
  if (userId?.startsWith('@slack_')) {
    return { type: 'slack', label: 'Slack', icon: <SlackGlyphIcon />, className: 'mc-bridge mc-bridge--slack' }
  }
  if (userId?.startsWith('@discord_')) {
    return { type: 'discord', label: 'Discord', icon: <DiscordGlyphIcon />, className: 'mc-bridge mc-bridge--discord' }
  }
  return null
}

// ── HITL proposal + system-line detection (ROOMS-GREEN) ────────────────────
//
// The appservice's hitlProposal.js posts a governed-action approval request
// into the room as the REQUESTING AGENT, as a plain m.room.message whose
// body has the exact shape:
//   "⚠️ LABEL requests approval to run `tool_name`. React 👍 to approve,
//    👎 to reject."
// and hitlReaction.js resolves the human's 👍/👎 m.reaction annotation on
// that SAME event id (approve = 👍, decline = 👎), then posts a receipt
// message as the agent: "✅ Approved and witnessed" or "🚫 Declined and
// witnessed". There is no dedicated content key or formatted_body marker,
// so detection keys on (a) an agent-puppet sender AND (b) that body marker.
const HITL_PROPOSAL_RE = /^⚠️?\s*(.+?)\s+requests approval to run\s+`([^`]+)`/u
const HITL_RECEIPT_RE = /^(✅ Approved and witnessed|🚫 Declined and witnessed)/u

function parseHitlProposal(senderId, content) {
  if (!isAgentUserId(senderId)) return null
  const body = content?.body
  if (typeof body !== 'string') return null
  const m = body.match(HITL_PROPOSAL_RE)
  if (!m) return null
  return { requester: m[1], tool: m[2] }
}

// Reaction keys arrive with client-dependent emoji encodings (variation
// selector U+FE0F, ZWJ): the same normalization the appservice's
// hitlReaction.js applies before matching 👍/👎.
function normalizeEmojiKey(key) {
  return typeof key === 'string' ? key.replace(/[\uFE00-\uFE0F\u200D]/g, '') : ''
}

// System-line text for a timeline event that should render as the mockup's
// centered dim sysline (mcx-sysline pattern) instead of a message row:
// membership changes, room create/rename, and the HITL resolution receipts
// the appservice posts after a proposal's reaction resolves. Returns null
// for everything that should stay a normal message.
function syslineForEvent(ev, client) {
  const type = ev.getType()
  if (type === 'm.room.message') {
    if (!isAgentUserId(ev.getSender())) return null
    const body = ev.getContent()?.body || ''
    return HITL_RECEIPT_RE.test(body) ? body : null
  }
  if (type === 'm.room.member') {
    const content = ev.getContent() || {}
    const prev = ev.getPrevContent?.() || {}
    // Same-membership member events are profile updates (displayname or
    // avatar changes); those stay silent.
    if (content.membership === prev.membership) return null
    const targetId = ev.getStateKey?.()
    const senderId = ev.getSender()
    const targetName = resolveDisplayName(targetId, { client })
    const senderName = resolveDisplayName(senderId, { client })
    if (content.membership === 'join') return `${targetName} joined`
    if (content.membership === 'invite') return `${senderName} invited ${targetName}`
    if (content.membership === 'leave') {
      return senderId === targetId ? `${targetName} left` : `${senderName} removed ${targetName}`
    }
    if (content.membership === 'ban') return `${senderName} banned ${targetName}`
    return null
  }
  if (type === 'm.room.create') return 'Room created'
  if (type === 'm.room.name') {
    const name = ev.getContent()?.name
    return name ? `Room renamed to ${name}` : null
  }
  return null
}

// Sidebar sections in the "All" view, keyed by roomTypeBucket() so the
// grouping matches the tab taxonomy exactly. Previously everything collapsed
// into a single "Agent rooms" section because every provisioned room is
// 2-member (you + one agent puppet); grouping by ai.quox.room node_type keeps
// org/division/department rooms out of the agent bucket.
// No 'team' group: scope rooms (org/division/department) cover human teams,
// and the lingering standalone team rooms were retired server-side (owner
// ask). A node_type 'team' room that still appears groups under its org
// section instead (see roomTypeBucket below). Bridged rooms get proper
// branded Telegram / Slack groups instead of collapsing into "Other".
const ROOM_GROUP_META = {
  org: { label: 'Organisation', icon: <TeamGlyphIcon /> },
  division: { label: 'Divisions', icon: <TeamGlyphIcon /> },
  department: { label: 'Departments', icon: <TeamGlyphIcon /> },
  agentic_team: { label: 'Agentic Teams', icon: <AgentGlyphIcon /> },
  dev_slot: { label: 'Dev Slots', icon: <TagIcon /> },
  agents: { label: 'Agents', icon: <AgentGlyphIcon /> },
  assistants: { label: 'Assistants', icon: <AgentGlyphIcon /> },
  quoxchat: { label: 'QuoxChat', icon: <QuoxChatGlyphIcon /> },
  telegram: { label: 'Telegram', icon: <span style={{ color: '#38bdf8', display: 'inline-flex' }}><TelegramGlyphIcon /></span> },
  slack: { label: 'Slack', icon: <span style={{ color: '#c084fc', display: 'inline-flex' }}><SlackGlyphIcon /></span> },
  direct: { label: 'Direct', icon: <DMGlyphIcon /> },
  other: { label: 'Other', icon: <DMGlyphIcon /> },
}
const ROOM_GROUP_ORDER = ['org', 'division', 'department', 'agentic_team', 'dev_slot', 'agents', 'assistants', 'quoxchat', 'telegram', 'slack', 'direct', 'other']

// ── Room-type tab bar (CORECOMM-UX #190) ────────────────────────────────────
//
// Provisioned rooms carry their position in the org tree via an
// `ai.quox.room` state event (content.node_type: org/division/department/
// team/agentic_team/commanderq), written at provisioning time. This tab bar
// lets the sidebar filter the joined-room list by that node_type (plus a
// core-agent-vs-custom-assistant split for anything else with a
// `default_agent`, and a plain 1:1 fallback), on top of the existing
// agents/teams/dms sub-grouping below (roomGroups), it does not replace it.
//
// 'public' is a placeholder tab (rooms open to anyone in the org, not yet
// built), always shown, disabled/greyed with a "SOON" badge.
const ROOM_TABS = [
  { id: 'all', label: 'All' },
  // Favourites (ROOMS-FAV): rooms the user starred. Persistence is the
  // Matrix-native m.favourite room tag (per-room account data on the
  // homeserver, NOT localStorage), so favourites follow the account across
  // devices and browser clears.
  { id: 'favourites', label: 'Favourites' },
  { id: 'org', label: 'Orgs' },
  { id: 'division', label: 'Divisions' },
  { id: 'department', label: 'Depts' },
  // No separate human "Teams" tab: a team does not get its own channel — it
  // uses the org/division/department channel it belongs to, alongside that
  // level's assistant. "Agentic Teams" (installed agent rosters) is distinct.
  { id: 'agentic_team', label: 'Agentic Teams' },
  // Dev Slots (DEVSUITE-SLOTS): one room per checked-out dev slot. Without
  // this tab a slot room buckets under 'agents' (its default_agent is 'quox')
  // and is impossible to find as a slot. Always visible so operators know the
  // surface exists even before the first slot is checked out.
  { id: 'dev_slot', label: 'Dev Slots' },
  { id: 'agents', label: 'Agents' },
  { id: 'assistants', label: 'Assistants' },
  { id: 'direct', label: 'Direct' },
  // QuoxChat (QUOXCHAT-PRO P2): incoming website chats, rooms whose
  // ai.quox.room node_type is 'quoxchat'. Always visible (see
  // visibleRoomTabs), incoming chats appear asynchronously and operators
  // need to know the surface exists even at zero.
  { id: 'quoxchat', label: 'QuoxChat' },
  // Bridged-network tabs (owner ask): rooms mirrored from Telegram / Slack
  // over the Matrix backbone. Overlay buckets (like favourites), detected
  // via the bridge puppet MXID namespace (roomBridgeTab() above). Always
  // visible: bridged rooms arrive asynchronously and the empty tab (with
  // its informative empty-state line) tells operators the surface exists.
  { id: 'telegram', label: 'Telegram' },
  { id: 'slack', label: 'Slack' },
  { id: 'public', label: 'Public Rooms', disabled: true },
]

// Leading branded tab marks (owner ask: recognizable brand icons, not
// generic dots) + their tint colors, matching the .mc-bridge--* pill tokens
// in matrix-comms-theme.css (and detectBridgeNetwork()'s color fields).
// QuoxChat leads with its chat-bubble mark in the teal accent.
const TAB_BRAND = {
  telegram: { color: '#38bdf8', icon: <TelegramGlyphIcon /> },
  slack: { color: '#c084fc', icon: <SlackGlyphIcon /> },
  quoxchat: { color: 'var(--quoxchat-teal, #2dd4bf)', icon: <QuoxChatGlyphIcon size={11} /> },
}

// Informative empty-state lines for the bridge tabs (owner ask): an empty
// bridge tab should read as "nothing bridged yet", not as broken.
const BRIDGE_TAB_EMPTY = {
  telegram: 'No Telegram-bridged rooms visible to this account yet',
  slack: 'No Slack-bridged rooms visible to this account yet',
}

// Empty-state hints per tab. Bridge hints (above) also drive the
// .mc-empty-state--bridge styling; the dev_slot hint is a plain line that
// tells operators HOW to open a slot room, since the tab is always shown even
// with zero slots (it advertises the surface, like the bridge tabs).
const TAB_EMPTY_HINT = {
  ...BRIDGE_TAB_EMPTY,
  dev_slot: 'No dev slots yet. Check one out with: quox slot checkout <name> --create',
}

// Read the `ai.quox.room` state event's `node_type` off a joined room.
// Returns null for rooms with no such event (DMs, ad hoc rooms, or anything
// created before node_type was tracked), roomTypeBucket() below handles
// the fallback in that case.
function quoxRoomNodeType(room) {
  const ev = room?.currentState?.getStateEvents?.('ai.quox.room', '')
  return ev?.getContent?.()?.node_type || null
}

// Read the `ai.quox.room` state event's `org_id` (matrixProvisioner
// buildRoomState writes { org_id, node_type, node_id, default_agent }). Used
// to scope the room list to the active org — the dashboard logs into Matrix
// as ONE per-user identity, so without this the list is every org's rooms at
// once and switching the active org changes nothing.
function quoxRoomOrgId(room) {
  const ev = room?.currentState?.getStateEvents?.('ai.quox.room', '')
  return ev?.getContent?.()?.org_id || null
}

// Same 26-char Crockford-base32 ULID shape matrixProvisioner.js's
// agentLocalpart() tests server-side: a CUSTOM assistant's id is always a
// ULID (assistants.id), a CORE agent's id is always a short hand-picked
// slug ('quox', 'sentinel', 'nova', ...). Keeping this in lockstep with the
// server means the client never needs its own core-agent allowlist.
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i

function isUlid(id) {
  return typeof id === 'string' && ULID_RE.test(id)
}

// Classify a bare agent-reference id (an `ai.quox.room` `default_agent`
// value, or a `@_quoxagent_<id>` puppet's local id with the `a_` custom-
// assistant namespace prefix, see matrixProvisioner.js agentLocalpart(),
// stripped) as 'agents' (core) or 'assistants' (custom). Returns null for
// an empty/missing ref so callers can fall through to their next signal.
function agentRefBucket(agentRefId) {
  if (!agentRefId) return null
  const bare = agentRefId.startsWith('a_') ? agentRefId.slice(2) : agentRefId
  return isUlid(bare) ? 'assistants' : 'agents'
}

// Reconstruct an agent puppet's matrix user id from a registry entity id.
// Core agents use the bare slug ('sentinel'); custom assistants (ULID id) use
// the `a_` namespace prefix (matrixProvisioner agentLocalpart).
function entityPuppetId(entity) {
  const id = entity?.id
  if (!id) return null
  const localId = isUlid(id) ? `a_${id}` : id
  return `${AGENT_USER_PREFIX}${localId}${AGENT_USER_DOMAIN}`
}

// Matrix room alias localparts only allow a limited charset. Lowercase and
// swap anything outside [a-z0-9._=-] for a hyphen so a deterministic DM
// alias (see openEntityRoom's start-chat dedup) is always a valid alias.
function sanitizeAliasPart(part) {
  return String(part || '').toLowerCase().replace(/[^a-z0-9._=-]/g, '-')
}

// Split a full Matrix user id ('@bob:quox') into its localpart and server
// name, for building the deterministic per-DM room alias.
function splitUserId(userId) {
  const bare = String(userId || '').replace(/^@/, '')
  const idx = bare.indexOf(':')
  if (idx === -1) return { local: bare, server: '' }
  return { local: bare.slice(0, idx), server: bare.slice(idx + 1) }
}

// The bare registry id an existing room maps to (its ai.quox.room default_agent
// or its single agent member), used to match rooms to roster entities.
function roomAgentBareId(room, selfUserId) {
  const ev = room?.currentState?.getStateEvents?.('ai.quox.room', '')
  const da = ev?.getContent?.()?.default_agent
  if (da) return da.startsWith('a_') ? da.slice(2) : da
  const others = (room?.getJoinedMembers?.() || []).filter((m) => m.userId !== selfUserId)
  if (others.length === 1 && isAgentUserId(others[0].userId)) {
    const aid = extractAgentId(others[0].userId)
    if (aid) return aid.startsWith('a_') ? aid.slice(2) : aid
  }
  return null
}

// M-ROOMS: scan the live client room list (not the memoized roomByTeamId
// map) for a room whose ai.quox.room state event marks it as the agentic
// team room for teamId. Used by the openEntityRoom provisioning poll so a
// room that just landed via the appservice sync is picked up without
// waiting on the next render's memo recompute.
function findLiveTeamRoom(client, teamId) {
  if (!client || !teamId) return null
  for (const room of client.getRooms()) {
    const c = room?.currentState?.getStateEvents?.('ai.quox.room', '')?.getContent?.()
    if (c?.node_type === 'agentic_team' && c?.node_id === teamId) return room
  }
  return null
}

// Read the `ai.quox.room` state event's `default_agent` off a joined room
// (the assistants.id scope assistant, or a core agent id like 'quox' for
// CommanderQ rooms, see matrixProvisioner.js buildRoomState()) and
// classify it core-vs-custom. Returns null when the room has no
// `default_agent` set.
function quoxRoomDefaultAgentBucket(room) {
  const ev = room?.currentState?.getStateEvents?.('ai.quox.room', '')
  return agentRefBucket(ev?.getContent?.()?.default_agent)
}

// Bucket a joined room for the room-type tab bar. Provisioned org-tree
// rooms (including agentic_team rosters) use their `ai.quox.room` node_type
// directly; a CommanderQ room's node_type is the literal 'commanderq'
// sentinel value, which always buckets as an 'agents' room. Anything else
// with an `ai.quox.room` `default_agent` (e.g. a non-org-tree provisioned
// room) buckets core-vs-custom via agentRefBucket(). Everything remaining
// falls back to the same 1:1 signal classifyRoomType()/roomDisplayTitle()
// above already use (at most one other joined member): a 1:1 with an agent
// puppet buckets core-vs-custom via its puppet id, a 1:1 with a human is
// 'direct'; anything else (bridged, uncategorized group room) lands in
// 'other', which has no dedicated tab and only ever shows under 'all'.
function roomTypeBucket(room, selfUserId) {
  const nodeType = quoxRoomNodeType(room)
  if (nodeType === 'org' || nodeType === 'division' || nodeType === 'department' || nodeType === 'agentic_team') {
    return nodeType
  }
  // Retired taxonomy (owner ask): human teams use their org-tree channel,
  // there is no separate "Teams" group. Any lingering node_type 'team' room
  // groups under its org section instead.
  if (nodeType === 'team') return 'org'
  if (nodeType === 'commanderq') return 'agents'
  // Website chat rooms (QUOXCHAT-PRO P2) have their own tab; checked before
  // the default_agent fallback so a quoxchat room with a scoped operator
  // agent still buckets here.
  if (nodeType === 'quoxchat') return 'quoxchat'
  // Dev slot rooms (DEVSUITE-SLOTS): one Matrix room per checked-out slot,
  // provisioned with node_type 'dev_slot' (see matrixProvisioner + migration
  // 098). Checked BEFORE the default_agent fallback because a slot room's
  // default_agent is 'quox', which would otherwise bucket it under 'agents'
  // and make slot rooms indistinguishable from ordinary QUOX agent rooms.
  if (nodeType === 'dev_slot') return 'dev_slot'

  const defaultAgentBucket = quoxRoomDefaultAgentBucket(room)
  if (defaultAgentBucket) return defaultAgentBucket

  const others = (room?.getJoinedMembers?.() || []).filter((m) => m.userId !== selfUserId)
  if (others.length <= 1) {
    const other = others[0]
    if (other && isAgentUserId(other.userId)) {
      return agentRefBucket(extractAgentId(other.userId)) || 'agents'
    }
    return 'direct'
  }
  return 'other'
}

// M-ROOMS auto-join fix: the provisioner never has the human client join a
// default org/division/department/team/CommanderQ room itself, it invites the
// human (matrixProvisioner.js -> quox-matrix appservice provision.js), which
// left a pile of raw-ULID Accept/Decline invites for the owner to click
// through blind. The reliable signal that an invite is Quox-provisioned
// (never a genuine human-to-human invite) is the SENDER of our own
// `m.room.member` invite event: provision.js always invites as an agent
// actor (`client.inviteAs(creator, roomId, userId)`, creator is an agent
// user id), and per the Matrix spec that member event is guaranteed to be
// present in invite_room_state (it IS the invite). A custom `ai.quox.room`
// state event is NOT guaranteed to be leaked into invite_room_state by every
// homeserver config, so it is kept only as a secondary/fallback check.
function isProvisionedInviteRoom(room, selfUserId) {
  if (!room || !selfUserId) return false
  const memberEvent = room.currentState?.getStateEvents?.('m.room.member', selfUserId)
  const inviterId = memberEvent?.getSender?.()
  if (isAgentUserId(inviterId)) return true
  return Boolean(quoxRoomNodeType(room))
}

function GroupHeader({ label, icon, count, className }) {
  // mc-group-header (ROOMS-GREEN): the mockup's letter-spaced dim-green
  // section-label treatment; the colour lives in matrix-comms-theme.css so
  // it stays scoped to this view.
  return (
    <div className={`qx-row qx-row--tight mc-group-header${className ? ` ${className}` : ''}`} style={{
      alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 6px 6px', opacity: 0.55,
    }}>
      <span className="qx-row qx-row--tight" style={{ alignItems: 'center', gap: 6 }}>
        {icon}
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase' }}>{label}</span>
      </span>
      <span style={{ fontSize: 10, fontWeight: 700 }}>{count}</span>
    </div>
  )
}

// Centered day-separator pill inserted into the timeline where two adjacent
// message groups cross a calendar-day boundary (MATRIX-P5c).
function DaySeparator({ ts }) {
  return (
    <div className="qx-row mc-day-separator" style={{ alignItems: 'center', gap: 10, margin: '2px 0' }}>
      <span className="mc-day-separator-line" />
      <span className="qx-pill qx-pill--xs mc-day-separator-pill">{formatDaySeparatorLabel(ts)}</span>
      <span className="mc-day-separator-line" />
    </div>
  )
}

// Centered dim system line (ROOMS-GREEN, mockup mcx-sysline pattern):
// membership/state changes and HITL resolution receipts, rendered small and
// quiet instead of as a full message row.
function SysLine({ text }) {
  return <div className="mc-sysline">{text}</div>
}

// ── People-panel helpers (MATRIX-P5) ────────────────────────────────────────

const AGENT_ID_RE = /^@_quoxagent_(.+):quox$/

function extractAgentId(userId) {
  const m = typeof userId === 'string' && userId.match(AGENT_ID_RE)
  return m ? m[1] : null
}

// Two-letter monogram for an avatar with no image (Slack/Discord pattern).
function monogram(nameOrId) {
  const clean = (nameOrId || '').replace(/^@/, '').split(':')[0]
  const parts = clean.split(/[\s._-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return clean.slice(0, 2).toUpperCase() || '?'
}

// Bridged-network badge for an individual member (People panel sub-label).
function memberNetwork(userId) {
  // Website visitors (QUOXCHAT-PRO P2) read as an origin, like a bridge.
  if (isVisitorUserId(userId)) {
    return { key: 'quoxchat', label: 'Website visitor', icon: <QuoxChatGlyphIcon size={11} /> }
  }
  if (userId?.startsWith('@telegram_')) {
    return { key: 'telegram', label: 'Telegram', icon: <TelegramGlyphIcon /> }
  }
  if (userId?.startsWith('@slack_')) {
    return { key: 'slack', label: 'Slack', icon: <SlackGlyphIcon /> }
  }
  if (userId?.startsWith('@discord_')) {
    return { key: 'discord', label: 'Discord', icon: <DiscordGlyphIcon /> }
  }
  return null
}

// Presence dot colour. Agents are appservice-backed and always-on, so
// callers pass 'online' for them directly. For humans: matrix-js-sdk's
// User model defaults `presence` to 'offline' even when no m.presence event
// has ever been received for that user, so there is no reliable SDK signal
// to distinguish "confirmed offline" from "never observed" — both collapse
// to the same neutral/dim dot here, which matches the spec's "fall back to
// a neutral dot if unknown".
function presenceDotColor(presence) {
  if (presence === 'online') return 'var(--matrix-green, #30ff90)'
  if (presence === 'unavailable') return '#f59e0b'
  return 'rgba(255,255,255,0.3)'
}

// Favourite check (ROOMS-FAV): the Matrix-native m.favourite room tag,
// which matrix-js-sdk surfaces on room.tags from per-room account data.
// Server-side by design, never localStorage.
function isFavouriteRoom(room) {
  return Boolean(room?.tags?.['m.favourite'])
}

// Roster sub-label descriptor (ROOMS-TAGLINES): a short informative line
// instead of the bare role word. Prefers the entity's concise tagline, then
// its description (custom API assistants map their description into
// identity.tagline via normalizeApiAssistantEntity, so both populations are
// covered), truncated to a single ~40-char line. Falls back to the
// title-cased role. Never a raw ULID.
function entityTagline(entity, kind) {
  const raw = entity?.identity?.tagline || entity?.identity?.description || entity?.description || ''
  const clean = String(raw).replace(/\s+/g, ' ').trim()
  if (clean && !isUlid(clean)) {
    return clean.length > 40 ? `${clean.slice(0, 40).trimEnd()}…` : clean
  }
  const role = entity?.hierarchy?.role
  if (role && !isUlid(role)) return role[0].toUpperCase() + role.slice(1)
  return kind === 'assistant' ? 'Assistant' : 'Agent'
}

// Kebab trigger + context-menu wiring shared by the row components below.
// Rows are <button> elements, so the kebab is a span with role=button
// (nested real buttons are invalid HTML); stopPropagation keeps the kebab
// from also firing the row's own open/select action.
function RowKebab({ onMenuOpen, className }) {
  if (typeof onMenuOpen !== 'function') return null
  const openFromKebab = (e) => {
    e.stopPropagation()
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    onMenuOpen(rect.left, rect.bottom + 4)
  }
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label="More actions"
      className={`mc-row-action mc-row-kebab${className ? ` ${className}` : ''}`}
      onClick={openFromKebab}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openFromKebab(e) }}
    >
      <KebabIcon />
    </span>
  )
}

// Shared right-click handler builder for rows with a context menu.
function rowContextMenuHandler(onMenuOpen) {
  if (typeof onMenuOpen !== 'function') return undefined
  return (e) => {
    e.preventDefault()
    e.stopPropagation()
    onMenuOpen(e.clientX, e.clientY)
  }
}

// Directory row for a roster entity (agent / assistant / team) that has no
// room yet. Clicking opens or starts its channel. Kept visually consistent
// with RoomRow but dimmed and tagged with a "Start chat" affordance.
function EntityRow({ entity, kind, onOpen, onMenuOpen }) {
  const name = entity?.identity?.name || entity?.name || entity?.id || 'Unknown'
  const sub = kind === 'team'
    ? 'Agentic team · Open'
    : `${entityTagline(entity, kind)} · Start chat`
  return (
    <button
      className="glass-nav mc-room-row"
      onClick={onOpen}
      onContextMenu={rowContextMenuHandler(onMenuOpen)}
      style={{
        width: '100%', marginBottom: 8, textAlign: 'left', background: 'transparent',
        alignItems: 'center', padding: '11px 12px', minHeight: 56, gap: 10, opacity: 0.82,
      }}
    >
      <span className="mc-room-glyph-box"><RoomIcon /></span>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: 3, justifyContent: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ fontSize: 11, opacity: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>
      </div>
      <RowKebab onMenuOpen={onMenuOpen} />
    </button>
  )
}

// Org logo avatar for breadcrumb rooms — uploaded org icon, initials fallback.
function OrgAvatar({ name, logoUrl, size = 30 }) {
  const [errored, setErrored] = useState(false)
  const initials = (name || '?').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'
  const showImg = logoUrl && !errored
  return (
    <span className="mc-org-avatar" title={name || ''} style={{
      width: size, height: size, borderRadius: 8, flexShrink: 0, overflow: 'hidden',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(255,255,255,0.07)', fontSize: 11, fontWeight: 700,
    }}>
      {showImg
        ? <img src={logoUrl} alt={name || 'Org'} onError={() => setErrored(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : initials}
    </span>
  )
}

function RoomRow({ room, selected, onSelect, selfUserId, client, orgBrand, favourite, onToggleFavourite, onMenuOpen, entityFor }) {
  const network = useMemo(() => detectBridgeNetwork(room, selfUserId), [room, selfUserId])
  const preview = useMemo(() => lastActivityPreview(room, client, selfUserId), [room, client, selfUserId])
  const title = useMemo(() => roomDisplayTitle(room, selfUserId, client), [room, selfUserId, client])

  // Agent DM avatar (owner bug report: ARGUS / CommanderQ rows adopted the
  // org logo or nothing). ROOT CAUSE: this row never resolved the agent
  // puppet member's avatar at all. The leading visual was only ever the
  // OrgAvatar (breadcrumb titles) or the generic RoomIcon, so any
  // @_quoxagent_* DM fell through to those. Fix: when the room is an agent
  // DM (no org-tree node_type, exactly one other member and it is an agent
  // puppet, visitors excluded), resolve THAT member's avatar through
  // resolveAvatar (registry entity avatar first via `entityFor`, matrix
  // profile fallback) and render it with the green initial-based fallback.
  const agentDMMember = useMemo(() => {
    const nodeType = quoxRoomNodeType(room)
    if (nodeType && nodeType !== 'commanderq') return null
    const others = (room.getJoinedMembers?.() || []).filter((m) => m.userId !== selfUserId)
    if (others.length !== 1) return null
    const other = others[0]
    if (!isAgentUserId(other.userId) || isVisitorUserId(other.userId)) return null
    return other
  }, [room, selfUserId])
  const agentEntity = agentDMMember ? (entityFor?.(room)?.entity || null) : null
  const agentAvatarUrl = agentDMMember
    ? resolveAvatar(agentDMMember.userId, { member: agentDMMember, client, entity: agentEntity })
    : null
  const agentDMName = agentDMMember
    ? resolveDisplayName(agentDMMember.userId, { member: agentDMMember, client })
    : null
  // Unread notification count for this room (ROOMS-GREEN, mockup parity):
  // the filled green bubble at the row's trailing edge. `rooms` gets a new
  // array reference on every refreshRooms(), so this stays live.
  const unread = room.getUnreadNotificationCount?.() || 0

  // Breadcrumb rooms ("Org > Division > Dept") lead with the org LOGO instead
  // of repeating the org name as text — saves horizontal width and uses the
  // uploaded org icon. The visible label is then only the sub-path, which is
  // allowed to wrap to two lines below.
  const segs = (title || '').split('>').map((s) => s.trim()).filter(Boolean)
  const isBreadcrumb = segs.length >= 2 || (segs.length === 1 && !!orgBrand?.name && segs[0] === orgBrand.name)
  const label = isBreadcrumb
    ? (segs.length >= 2 ? segs.slice(1).join(' > ') : segs[0])
    : (title || room.roomId)

  // QuoxChat rooms (QUOXCHAT-PRO P2): avatar-less rows lead with a teal
  // chat-bubble glyph instead of the org-logo/room fallback, so incoming
  // website chats read at a glance. Real avatars (breadcrumb org logo)
  // stay untouched.
  const isQuoxchat = quoxRoomNodeType(room) === 'quoxchat'

  // Star toggle (ROOMS-FAV): hover-revealed unless already favourited, in
  // which case it stays visible in amber. Span-with-role, not a nested
  // <button>, same reason as RowKebab.
  const handleStarClick = onToggleFavourite
    ? (e) => { e.stopPropagation(); e.preventDefault(); onToggleFavourite() }
    : undefined

  return (
    <button
      className={`glass-nav mc-room-row${selected ? ' active' : ''}`}
      onClick={onSelect}
      onContextMenu={rowContextMenuHandler(onMenuOpen)}
      style={{
        width: '100%', marginBottom: 8, textAlign: 'left', background: selected ? undefined : 'transparent',
        alignItems: 'center', padding: '11px 12px', minHeight: 56, gap: 10,
      }}
    >
      {agentDMMember
        ? (
          <span className="qx-avatar qx-avatar--sm mc-agent-avatar" style={{ flexShrink: 0 }}>
            <AvatarFace avatarUrl={agentAvatarUrl} alt={agentDMName || ''} client={client}>
              {monogram(agentDMName || agentDMMember.userId)}
            </AvatarFace>
          </span>
        )
        : isBreadcrumb
          ? <OrgAvatar name={orgBrand?.name || segs[0]} logoUrl={orgBrand?.logoUrl} />
          : isQuoxchat
            ? <span className="mc-quoxchat-room-glyph"><QuoxChatGlyphIcon size={16} /></span>
            : <span className="mc-room-glyph-box"><RoomIcon /></span>}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: 4, justifyContent: 'center' }}>
        <span className="qx-row qx-row--tight" style={{ alignItems: 'flex-start', gap: 6 }}>
          <span className="mc-room-row-title" style={{
            fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            overflow: 'hidden', wordBreak: 'break-word', lineHeight: 1.25,
          }}>
            {label}
          </span>
          {network && (
            <span
              className={`mc-bridge mc-bridge--${network.key} qx-tip`}
              data-tip={`Bridged via ${network.label}`}
              style={{ flexShrink: 0 }}
            >
              {network.icon} {network.label}
            </span>
          )}
        </span>
        <span className="qx-row qx-row--tight" style={{ alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span className="mc-room-preview" style={{ fontSize: 10.5, opacity: 0.45, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {preview.sender ? `${preview.sender}: ` : ''}{preview.text}
          </span>
          {preview.ts > 0 && (
            <span style={{ fontSize: 10, opacity: 0.45, flexShrink: 0 }} title={formatAbsoluteTooltip(preview.ts)}>
              {formatCompactTime(preview.ts)}
            </span>
          )}
          {unread > 0 && (
            <span className="mc-room-unread" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span>
          )}
        </span>
      </div>
      {handleStarClick && (
        <span
          role="button"
          tabIndex={0}
          aria-label={favourite ? 'Remove from favourites' : 'Add to favourites'}
          aria-pressed={favourite}
          title={favourite ? 'Remove from favourites' : 'Add to favourites'}
          className={`mc-row-action mc-room-star${favourite ? ' mc-room-star--active' : ''}`}
          onClick={handleStarClick}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleStarClick(e) }}
        >
          <StarIcon filled={favourite} />
        </span>
      )}
      <RowKebab onMenuOpen={onMenuOpen} />
    </button>
  )
}

// Real avatar image with a monogram fallback (Slack/Discord pattern: agents
// use their entity-registry avatar, humans/bridged users use their Matrix
// profile avatar, org/div/dept assistants would use the org logo — see the
// `resolveAvatar` doc comment in matrixClient.js for the fallback chain and
// the deferred org-logo mapping). `avatarUrl` may be null (no real image
// resolved) or may 404 (many core agent avatar files aren't checked in yet)
// — either case falls through to the monogram text passed as `children`.
//
// Agent avatars (`/assets/agents/*.svg`) are plain dashboard assets and
// render directly. Matrix `mxc://`-sourced avatars (humans/bridged users)
// come back from `resolveAvatar` as an AUTHENTICATED media URL (Synapse
// v1.156 / MSC3916) that a bare `<img src>` can't fetch — no way to attach
// a Bearer header to an image request, so it 401s. So for those we resolve
// the URL ASYNC via `resolveAuthedMediaBlobUrl` (fetch with the client's
// access token, then `URL.createObjectURL` the blob) and only set `<img
// src>` once that resolves; while loading or on any failure the monogram
// fallback stays up. `resolveAuthedMediaBlobUrl` caches per source URL at
// module scope in matrixClient.js, so the same sender's avatar is fetched
// once no matter how many rows render it — object URLs are intentionally
// NOT revoked here on a single row's unmount (another row may still be
// showing the same cached blob); they're revoked in bulk on
// `resetMatrixClient()` instead.
function AvatarFace({ avatarUrl, alt, client, children }) {
  const [imgFailed, setImgFailed] = useState(false)
  const [resolvedSrc, setResolvedSrc] = useState(null)

  useEffect(() => {
    setImgFailed(false)
    setResolvedSrc(null)

    if (!avatarUrl) return undefined

    if (!isAuthedMatrixMediaUrl(avatarUrl)) {
      setResolvedSrc(avatarUrl)
      return undefined
    }

    let cancelled = false
    resolveAuthedMediaBlobUrl(client, avatarUrl).then((objectUrl) => {
      if (cancelled) return
      if (objectUrl) setResolvedSrc(objectUrl)
      else setImgFailed(true)
    })
    return () => { cancelled = true }
  }, [avatarUrl, client])

  if (resolvedSrc && !imgFailed) {
    return <img src={resolvedSrc} alt={alt || ''} onError={() => setImgFailed(true)} />
  }
  return children
}

// ── Inline media attachments (ROOMS-MEDIA) ──────────────────────────────────
//
// m.image / m.file / m.video timeline events render inline instead of the
// old generic "media attachment" chip. All Matrix media on this homeserver
// is AUTHENTICATED (MSC3916, see matrixClient.js): the event's mxc URI is
// converted to an authed download URL (buildAuthedMediaDownloadUrl) and
// fetched with the client's Bearer token via the shared blob cache
// (resolveAuthedMediaBlobUrl), then rendered as a local blob: object URL.
// Media relayed by the Telegram/Slack bridges arrives as ordinary m.image /
// m.file / m.video events carrying mxc URIs, so it flows through the exact
// same pipeline with no special-casing. Object URLs are cached module-wide
// and revoked in bulk on resetMatrixClient(), mirroring the avatar pipeline
// above. Encrypted media (content.file, no content.url) is not supported
// here and falls back to the broken-media chip.

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Save an already-resolved blob: object URL to disk via a temporary anchor
// with the download attribute. No new tab, no navigation; reuses the one
// cached blob so nothing is re-fetched.
function downloadBlobUrl(src, name) {
  if (!src) return
  const a = document.createElement('a')
  a.href = src
  a.download = name || 'download'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// Probe a local image file's intrinsic pixel size for the m.image info
// block. Resolves null for anything the browser can't decode.
function probeImageDimensions(file) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(null)
    }
    img.src = objectUrl
  })
}

// Resolve a timeline event's mxc URI to a local blob: object URL.
// status: 'loading' | 'ready' | 'error'. Same cancellation + cache
// discipline as AvatarFace above.
function useAuthedMediaBlob(client, mxc) {
  const [state, setState] = useState({ status: 'loading', src: null })

  useEffect(() => {
    const url = buildAuthedMediaDownloadUrl(client, mxc)
    if (!url) {
      setState({ status: 'error', src: null })
      return undefined
    }
    let cancelled = false
    setState({ status: 'loading', src: null })
    resolveAuthedMediaBlobUrl(client, url).then((objectUrl) => {
      if (cancelled) return
      setState(objectUrl ? { status: 'ready', src: objectUrl } : { status: 'error', src: null })
    })
    return () => { cancelled = true }
  }, [client, mxc])

  return state
}

// Fallback chip when media can't be fetched (deleted on the server,
// encrypted payload, malformed mxc URI). Keeps the old chip's look.
function BrokenMediaChip({ label }) {
  return (
    <span className="glass-btn mc-media-broken" style={{ display: 'inline-flex', width: 'fit-content', background: 'transparent', cursor: 'default', opacity: 0.7 }}>
      <MediaIcon /> {label}
    </span>
  )
}

// Inline image THUMBNAIL: fixed 260x200 cover-cropped box (CSS), click
// opens the in-app lightbox overlay (no new tab). A download icon button
// appears top-right on hover. The one cached blob serves thumbnail,
// lightbox and download, so the image is fetched exactly once per session.
function TimelineImage({ content, client, onExpand }) {
  const { status, src } = useAuthedMediaBlob(client, content.url)
  if (status === 'error') return <BrokenMediaChip label={content.body || 'image unavailable'} />
  if (status === 'loading') return <span className="mc-media-skeleton" role="img" aria-label="Loading image" />
  const name = content.filename || content.body || 'image'
  return (
    <span className="mc-media-thumb-wrap">
      <img
        className="mc-media-image"
        src={src}
        alt={name}
        title="Expand"
        onClick={() => onExpand?.({ src, name, kind: 'image' })}
      />
      <button
        type="button"
        className="mc-media-icon-btn mc-media-icon-btn--hover"
        title={`Download ${name}`}
        aria-label={`Download ${name}`}
        onClick={(e) => { e.stopPropagation(); downloadBlobUrl(src, name) }}
      >
        <DownloadIcon />
      </button>
    </span>
  )
}

// Inline video: native controls, no autoplay, metadata preload only (the
// blob is already local so this is about not auto-playing, not bandwidth).
// Capped like the image thumbnails; expand + download buttons sit top-right
// (always visible, clear of the native controls at the bottom).
function TimelineVideo({ content, client, onExpand }) {
  const { status, src } = useAuthedMediaBlob(client, content.url)
  if (status === 'error') return <BrokenMediaChip label={content.body || 'video unavailable'} />
  if (status === 'loading') return <span className="mc-media-skeleton" aria-label="Loading video" />
  const name = content.filename || content.body || 'video'
  return (
    <span className="mc-media-thumb-wrap">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video className="mc-media-video" src={src} controls preload="metadata" />
      <span className="mc-media-btn-row">
        <button
          type="button"
          className="mc-media-icon-btn"
          title="Expand"
          aria-label={`Expand ${name}`}
          onClick={() => onExpand?.({ src, name, kind: 'video' })}
        >
          <ExpandIcon />
        </button>
        <button
          type="button"
          className="mc-media-icon-btn"
          title={`Download ${name}`}
          aria-label={`Download ${name}`}
          onClick={() => downloadBlobUrl(src, name)}
        >
          <DownloadIcon />
        </button>
      </span>
    </span>
  )
}

// Full-screen in-app lightbox for image/video attachments. Fixed overlay,
// dim backdrop, media centered (max 90vw x 85vh), filename caption plus a
// Download button underneath. Escape or a backdrop click closes it. No
// mount animation, so nothing to add to the reduced-motion block.
function MediaLightbox({ item, onClose }) {
  useEffect(() => {
    if (!item) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, onClose])

  if (!item) return null
  return (
    <div
      className="mc-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={item.name || 'Media preview'}
      onClick={onClose}
    >
      <div className="mc-lightbox-body" onClick={(e) => e.stopPropagation()}>
        {item.kind === 'video' ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video className="mc-lightbox-media" src={item.src} controls />
        ) : (
          <img className="mc-lightbox-media" src={item.src} alt={item.name || 'image'} />
        )}
        <div className="mc-lightbox-caption">
          <span className="mc-lightbox-name" title={item.name}>{item.name}</span>
          <button
            type="button"
            className="glass-btn mc-lightbox-download"
            onClick={() => downloadBlobUrl(item.src, item.name)}
          >
            <DownloadIcon size={13} /> Download
          </button>
        </div>
      </div>
    </div>
  )
}

// Download chip for m.file: filename + size, fetches the blob lazily on
// click (files can be big; no point pulling them just to render a chip).
function TimelineFileChip({ content, client }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const name = content.filename || content.body || 'file'
  const size = formatBytes(content.info?.size)

  const handleDownload = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try {
      const url = buildAuthedMediaDownloadUrl(client, content.url)
      const objectUrl = url ? await resolveAuthedMediaBlobUrl(client, url) : null
      if (!objectUrl) {
        setFailed(true)
        return
      }
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
    } finally {
      setBusy(false)
    }
  }, [busy, client, content.url, name])

  return (
    <button
      type="button"
      className="glass-btn mc-file-chip"
      onClick={handleDownload}
      disabled={busy}
      title={`Download ${name}`}
    >
      <PaperclipIcon />
      <span className="mc-file-chip-name">{name}</span>
      {size && <span className="mc-file-chip-size">{size}</span>}
      {busy && <span className="mc-file-chip-size">downloading…</span>}
      {failed && !busy && <span className="mc-file-chip-size" style={{ color: 'var(--status-error)' }}>download failed</span>}
      <span className="mc-file-chip-dl" aria-hidden="true"><DownloadIcon /></span>
    </button>
  )
}

// One row in the right-hand People panel — avatar (real image, monogram
// fallback), name, a role/network sub-label, and a presence dot. Clicking a
// row inserts an @-mention of that person into the composer (chat-app
// polish) — `onMentionClick` is omitted for the self row (see call site).
function PeopleRow({ userId, displayName, subLabel, subIcon, avatarClassName, avatarUrl, presence, client, network, onMentionClick, onMenuOpen }) {
  const clickable = typeof onMentionClick === 'function'
  return (
    <div
      className="qx-row qx-row--tight mc-person-row"
      style={{ alignItems: 'center', padding: '10px 10px', borderRadius: 10, minHeight: 56, marginBottom: 4, cursor: clickable ? 'pointer' : 'default' }}
      title={clickable ? `Mention ${displayName || userId}` : userId}
      onClick={clickable ? onMentionClick : undefined}
      onContextMenu={rowContextMenuHandler(onMenuOpen)}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMentionClick() } } : undefined}
    >
      <div className={`qx-avatar qx-avatar--sm${avatarClassName ? ` ${avatarClassName}` : ''}`}>
        <AvatarFace avatarUrl={avatarUrl} alt={displayName || userId} client={client}>
          {monogram(displayName || userId)}
        </AvatarFace>
        <span className="qx-avatar__status" style={{ '--qx-avatar-status': presence }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: 3 }}>
        <span className="qx-row qx-row--tight" style={{ alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {displayName || userId}
          </span>
          {/* Bridged-origin pill (ROOMS-GREEN, mockup mcx-bridge parity),
              leading with the branded network mark. */}
          {network && (
            <span className={`mc-bridge mc-bridge--${network.key}`} style={{ flexShrink: 0 }}>{network.icon} {network.label}</span>
          )}
        </span>
        <span className="qx-row qx-row--tight" style={{ alignItems: 'center', gap: 4, fontSize: 11, opacity: 0.55 }}>
          {subIcon}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subLabel}</span>
        </span>
      </div>
      <RowKebab onMenuOpen={onMenuOpen} />
    </div>
  )
}

// ── Row context menu (ROOMS-CTX) ────────────────────────────────────────────
//
// One reusable glass flyout, defined in-file per house convention (matching
// the invite-agent popover and reaction picker). Opened by BOTH the kebab
// trigger on a row (anchored under the button) and the row's native
// onContextMenu (anchored at the cursor). Fixed-position with viewport
// clamping so it never renders off-screen; closes on outside click, Escape,
// or after an item runs.
function ContextFlyout({ x, y, items, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: x, top: y })
  // Inline are-you-sure state (owner ask, Remove chat): the first click on
  // an item with `confirm` swaps its label to the confirm prompt instead of
  // running; the second click runs it. Any other item click resets it.
  const [confirmingId, setConfirmingId] = useState(null)

  // Clamp to the viewport once the flyout has a measured size.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) { setPos({ left: x, top: y }); return }
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = x
    let top = y
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    setPos({ left, top })
  }, [x, y])

  useEffect(() => {
    const onDocMouseDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="qx-card mc-context-flyout"
      role="menu"
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 60, padding: 6 }}
    >
      {items.map((item) => {
        const confirming = confirmingId === item.id
        const classes = ['glass-nav', 'mc-context-item']
        if (item.active) classes.push('mc-context-item--active')
        if (item.danger) classes.push('mc-context-item--danger')
        if (confirming) classes.push('mc-context-item--confirming')
        if (item.disabled) classes.push('mc-context-item--disabled')
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={classes.join(' ')}
            disabled={!!item.disabled}
            aria-disabled={item.disabled ? 'true' : undefined}
            onClick={() => {
              if (item.disabled) return
              if (item.confirm && !confirming) { setConfirmingId(item.id); return }
              onClose()
              item.onClick()
            }}
          >
            {item.icon}
            <span>{confirming ? (item.confirmLabel || 'Are you sure?') : item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// Small anchored glass info card (owner ask, people-panel "View info" on
// humans): same fixed-position + viewport-clamp + dismiss discipline as
// ContextFlyout, but renders arbitrary content instead of menu items.
function InfoFlyout({ x, y, onClose, children }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) { setPos({ left: x, top: y }); return }
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = x
    let top = y
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    setPos({ left, top })
  }, [x, y])

  useEffect(() => {
    const onDocMouseDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="qx-card mc-context-flyout mc-person-info"
      role="dialog"
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 60, padding: 12 }}
    >
      {children}
    </div>
  )
}

// ── Reactions (MATRIX-P5b) ───────────────────────────────────────────────
//
// Matrix reactions are `m.reaction` events with `m.relates_to: { rel_type:
// 'm.annotation', event_id: <target>, key: <emoji> }`. matrix-js-sdk
// aggregates these per-room via `room.relations` (a `RelationsContainer`),
// keeping annotation groups up to date as reaction/redaction events flow
// through the same `Room.timeline` / `Room.localEchoUpdated` pipeline
// regular messages use — no separate fetch needed.
//
// A curated emoji set (no heavy emoji-picker dependency, per spec).
const REACTION_EMOJI_SET = ['👍', '👎', '✅', '❌', '🎉', '👀', '❤️', '🔥', '👏', '💯']

// Aggregate reactions for a single message event into chip-ready rows:
// { key, count, reacted, selfEventId }. `selfEventId` is the current user's
// own reaction event id for that emoji (needed to redact it on un-react).
// Returns [] when the room has no relations container yet or no reactions
// exist for this event — callers should skip rendering the reactions row
// in that case.
function getReactionsForEvent(room, eventId, selfUserId) {
  const relations = room?.relations?.getChildEventsForEvent(eventId, 'm.annotation', 'm.reaction')
  const grouped = relations?.getSortedAnnotationsByKey()
  if (!grouped) return []
  const out = []
  for (const [key, eventsSet] of grouped) {
    const liveEvents = [...eventsSet].filter((ev) => !ev.isRedacted?.())
    if (liveEvents.length === 0) continue
    const mine = liveEvents.find((ev) => ev.getSender() === selfUserId)
    out.push({ key, count: liveEvents.length, reacted: !!mine, selfEventId: mine?.getId() || null })
  }
  return out
}

// ── @-mentions (chat-app polish) ────────────────────────────────────────
//
// A "handle" is just the room member's resolved display name with whitespace
// stripped (e.g. "WARDEN" stays "WARDEN", "Adam Smith" -> "AdamSmith") —
// no separate identity system, just enough to make a mention un-ambiguous
// and clickable. Clicking a person (People panel row or a timeline sender)
// appends "@Handle " to the composer draft; typing "@" in the composer opens
// a small autocomplete of the same candidates.
function mentionHandleFor(displayName) {
  if (!displayName) return ''
  return displayName.replace(/\s+/g, '')
}

// Tokenize a message body into plain-text runs and highlighted mention
// pills, matched against the room's KNOWN member handles only (never a bare
// "@word" heuristic) to avoid false positives on emails, code, etc. Longest
// handle wins at a given position so one member's handle can't shadow a
// longer one that starts the same way.
function renderMessageBody(text, mentionCandidates) {
  if (!text) return text
  if (!mentionCandidates || mentionCandidates.length === 0) return text
  const sorted = mentionCandidates
    .filter((c) => c.handle && c.handle.length >= 2)
    .sort((a, b) => b.handle.length - a.handle.length)
  if (sorted.length === 0) return text

  const nodes = []
  let buffer = ''
  let i = 0
  const flush = () => { if (buffer) { nodes.push(buffer); buffer = '' } }
  while (i < text.length) {
    if (text[i] === '@') {
      const found = sorted.find((c) => {
        const slice = text.slice(i + 1, i + 1 + c.handle.length)
        if (slice.toLowerCase() !== c.handle.toLowerCase()) return false
        const nextChar = text[i + 1 + c.handle.length]
        return !nextChar || !/[A-Za-z0-9_]/.test(nextChar)
      })
      if (found) {
        flush()
        nodes.push(<span key={`mention-${i}`} className="mc-mention-pill">@{found.handle}</span>)
        i += 1 + found.handle.length
        continue
      }
    }
    buffer += text[i]
    i += 1
  }
  flush()
  return nodes
}

// ── Component ────────────────────────────────────────────────────────────

export default function MatrixCommsView() {
  // Active org branding for breadcrumb room rows (org logo, initials fallback).
  const { currentOrg } = useWorkspace()
  const { authFetch } = useAuth()
  const orgBrand = useMemo(
    () => ({ name: currentOrg?.name || '', logoUrl: currentOrg?.logo_url || null }),
    [currentOrg?.name, currentOrg?.logo_url]
  )
  const [teams, setTeams] = useState([])
  const [roomSort, setRoomSort] = useState('group') // group | recent | alpha
  const [status, setStatus] = useState('connecting') // connecting | ready | error
  const [error, setError] = useState(null)
  // M-ROOMS UX audit: neutral progress notices (team room provisioning) must
  // not render in the red error banner; they get their own amber notice.
  const [notice, setNotice] = useState(null)
  const [rooms, setRooms] = useState([])
  const [inviteRooms, setInviteRooms] = useState([])
  const [selectedRoomId, setSelectedRoomId] = useState(null)
  const [events, setEvents] = useState([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [membersVersion, setMembersVersion] = useState(0)
  const [presenceVersion, setPresenceVersion] = useState(0)
  // Bumped on `Room.receipt` (a room being marked read); see the
  // roomTabUnread memo below for why this is needed alongside `rooms`.
  const [unreadVersion, setUnreadVersion] = useState(0)
  // Bumped on `Room.tags` (a room's m.favourite tag changing, locally or on
  // another device via sync) so the favourites tab/stars re-render
  // (ROOMS-FAV). The tag itself lives in per-room account data server-side.
  const [favouritesVersion, setFavouritesVersion] = useState(0)
  // Row context menu (ROOMS-CTX): { x, y, items } or null. One menu at a
  // time, shared by roster rows, room rows, and people-panel member rows.
  const [ctxMenu, setCtxMenu] = useState(null)
  // Person info flyout (owner ask): { x, y, userId, displayName, network }
  // or null. Opened from a human member row's "View info" menu item.
  const [personInfo, setPersonInfo] = useState(null)
  const navigate = useNavigate()
  const location = useLocation()

  // QUOXCHAT-PRO: the widget manager's Logs tab deep-links here with a room
  // id in location state ("View live room" on a handed-off conversation).
  // Select that room and land on the QuoxChat tab once, then clear the state
  // so back/forward does not re-trigger the jump.
  useEffect(() => {
    const wanted = location.state?.quoxchatRoomId
    const tabOnly = location.state?.quoxchatTab
    if (!wanted && !tabOnly) return
    setActiveTab('quoxchat')
    if (wanted) setSelectedRoomId(wanted)
    navigate(location.pathname, { replace: true, state: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state?.quoxchatRoomId, location.state?.quoxchatTab])

  // Room-type tab bar (CORECOMM-UX #190), filters the sidebar's joined-room
  // list by ai.quox.room node_type (org/division/department/team/direct).
  const [activeTab, setActiveTab] = useState('all')

  // Reactions (MATRIX-P5b) — bumped whenever an `m.reaction` /
  // `m.room.redaction` event lands (remote echo via Room.timeline, local
  // echo via Room.localEchoUpdated), so the reaction-aggregation memo below
  // recomputes without refetching anything from the SDK's own aggregation.
  const [reactionsVersion, setReactionsVersion] = useState(0)
  // The one message whose add-reaction picker is currently open (only one
  // at a time — a second click elsewhere closes it).
  const [reactionPickerEventId, setReactionPickerEventId] = useState(null)
  // In-app lightbox for image/video attachments: { src, name, kind } | null.
  const [mediaLightbox, setMediaLightbox] = useState(null)

  // Right-hand People panel — starts collapsed on narrow viewports, always
  // manually toggle-able afterward (matchMedia doesn't fight a manual pick).
  const [peopleCollapsed, setPeopleCollapsedState] = useState(
    () => (typeof window !== 'undefined' ? window.innerWidth < 1160 : false)
  )
  const peopleManualRef = useRef(false)

  // New room
  const [newRoomOpen, setNewRoomOpen] = useState(false)
  const [newRoomName, setNewRoomName] = useState('')
  const [creatingRoom, setCreatingRoom] = useState(false)
  const [newRoomError, setNewRoomError] = useState(null)

  // Invite agent
  const [inviteAgentOpen, setInviteAgentOpen] = useState(false)
  const [inviteAgentSearch, setInviteAgentSearch] = useState('')
  const [invitingAgentId, setInvitingAgentId] = useState(null)
  const [inviteAgentStatus, setInviteAgentStatus] = useState(null) // { type: 'success'|'error', text }

  // Typing notifications (MATRIX-P5c) — who's currently typing in the
  // selected room (excluding self), and the refs backing the debounced
  // outgoing `client.sendTyping()` calls from the composer.
  const [typingUserIds, setTypingUserIds] = useState([])
  const typingStopTimeoutRef = useRef(null)
  const typingLastSentRef = useRef(0)

  // @-mention autocomplete (chat-app polish) — `mentionQuery` is the text
  // typed after the last un-terminated "@" before the caret (null when the
  // composer isn't mid-mention); `mentionAnchorIndex` is that "@"'s position
  // in `draft`, needed to splice the completed handle back in.
  const [mentionQuery, setMentionQuery] = useState(null)
  const [mentionAnchorIndex, setMentionAnchorIndex] = useState(null)
  const composerInputRef = useRef(null)

  // Attachment upload state (ROOMS-MEDIA): `uploading` gates the composer
  // attach button, `uploadPct` is the js-sdk progressHandler readout shown
  // on it, `dragActive` drives the drop-target highlight over the timeline.
  // dragDepthRef counts nested dragenter/dragleave pairs so child elements
  // don't flicker the overlay off.
  const attachInputRef = useRef(null)
  const dragDepthRef = useRef(0)
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(null)
  const [dragActive, setDragActive] = useState(false)

  // Live per-agent "thinking" indicator (chat-app polish). The appservice
  // now emits a real m.typing signal while an agent's brain turn is in
  // flight (responder.js M-TYPING), which surfaces through the native
  // typing roster above. This LOCAL approximation covers the gap BEFORE
  // that signal arrives (appservice event delivery + turn pickup can lag a
  // couple of seconds behind the send): after the human sends a message
  // into a room that has an agent member, assume that agent is about to
  // reply and show "NAME is thinking…" until either that agent's next
  // message lands in the timeline or a timeout elapses (whichever is
  // first). Names already present in the native typing roster are excluded
  // at render time (see thinkingLabel) so one agent never shows as both
  // "typing" and "thinking" at once.
  const [pendingAgentReply, setPendingAgentReply] = useState(null) // { roomId, names } | null
  const pendingAgentTimeoutRef = useRef(null)

  // A UI-only ticking clock (no data refetch) so compact relative
  // timestamps ("2m") advance without the user needing to interact.
  const [nowTick, setNowTick] = useState(() => Date.now())

  // Scroll-to-bottom affordance (MATRIX-P5c) — `isNearBottomRef` tracks
  // scroll position without triggering re-renders on every scroll event;
  // `showJumpToBottom` is the actual pill visibility.
  const timelineScrollRef = useRef(null)
  const isNearBottomRef = useRef(true)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)

  const clientRef = useRef(null)
  const timelineEndRef = useRef(null)
  const invitePopoverRef = useRef(null)
  // Room ids we've already fired a client.joinRoom() attempt for, so a slow
  // or in-flight auto-join doesn't get re-triggered on every refreshRooms()
  // call (sync/timeline/membership events all call it). Cleared on failure
  // so a transient error gets retried on the next refresh.
  const autoJoinAttemptedRef = useRef(new Set())

  // M-ROOMS: tracks whether the component is still mounted, so an
  // in-flight team-room provisioning poll (openEntityRoom below) can bail
  // out cleanly instead of calling setState after unmount.
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  // M-ROOMS: entity ids currently mid-flight through the agent/assistant
  // "start chat" createRoom path in openEntityRoom, so a fast double-click
  // (or two overlapping calls before refreshRooms() picks up the new room)
  // can't fire two createRoom requests for the same entity.
  const openingEntityRef = useRef(new Set())

  const refreshRooms = useCallback(() => {
    const client = clientRef.current
    if (!client) return
    const all = client.getRooms()
    // Defensive fix (M-P4 bug): only hide rooms in states that should never
    // show in the main list. A strict `=== 'join'` equality previously
    // dropped any room whose membership read as anything else, even
    // transiently — see the file-header BUG FIX note.
    const joined = all.filter((r) => !HIDDEN_FROM_MAIN_LIST.has(r.getMyMembership()))
    joined.sort((a, b) => (b.getLastActiveTimestamp?.() || 0) - (a.getLastActiveTimestamp?.() || 0))
    setRooms(joined)

    const selfUserId = client.getUserId?.()
    const invited = all.filter((r) => r.getMyMembership() === 'invite')
    const manualInvites = []
    for (const room of invited) {
      if (isProvisionedInviteRoom(room, selfUserId)) {
        // M-ROOMS auto-join fix: silently accept Quox-provisioned invites so
        // they show up as normal named, joined rooms with no Accept/Decline
        // step. Fire-and-forget, never throw — a failed auto-join just falls
        // back to the manual Invitations list below on the next refresh.
        if (!autoJoinAttemptedRef.current.has(room.roomId)) {
          autoJoinAttemptedRef.current.add(room.roomId)
          try {
            client.joinRoom(room.roomId).catch((err) => {
              console.warn(`[MatrixCommsView] auto-join failed for provisioned room ${room.roomId}:`, err?.message || err)
              autoJoinAttemptedRef.current.delete(room.roomId)
            })
          } catch (err) {
            console.warn(`[MatrixCommsView] auto-join threw for provisioned room ${room.roomId}:`, err?.message || err)
            autoJoinAttemptedRef.current.delete(room.roomId)
          }
        }
        continue
      }
      manualInvites.push(room)
    }
    manualInvites.sort((a, b) => (a.name || a.roomId).localeCompare(b.name || b.roomId))
    setInviteRooms(manualInvites)
  }, [])

  const loadTimeline = useCallback((roomId) => {
    const client = clientRef.current
    if (!client || !roomId) { setEvents([]); return }
    const room = client.getRoom(roomId)
    if (!room) { setEvents([]); return }
    setEvents(room.getLiveTimeline().getEvents().slice())
  }, [])

  // Init the matrix-js-sdk client for the CURRENT org. Re-runs on org
  // switch (M-ISO): getMatrixClient(orgId) tears down the previous org's
  // client and logs in fresh as the new org's identity, so we also reset
  // the room UI state here rather than showing the old org's rooms while
  // the new sync warms up. Waits until the workspace has resolved an org;
  // the token mint needs the org id on per-org servers.
  useEffect(() => {
    const bootOrgId = currentOrg?.id || null
    if (!bootOrgId) return undefined

    let cancelled = false
    let client = null

    // Clear any previous org's client state before (re)booting. No-op on
    // the initial mount (these are the initial state values already).
    clientRef.current = null
    setStatus('connecting')
    setError(null)
    setRooms([])
    setInviteRooms([])
    setSelectedRoomId(null)
    setEvents([])

    async function boot() {
      try {
        client = await getMatrixClient(bootOrgId)
        if (cancelled) return
        clientRef.current = client

        const onSyncStateChange = (state) => {
          if (cancelled) return
          if (state === 'PREPARED' || state === 'SYNCING') {
            setStatus('ready')
            refreshRooms()
          } else if (state === 'ERROR') {
            setStatus('error')
            setError('Matrix sync error — check the homeserver connection.')
          }
        }
        client.on('sync', onSyncStateChange)

        const onTimeline = (event, room) => {
          if (cancelled || !room) return
          refreshRooms()
          // Any agent message landing clears this room's "thinking" pill —
          // see the pendingAgentReply doc comment above.
          if (event?.getType?.() === 'm.room.message' && isAgentUserId(event.getSender?.())) {
            setPendingAgentReply((cur) => {
              if (cur && cur.roomId === room.roomId) {
                if (pendingAgentTimeoutRef.current) {
                  clearTimeout(pendingAgentTimeoutRef.current)
                  pendingAgentTimeoutRef.current = null
                }
                return null
              }
              return cur
            })
          }
          setSelectedRoomId((current) => {
            if (current && room.roomId === current) {
              loadTimeline(current)
            }
            return current
          })
        }
        client.on('Room.timeline', onTimeline)

        // Reaction / redaction events bump a version counter so the
        // reaction-chip memo recomputes — remote echo arrives via
        // `Room.timeline` (already covered by onTimeline above for the
        // messages list, but that only fires for the currently-selected
        // room's `events` state), local echo (the sender's own optimistic
        // reaction) arrives via `Room.localEchoUpdated` instead, which
        // never touches `events`. Both funnel into the same counter here.
        const onRelationEvent = (event) => {
          if (cancelled) return
          const type = event?.getType?.()
          if (type === 'm.reaction' || type === 'm.room.redaction') {
            setReactionsVersion((v) => v + 1)
          }
        }
        client.on('Room.timeline', onRelationEvent)
        client.on('Room.localEchoUpdated', onRelationEvent)

        // Membership changes (invites, joins, leaves — including an agent
        // auto-joining after an invite) refresh the room lists and the
        // selected room's member chips.
        const onMembership = () => {
          if (cancelled) return
          refreshRooms()
          setMembersVersion((v) => v + 1)
        }
        client.on('RoomMember.membership', onMembership)

        // Presence updates for the People panel (agents are always-online
        // and don't need this — only humans' dots depend on it).
        const onPresence = () => {
          if (cancelled) return
          setPresenceVersion((v) => v + 1)
        }
        client.on('User.presence', onPresence)

        // Read receipts (ours or another member's) are the one thing that
        // changes a room's unread notification count without a new
        // `Room.timeline` event landing (e.g. marking a room read on
        // another client/device); bump the tab-bar unread bubble memo.
        const onReceipt = () => {
          if (cancelled) return
          setUnreadVersion((v) => v + 1)
        }
        client.on('Room.receipt', onReceipt)

        // Room tag changes (m.favourite added/removed, here or on another
        // device) re-render the favourites tab and star states (ROOMS-FAV).
        const onRoomTags = () => {
          if (cancelled) return
          setFavouritesVersion((v) => v + 1)
        }
        client.on('Room.tags', onRoomTags)

        // Typing notifications (MATRIX-P5c) — matrix-js-sdk emits
        // `RoomMember.typing` globally per member whose typing state
        // changed; recompute the typing roster for whichever room is
        // CURRENTLY selected (read via the same "peek at latest state
        // inside a setState updater" pattern `onTimeline` above uses, so
        // this listener doesn't need `selectedRoomId` as a dependency and
        // never needs to be re-subscribed). Covers humans/bridged users AND
        // agents: the appservice sends native m.typing while an agent's
        // reply turn is in flight (responder.js M-TYPING), so an agent
        // mid-turn appears in this roster too.
        const onTyping = (event, member) => {
          if (cancelled) return
          setSelectedRoomId((current) => {
            if (current && member.roomId === current) {
              const room = client.getRoom(current)
              const selfId = client.getUserId()
              const ids = room
                ? room.getMembers().filter((m) => m.typing && m.userId !== selfId).map((m) => m.userId)
                : []
              setTypingUserIds(ids)
            }
            return current
          })
        }
        client.on('RoomMember.typing', onTyping)

        // Already synced by the time we attach listeners? Pick it up.
        if (client.isInitialSyncComplete?.()) {
          setStatus('ready')
          refreshRooms()
        }

        return () => {
          client.removeListener('sync', onSyncStateChange)
          client.removeListener('Room.timeline', onTimeline)
          client.removeListener('Room.timeline', onRelationEvent)
          client.removeListener('Room.localEchoUpdated', onRelationEvent)
          client.removeListener('RoomMember.membership', onMembership)
          client.removeListener('User.presence', onPresence)
          client.removeListener('Room.receipt', onReceipt)
          client.removeListener('Room.tags', onRoomTags)
          client.removeListener('RoomMember.typing', onTyping)
        }
      } catch (err) {
        if (!cancelled) {
          // QUOXCHAT-PRO Matrix-less handoff: a deployment with no Matrix
          // stack 404s the token mint (typed MatrixNotConfiguredError).
          // That is a configuration state, not a fault: render the
          // friendly full-view empty state instead of the error banner.
          if (err?.code === 'MATRIX_NOT_CONFIGURED') {
            setStatus('unconfigured')
            setError(null)
          } else {
            setStatus('error')
            setError(err.message || 'Failed to connect to Matrix')
          }
        }
      }
    }

    let cleanup
    boot().then((fn) => { cleanup = fn })

    return () => {
      cancelled = true
      if (cleanup) cleanup()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg?.id])

  // Load timeline whenever selected room changes
  useEffect(() => {
    loadTimeline(selectedRoomId)
  }, [selectedRoomId, loadTimeline])

  // Auto-scroll to bottom on new events — but only when the user was
  // already near the bottom (don't yank someone reading scrollback back
  // down); otherwise surface the "↓ new messages" pill instead.
  useEffect(() => {
    if (isNearBottomRef.current) {
      timelineEndRef.current?.scrollIntoView({ block: 'end' })
    } else if (events.length > 0) {
      setShowJumpToBottom(true)
    }
    // typingUserIds.length: the in-timeline typing row appears at the very
    // bottom of the scroll area, keep it in view like a new message.
  }, [events, typingUserIds.length])

  // Reset scroll-affordance + typing-roster state whenever the selected
  // room changes; seed the typing roster from the newly-selected room's
  // current member state in case someone was already typing before we
  // switched in.
  useEffect(() => {
    isNearBottomRef.current = true
    setShowJumpToBottom(false)
    const client = clientRef.current
    if (!client || !selectedRoomId) { setTypingUserIds([]); return }
    const room = client.getRoom(selectedRoomId)
    const selfId = client.getUserId()
    setTypingUserIds(
      room ? room.getMembers().filter((m) => m.typing && m.userId !== selfId).map((m) => m.userId) : []
    )
  }, [selectedRoomId])

  // Send outgoing typing notifications while the local user is composing,
  // debounced so every keystroke doesn't hit the homeserver — at most one
  // `sendTyping(true)` per 3s while actively typing, and an automatic
  // `sendTyping(false)` if the composer goes quiet for 4s.
  useEffect(() => {
    const client = clientRef.current
    if (!client || !selectedRoomId || !draft.trim()) return undefined
    const now = Date.now()
    if (now - typingLastSentRef.current > 3000) {
      typingLastSentRef.current = now
      client.sendTyping(selectedRoomId, true, 5000).catch(() => {})
    }
    if (typingStopTimeoutRef.current) clearTimeout(typingStopTimeoutRef.current)
    typingStopTimeoutRef.current = setTimeout(() => {
      client.sendTyping(selectedRoomId, false, 0).catch(() => {})
      typingLastSentRef.current = 0
    }, 4000)
    return undefined
  }, [draft, selectedRoomId])

  // Tell the room we've stopped typing when leaving it (switch room / send
  // / unmount) — cleanup fires before the next effect run on a dependency
  // change, so this covers all three cases.
  useEffect(() => {
    return () => {
      if (typingStopTimeoutRef.current) clearTimeout(typingStopTimeoutRef.current)
      const client = clientRef.current
      if (client && selectedRoomId) client.sendTyping(selectedRoomId, false, 0).catch(() => {})
    }
  }, [selectedRoomId])

  // UI-only clock tick (30s) so compact relative timestamps ("2m") advance
  // without a data refetch.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])

  // Clear the "thinking" timeout on unmount.
  useEffect(() => {
    return () => {
      if (pendingAgentTimeoutRef.current) clearTimeout(pendingAgentTimeoutRef.current)
    }
  }, [])

  // Auto-collapse the People panel on narrow viewports — but never fight a
  // manual toggle once the user has made one.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(max-width: 1160px)')
    const onChange = (e) => {
      if (!peopleManualRef.current) setPeopleCollapsedState(e.matches)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const togglePeopleCollapsed = useCallback(() => {
    peopleManualRef.current = true
    setPeopleCollapsedState((v) => !v)
  }, [])

  // Scroll-to-bottom affordance (MATRIX-P5c).
  const handleTimelineScroll = useCallback(() => {
    const el = timelineScrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distanceFromBottom < 120
    isNearBottomRef.current = nearBottom
    if (nearBottom) setShowJumpToBottom(false)
  }, [])

  const scrollToBottom = useCallback(() => {
    timelineEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
    isNearBottomRef.current = true
    setShowJumpToBottom(false)
  }, [])

  const selfUserId = clientRef.current?.getUserId?.() || null

  const selectedRoom = useMemo(
    () => (clientRef.current && selectedRoomId ? clientRef.current.getRoom(selectedRoomId) : null),
    [selectedRoomId, events]
  )

  // membersVersion: a 1:1 room's resolved title depends on the other
  // member's identity, which can update after the initial join (e.g. an
  // agent joining an invite, or a human's profile displayname syncing in).
  const selectedRoomTitle = useMemo(
    () => roomDisplayTitle(selectedRoom, selfUserId, clientRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedRoom, selfUserId, membersVersion]
  )

  // Whether the selected room is an incoming website chat (QUOXCHAT-PRO
  // P2): drives the header "Website visitor" pill and the composer
  // placeholder so operators know who they are talking to.
  const selectedRoomIsQuoxchat = useMemo(
    () => quoxRoomNodeType(selectedRoom) === 'quoxchat',
    [selectedRoom]
  )

  const selectedMembers = useMemo(() => {
    if (!selectedRoom) return []
    return selectedRoom.getJoinedMembers()
      .slice()
      .sort((a, b) => (a.name || a.userId).localeCompare(b.name || b.userId))
    // membersVersion is an intentional dependency — RoomMember.membership
    // events don't otherwise trigger a re-render of this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoom, membersVersion])

  // Room count per tab bucket (CORECOMM-UX #190), computed off the full
  // joined-room list (not the tab-filtered one) so switching tabs doesn't
  // change the other tabs' counts.
  // Scope the room list to the active org. A provisioned room carries
  // ai.quox.room.org_id; a room with no such state (manual room, DM, bridged)
  // is not org-scoped and is always shown. Everything downstream (counts,
  // tabs, sections) runs off scopedRooms so switching the active org actually
  // changes which rooms are on offer.
  const scopedRooms = useMemo(() => {
    const activeOrgId = currentOrg?.id || null
    return rooms.filter((room) => {
      const orgId = quoxRoomOrgId(room)
      return !orgId || orgId === activeOrgId
    })
  }, [rooms, currentOrg?.id])

  const roomTabCounts = useMemo(() => {
    const counts = {}
    for (const room of scopedRooms) {
      const bucket = roomTypeBucket(room, selfUserId)
      counts[bucket] = (counts[bucket] || 0) + 1
      // Bridge tabs are overlay buckets (like favourites): a bridged room
      // counts toward its bridge tab AND its normal type bucket above.
      const bridge = roomBridgeTab(room, selfUserId)
      if (bridge) counts[bridge] = (counts[bridge] || 0) + 1
    }
    return counts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedRooms, selfUserId, membersVersion])

  // Favourited rooms (ROOMS-FAV): scoped rooms carrying the m.favourite tag.
  const favouriteRooms = useMemo(
    () => scopedRooms.filter((room) => isFavouriteRoom(room)),
    // favouritesVersion is an intentional dependency: Room.tags events do
    // not change the `rooms` array reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopedRooms, favouritesVersion]
  )

  // Only surface tabs that have at least one room, plus 'all' (always shown)
  // and 'public' (always shown, disabled/greyed "SOON" placeholder).
  const visibleRoomTabs = useMemo(
    // The entity tabs (agents / assistants / agentic_team) are always shown:
    // they list the full registry roster, not just rooms, so they are useful
    // even with zero existing rooms. 'all', 'favourites' and 'public' are
    // always shown too: favourites is a primary control whose contents the
    // star toggles change live.
    // 'quoxchat' is always shown too (QUOXCHAT-PRO P2): website chats
    // arrive asynchronously, the empty tab tells operators where they land.
    () => ROOM_TABS.filter((t) =>
      t.id === 'all' || t.id === 'favourites' || t.id === 'public' ||
      t.id === 'agents' || t.id === 'assistants' || t.id === 'agentic_team' ||
      t.id === 'quoxchat' ||
      // Dev Slots always shown: slot rooms arrive when a slot is checked out;
      // an always-visible tab (with its how-to empty state) advertises the
      // surface so operators remember slots exist before creating one.
      t.id === 'dev_slot' ||
      // Bridge tabs always shown (owner ask): bridged rooms arrive
      // asynchronously; the empty tab documents the surface.
      t.id === 'telegram' || t.id === 'slack' ||
      (roomTabCounts[t.id] || 0) > 0
    ),
    [roomTabCounts]
  )

  // Per-tab unread bubble (owner ask, CORECOMM-UX #190b): sum of each
  // bucket's rooms' unread notification counts. `rooms` already gets a new
  // array reference on every `Room.timeline` event (via refreshRooms(),
  // wired below), which covers new-message increases; `unreadVersion` bumps
  // on `Room.receipt` (marking a room read), the one path that changes
  // unread counts without a new timeline event landing.
  const roomTabUnread = useMemo(() => {
    const counts = {}
    for (const room of scopedRooms) {
      const bucket = roomTypeBucket(room, selfUserId)
      const unread = room?.getUnreadNotificationCount?.() || 0
      if (unread > 0) {
        counts[bucket] = (counts[bucket] || 0) + unread
        // Favourites is an overlay bucket, not a node_type: a favourited
        // room counts toward its type tab AND the favourites tab.
        if (isFavouriteRoom(room)) counts.favourites = (counts.favourites || 0) + unread
        // Bridge tabs are overlays too: unread in a bridged room lights the
        // Telegram/Slack tab's red dot alongside its type tab's.
        const bridge = roomBridgeTab(room, selfUserId)
        if (bridge) counts[bridge] = (counts[bridge] || 0) + unread
      }
    }
    return counts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedRooms, selfUserId, membersVersion, unreadVersion, favouritesVersion])

  // QuoxChat attention rollup (QUOXCHAT-PRO P2, owner ask). Two numbers:
  // `bubbleCount` feeds the tab's NUMERIC amber bubble (total unread across
  // quoxchat rooms; a waiting room with zero unread still contributes 1 so
  // the bubble never reads clear while a customer waits), `waitingRooms` is
  // the number of rooms where a customer is waiting on a reply (unread > 0
  // OR the visitor puppet spoke last, see lastMessageSender), feeding the
  // header "N waiting" pill and the document.title "(N) " prefix.
  // `scopedRooms` gets a new reference on every refreshRooms() (timeline
  // events); `unreadVersion` covers read receipts, the one path that
  // changes unread without a new timeline event.
  const quoxchatAttention = useMemo(() => {
    let bubbleCount = 0
    let waitingRooms = 0
    for (const room of scopedRooms) {
      if (quoxRoomNodeType(room) !== 'quoxchat') continue
      const unread = room?.getUnreadNotificationCount?.() || 0
      const waiting = unread > 0 || isVisitorUserId(lastMessageSender(room))
      if (waiting) waitingRooms += 1
      bubbleCount += Math.max(unread, waiting ? 1 : 0)
    }
    return { bubbleCount, waitingRooms }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedRooms, unreadVersion])

  // Title-bar attention (QUOXCHAT-PRO P2): while any quoxchat room is
  // waiting, prefix document.title with "(N) "; restore the base title when
  // none are (and on unmount). The base title is captured once at mount,
  // nothing else in this view writes document.title.
  const baseTitleRef = useRef(typeof document !== 'undefined' ? document.title : '')
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const base = baseTitleRef.current
    document.title = quoxchatAttention.waitingRooms > 0
      ? `(${quoxchatAttention.waitingRooms}) ${base}`
      : base
    return () => { document.title = base }
  }, [quoxchatAttention.waitingRooms])

  // Rooms after the active tab's filter (CORECOMM-UX #190), order is
  // untouched, so refreshRooms()'s last-activity sort still applies within
  // the filtered set.
  const visibleRooms = useMemo(() => {
    if (activeTab === 'all') return scopedRooms
    if (activeTab === 'favourites') return favouriteRooms
    // Bridge tabs filter by member-namespace overlay (roomBridgeTab), not by
    // node_type bucket: a bridged room keeps its normal grouping in 'all'.
    if (activeTab === 'telegram' || activeTab === 'slack') {
      return scopedRooms.filter((room) => roomBridgeTab(room, selfUserId) === activeTab)
    }
    return scopedRooms.filter((room) => roomTypeBucket(room, selfUserId) === activeTab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedRooms, favouriteRooms, activeTab, selfUserId, membersVersion])

  // Group the joined-room list into Agent rooms / Team channels / DMs
  // (STREAM_MATRIX_BEGINS.md §6). Rooms already arrive sorted by last
  // activity from refreshRooms(), so per-group order is preserved. Grouped
  // off visibleRooms so the type tab bar's filter applies here too.
  const roomGroups = useMemo(() => {
    const groups = {}
    for (const room of visibleRooms) {
      let bucket = roomTypeBucket(room, selfUserId)
      // Bridged rooms get their own branded Telegram / Slack sections
      // (owner ask): anything that would land in the catch-all buckets
      // ('other' group rooms, bridged 1:1 'direct' rooms) regroups under
      // its bridge. "Other" is left for genuinely unclassifiable rooms.
      if (bucket === 'other' || bucket === 'direct') {
        const bridge = roomBridgeTab(room, selfUserId)
        if (bridge) bucket = bridge
      }
      ;(groups[bucket] = groups[bucket] || []).push(room)
    }
    return groups
    // membersVersion: room membership (and therefore classification) can
    // change without a new room being added, e.g. an agent joining after
    // an invite.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRooms, selfUserId, membersVersion])

  // ── Roster: fill the entity tabs from the registry ─────────────────────────
  // The Agents / Assistants / Agentic Teams tabs list ALL registry entities,
  // not only the ones that already have a room. Core agents vs custom
  // assistants split by ownership.source; teams fetched from the task service.
  const coreAgents = useMemo(() => listAssistants({ source: 'core', sortBy: 'name' }), [])
  const customAssistants = useMemo(
    () => listAssistants({ sortBy: 'name' }).filter((a) => (a.ownership?.source || 'core') !== 'core'),
    []
  )
  useEffect(() => {
    let live = true
    listTeams(authFetch)
      .then((res) => {
        if (!live) return
        const list = Array.isArray(res) ? res : (res?.teams || res?.data || [])
        setTeams(Array.isArray(list) ? list : [])
      })
      .catch(() => { if (live) setTeams([]) })
    return () => { live = false }
  }, [authFetch, currentOrg?.id])

  // Map existing scoped rooms to the registry id they represent, so a roster
  // entity that already has a room renders as its real room row.
  const roomByAgentId = useMemo(() => {
    const map = {}
    for (const room of scopedRooms) {
      const bare = roomAgentBareId(room, selfUserId)
      if (bare && !map[bare]) map[bare] = room
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedRooms, selfUserId, membersVersion])
  const roomByTeamId = useMemo(() => {
    const map = {}
    for (const room of scopedRooms) {
      const c = room.currentState?.getStateEvents?.('ai.quox.room', '')?.getContent?.()
      if (c?.node_type === 'agentic_team' && c?.node_id && !map[c.node_id]) map[c.node_id] = room
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedRooms, membersVersion])

  // Roster sizes for the entity-tab counts (all agents / assistants / teams,
  // not just the ones with a room).
  const rosterCounts = useMemo(() => ({
    agents: coreAgents.length,
    assistants: customAssistants.length,
    agentic_team: (teams || []).length,
  }), [coreAgents, customAssistants, teams])

  // The roster list for the active entity tab (null for room-list tabs).
  const activeRoster = useMemo(() => {
    if (activeTab === 'agents') return coreAgents.map((e) => ({ entity: e, kind: 'agent' }))
    if (activeTab === 'assistants') return customAssistants.map((e) => ({ entity: e, kind: 'assistant' }))
    if (activeTab === 'agentic_team') return (teams || []).map((e) => ({ entity: e, kind: 'team' }))
    return null
  }, [activeTab, coreAgents, customAssistants, teams])

  // Flat, sorted room list for the 'recent' / 'alpha' sort modes.
  const flatRooms = useMemo(() => {
    if (roomSort === 'alpha') {
      return [...visibleRooms].sort((a, b) =>
        roomDisplayTitle(a, selfUserId, clientRef.current).localeCompare(roomDisplayTitle(b, selfUserId, clientRef.current)))
    }
    return visibleRooms
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRooms, roomSort, selfUserId, membersVersion])

  const openEntityRoom = useCallback(async (entity, kind) => {
    const client = clientRef.current
    if (!client) return
    if (kind === 'team') {
      const existing = roomByTeamId[entity.id]
      if (existing) { setSelectedRoomId(existing.roomId); return }
      const teamName = entity.name || 'Team'
      // M-ROOMS: the team has no room yet, so kick off server-side
      // provisioning instead of dead-ending on an error, then poll for the
      // room to land (the appservice provisions it asynchronously). No
      // dedicated info/status banner exists on this view, so this reuses
      // the error banner for a neutral, non-error status message; it is
      // overwritten below once the room appears or the poll gives up.
      setNotice(`Provisioning ${teamName} room, it will appear shortly...`)
      try {
        await provisionTeamRoom(authFetch, entity.id)
      } catch (err) {
        if (mountedRef.current) setError(err.message || `Failed to provision ${teamName} room`)
        return
      }
      const POLL_ATTEMPTS = 5
      const POLL_INTERVAL_MS = 2000
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        if (!mountedRef.current) return
        refreshRooms()
        const liveClient = clientRef.current
        if (!liveClient) return
        const found = findLiveTeamRoom(liveClient, entity.id)
        if (found) {
          if (mountedRef.current) {
            setSelectedRoomId(found.roomId)
            setNotice(null)
          }
          return
        }
      }
      if (mountedRef.current) {
        setNotice(`${teamName} room is being provisioned server-side, check back shortly`)
      }
      return
    }
    const existing = roomByAgentId[entity.id]
    if (existing) { setSelectedRoomId(existing.roomId); return }
    // M-ROOMS start-chat dedup (a): an in-flight guard so a fast
    // double-click can't fire two createRoom calls for the same entity
    // before refreshRooms() has a chance to populate roomByAgentId.
    if (openingEntityRef.current.has(entity.id)) return
    openingEntityRef.current.add(entity.id)
    const puppet = entityPuppetId(entity)
    if (!puppet) { openingEntityRef.current.delete(entity.id); return }
    try {
      // M-ROOMS start-chat dedup (b): a deterministic room alias derived
      // from both user localparts, so a second createRoom for the same
      // pair (e.g. a race between two tabs) hits the homeserver's alias
      // uniqueness check (M_ROOM_IN_USE) instead of creating a duplicate
      // DM room.
      const selfUserIdLive = client.getUserId?.() || ''
      const { local: selfLocal, server } = splitUserId(selfUserIdLive)
      const { local: puppetLocal } = splitUserId(puppet)
      const alias = `quox-dm-${sanitizeAliasPart(selfLocal)}-${sanitizeAliasPart(puppetLocal)}`
      let roomId
      try {
        const created = await client.createRoom({
          name: entity.identity?.name || entity.name || entity.id,
          invite: [puppet],
          room_alias_name: alias,
        })
        roomId = created.room_id
      } catch (err) {
        const errcode = err?.errcode || err?.data?.errcode
        if (errcode === 'M_ROOM_IN_USE') {
          const existingRoomId = await client.getRoomIdForAlias(`#${alias}:${server}`)
            .then((res) => res?.room_id)
          if (!existingRoomId) throw err
          try {
            await client.joinRoom(existingRoomId)
          } catch {
            // Already joined (or joining) is fine, fall through to select it.
          }
          roomId = existingRoomId
        } else {
          throw err
        }
      }
      // M-ROOMS dead-DM heal: an adopted room can predate the puppet's
      // registration (the createRoom invite was silently dropped when the
      // puppet user did not exist yet), leaving a room with no agent member
      // that no amount of waiting fixes. If the puppet is not joined or
      // invited, re-invite it; the appservice auto-joins known personas.
      try {
        const membership = client.getRoom(roomId)?.getMember?.(puppet)?.membership
        if (membership !== 'join' && membership !== 'invite') {
          await client.invite(roomId, puppet)
        }
      } catch {
        // Best-effort: an invite race or power issue must not block opening.
      }
      refreshRooms()
      setSelectedRoomId(roomId)
    } catch (err) {
      setError(err.message || 'Failed to open chat')
    } finally {
      openingEntityRef.current.delete(entity.id)
    }
  }, [roomByAgentId, roomByTeamId, refreshRooms, authFetch])

  // Full registry roster (core + custom), shared by the invite-agent
  // popover, the people panel, and the row context menus. Declared before
  // the callbacks below that close over it.
  const allAgents = useMemo(() => listAssistants({ sortBy: 'name' }), [])

  // Toggle a room's m.favourite tag (ROOMS-FAV). Matrix-native per-room
  // account data on the homeserver: setRoomTag / deleteRoomTag, mirrored
  // back to room.tags by the SDK. The optimistic version bump makes the
  // star/tab flip immediately; the Room.tags sync echo confirms it.
  const toggleFavouriteRoom = useCallback(async (room) => {
    const client = clientRef.current
    if (!client || !room) return
    try {
      if (isFavouriteRoom(room)) {
        await client.deleteRoomTag(room.roomId, 'm.favourite')
      } else {
        await client.setRoomTag(room.roomId, 'm.favourite', { order: 0.5 })
      }
      setFavouritesVersion((v) => v + 1)
    } catch (err) {
      setError(err.message || 'Failed to update favourite')
    }
  }, [])

  // Resolve the registry entity behind an agent-puppet room member
  // (ROOMS-CTX): '@_quoxagent_a_<ulid>:quox' is a custom assistant,
  // '@_quoxagent_<slug>:quox' is a core agent.
  const memberEntityFor = useCallback((userId) => {
    const bare = extractAgentId(userId)
    if (!bare) return null
    const id = bare.startsWith('a_') ? bare.slice(2) : bare
    const entity = allAgents.find((a) => a.id === id)
    if (!entity) return null
    return { entity, kind: isUlid(id) ? 'assistant' : 'agent' }
  }, [allAgents])

  // Resolve the registry entity a room maps to (its ai.quox.room
  // default_agent or single agent member), for room-row context menus.
  const roomEntityFor = useCallback((room) => {
    const bare = roomAgentBareId(room, selfUserId)
    if (!bare) return null
    const entity = allAgents.find((a) => a.id === bare)
    if (!entity) return null
    return { entity, kind: isUlid(bare) ? 'assistant' : 'agent' }
  }, [allAgents, selfUserId])

  // ── Room operations (owner ask: useful LEFT-column menu actions) ─────────

  // Mark as read: send a read receipt on the room's latest event and clear
  // the local unread counters so the bubble drops immediately (the receipt
  // echo confirms it server-side).
  const markRoomRead = useCallback(async (room) => {
    const client = clientRef.current
    if (!client || !room) return
    try {
      const evs = room.getLiveTimeline?.()?.getEvents() || []
      const last = evs[evs.length - 1]
      if (last) await client.sendReadReceipt(last)
      room.setUnreadNotificationCount?.('total', 0)
      room.setUnreadNotificationCount?.('highlight', 0)
      setUnreadVersion((v) => v + 1)
    } catch (err) {
      setError(err.message || 'Failed to mark as read')
    }
  }, [])

  // Clear LOCAL history. Honest scope note: the Matrix client-server API has
  // no user-level bulk server-side deletion (per-event redaction needs power
  // levels; history purges are a homeserver admin API), so what the js-sdk
  // supports here is resetting the locally cached live timeline
  // (Room.resetLiveTimeline). The menu item is labelled "Clear local
  // history" accordingly; scrollback can be re-paginated from the server.
  const clearRoomLocalHistory = useCallback((room) => {
    if (!room) return
    try {
      room.resetLiveTimeline?.()
      setSelectedRoomId((current) => {
        if (current === room.roomId) loadTimeline(current)
        return current
      })
      refreshRooms()
    } catch (err) {
      setError(err.message || 'Failed to clear local history')
    }
  }, [loadTimeline, refreshRooms])

  // Remove chat: leave the room, then forget it so it drops out of the
  // client's room list entirely. Guarded by the flyout's inline confirm.
  const removeRoom = useCallback(async (room) => {
    const client = clientRef.current
    if (!client || !room) return
    try {
      await client.leave(room.roomId)
      try {
        await client.forget(room.roomId)
      } catch {
        // Forget can race the leave echo; the room is already left, the
        // list refresh below hides it either way.
      }
      setSelectedRoomId((current) => (current === room.roomId ? null : current))
      refreshRooms()
    } catch (err) {
      setError(err.message || 'Failed to remove chat')
    }
  }, [refreshRooms])

  // Build the ENTITY context-menu items (ROOMS-CTX; now the RIGHT-column
  // agent menu + the left roster's directory rows). "View profile" routes
  // per entity kind: core agents have a dedicated detail route
  // (/agents/:agentId, AgentDetailView); custom assistants deep-link into
  // AssistantsView via its resolveAssistantRouteIntent location-state
  // contract. "Agent settings" deep-links the Settings assistants section
  // (settingsSections.js id 'account/assistants'). "Start chat" reuses
  // openEntityRoom (selects the existing room or creates the DM). The
  // favourite item was removed (owner ask: the row star already covers it).
  const buildRowMenuItems = useCallback((entityInfo, room) => {
    const items = []
    const entity = entityInfo?.entity
    const kind = entityInfo?.kind
    if (entity && kind !== 'team') {
      items.push({
        id: 'profile',
        label: 'View profile',
        icon: <ProfileIcon />,
        onClick: () => {
          if (kind === 'assistant') {
            navigate('/assistants', { state: { configureAssistant: true, assistantId: entity.id } })
          } else {
            navigate(`/agents/${entity.id}`)
          }
        },
      })
      items.push({
        id: 'settings',
        label: 'Agent settings',
        icon: <GearIcon />,
        onClick: () => navigate('/settings?section=account/assistants'),
      })
    }
    if (entity) {
      items.push({
        id: 'chat',
        label: room ? 'Open chat' : 'Start chat',
        icon: <ChatBubbleIcon />,
        onClick: () => openEntityRoom(entity, kind),
      })
    }
    return items
  }, [navigate, openEntityRoom])

  const openRowMenu = useCallback((x, y, entityInfo, room) => {
    const items = buildRowMenuItems(entityInfo, room)
    if (items.length === 0) return
    setCtxMenu({ x, y, items })
  }, [buildRowMenuItems])

  // LEFT-column room-row menu (owner ask): room operations, not entity
  // shortcuts. Favourites stay on the row star only (no duplicate item).
  const openRoomMenu = useCallback((x, y, room) => {
    if (!room) return
    setCtxMenu({
      x,
      y,
      items: [
        {
          id: 'read',
          label: 'Mark as read',
          icon: <CheckIcon />,
          onClick: () => markRoomRead(room),
        },
        {
          id: 'clear',
          label: 'Clear local history',
          icon: <EraserIcon />,
          onClick: () => clearRoomLocalHistory(room),
        },
        {
          id: 'remove',
          label: 'Remove chat',
          icon: <TrashIcon />,
          danger: true,
          confirm: true,
          confirmLabel: 'Sure? Leave and forget',
          onClick: () => removeRoom(room),
        },
      ],
    })
  }, [markRoomRead, clearRoomLocalHistory, removeRoom])

  // RIGHT-column human menu (owner ask): a small info flyout + a stubbed
  // Tags item. Agents keep the entity menu above.
  const openPersonMenu = useCallback((x, y, person) => {
    setCtxMenu({
      x,
      y,
      items: [
        {
          id: 'info',
          label: 'View info',
          icon: <InfoIcon />,
          onClick: () => setPersonInfo({ x, y, ...person }),
        },
        {
          id: 'tags',
          label: 'Tags (soon)',
          icon: <TagIcon />,
          disabled: true,
          onClick: () => {},
        },
      ],
    })
  }, [])

  const closeCtxMenu = useCallback(() => setCtxMenu(null), [])
  const closePersonInfo = useCallback(() => setPersonInfo(null), [])

  // QuoxChat Pro label signal (owner ask): the workspace org record already
  // carries a licence-tier field client-side (WorkspaceContext maps
  // org.plan, default 'free'), so a paid plan flips the label; any existing
  // quoxchat room is the belt-and-braces fallback signal (an org receiving
  // website chats has the Pro surface live regardless of the cached plan
  // field).
  const quoxchatPro = useMemo(() => {
    const plan = (currentOrg?.plan || 'free').toLowerCase()
    if (plan && plan !== 'free') return true
    return scopedRooms.some((room) => quoxRoomNodeType(room) === 'quoxchat')
  }, [currentOrg?.plan, scopedRooms])

  // Reset the invite-agent popover + the reaction picker + the mention
  // autocomplete whenever the selected room changes.
  useEffect(() => {
    setInviteAgentOpen(false)
    setInviteAgentSearch('')
    setInviteAgentStatus(null)
    setInvitingAgentId(null)
    setReactionPickerEventId(null)
    setMentionQuery(null)
    setMentionAnchorIndex(null)
  }, [selectedRoomId])

  const filteredAgents = useMemo(() => {
    const q = inviteAgentSearch.trim().toLowerCase()
    if (!q) return allAgents
    return allAgents.filter((a) => {
      const name = (a.identity?.name || a.id || '').toLowerCase()
      const role = (a.hierarchy?.role || '').toLowerCase()
      return name.includes(q) || role.includes(q) || a.id.toLowerCase().includes(q)
    })
  }, [allAgents, inviteAgentSearch])

  // Right-hand People panel roster — Agents (role sub-label from the
  // entity registry) and People (humans + bridged Telegram/Slack, with
  // presence dots). See STREAM header note (M-P5) on the human-presence
  // "unknown" fallback.
  const peopleRoster = useMemo(() => {
    const client = clientRef.current
    const agents = []
    const people = []
    for (const member of selectedMembers) {
      // Visitor puppets share the agent MXID namespace (QUOXCHAT-PRO P2)
      // but are customers: they roster under People with the teal origin
      // pill, never under Agents.
      const agentId = isVisitorUserId(member.userId) ? null : extractAgentId(member.userId)
      const displayName = resolveDisplayName(member.userId, { member, client })
      if (agentId) {
        const agentDef = allAgents.find((a) => a.id === agentId)
        const role = agentDef?.hierarchy?.role
        agents.push({
          member,
          displayName,
          subLabel: role ? role[0].toUpperCase() + role.slice(1) : 'Agent',
          avatarUrl: resolveAvatar(member.userId, { member, client, entity: agentDef }),
        })
      } else {
        const network = memberNetwork(member.userId)
        const presence = member.userId === selfUserId
          ? 'online'
          : (client?.getUser?.(member.userId)?.presence || null)
        people.push({
          member,
          displayName,
          network,
          // The bridged network now renders as a pill next to the name
          // (ROOMS-GREEN), so the sub-label stays role-ish for everyone.
          subLabel: member.userId === selfUserId ? 'You' : 'Member',
          presence,
          avatarUrl: resolveAvatar(member.userId, { member, client }),
        })
      }
    }
    return { agents, people }
    // presenceVersion: User.presence events don't otherwise re-trigger this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMembers, allAgents, selfUserId, presenceVersion])

  // Flat @-mention roster (chat-app polish) — every OTHER member of the
  // selected room, reduced to { userId, displayName, handle }. Self is
  // excluded (mentioning yourself isn't a real use case here). Feeds both
  // the message-body tokenizer (renderMessageBody) and the composer
  // autocomplete.
  const mentionCandidates = useMemo(() => {
    const all = [...peopleRoster.agents, ...peopleRoster.people]
    return all
      .filter(({ member }) => member.userId !== selfUserId)
      .map(({ member, displayName }) => ({
        userId: member.userId,
        displayName,
        handle: mentionHandleFor(displayName),
      }))
      .filter((c) => c.handle)
  }, [peopleRoster, selfUserId])

  // Group consecutive same-sender messages (Slack/Discord pattern) — avatar
  // + name + timestamp shown once per group, a short gap (5 min) or a
  // sender change starts a new group.
  const MESSAGE_GROUP_GAP_MS = 5 * 60 * 1000

  // Timeline items (ROOMS-GREEN): day-separator pills + centered system
  // lines (membership/state changes and HITL resolution receipts, see
  // syslineForEvent) + consecutive-sender message groups, in event order.
  // Day boundaries are checked at group/sysline starts only, a rollover
  // mid-group would need the same sender to post twice within the 5-minute
  // grouping gap while crossing midnight, rare enough not to special-case.
  const timelineItems = useMemo(() => {
    const client = clientRef.current
    const items = []
    let lastDayKey = null
    let currentGroup = null
    const pushDayIfNeeded = (ts) => {
      const dayKey = dayKeyFor(ts)
      if (dayKey !== lastDayKey) {
        items.push({ kind: 'day', key: `day-${dayKey}`, ts })
        lastDayKey = dayKey
      }
    }
    for (const ev of events) {
      const sysText = syslineForEvent(ev, client)
      if (sysText) {
        pushDayIfNeeded(ev.getTs())
        currentGroup = null
        items.push({ kind: 'sys', key: `sys-${ev.getId()}`, text: sysText })
        continue
      }
      if (ev.getType() !== 'm.room.message') continue
      const senderId = ev.getSender()
      const lastEv = currentGroup?.events[currentGroup.events.length - 1]
      if (currentGroup && currentGroup.senderId === senderId && lastEv && (ev.getTs() - lastEv.getTs()) < MESSAGE_GROUP_GAP_MS) {
        currentGroup.events.push(ev)
      } else {
        pushDayIfNeeded(ev.getTs())
        currentGroup = { senderId, events: [ev] }
        items.push({ kind: 'group', key: ev.getId(), group: currentGroup })
      }
    }
    return items
  }, [events])

  // Typing roster for the composer-area indicator — resolved to display
  // names via the same resolver used everywhere else in this view.
  const typingNames = useMemo(() => {
    if (!selectedRoom || typingUserIds.length === 0) return []
    return typingUserIds.map((id) => resolveDisplayName(id, { member: selectedRoom.getMember(id), client: clientRef.current }))
  }, [selectedRoom, typingUserIds])

  const typingLabel = useMemo(() => {
    if (typingNames.length === 0) return ''
    if (typingNames.length === 1) return `${typingNames[0]} is typing`
    if (typingNames.length === 2) return `${typingNames[0]} and ${typingNames[1]} are typing`
    return `${typingNames.length} people are typing`
  }, [typingNames])

  // Label for the local "thinking" approximation — see pendingAgentReply doc
  // comment above.
  const thinkingLabel = useMemo(() => {
    if (!pendingAgentReply || pendingAgentReply.roomId !== selectedRoomId) return ''
    // An agent already in the native typing roster is showing its REAL
    // in-flight signal on the row above; drop it here so the same agent
    // never renders as "typing" and "thinking" simultaneously.
    const alreadyTyping = new Set(typingNames)
    const names = pendingAgentReply.names.filter((n) => !alreadyTyping.has(n))
    if (names.length === 0) return ''
    if (names.length === 1) return `${names[0]} is thinking`
    if (names.length === 2) return `${names[0]} and ${names[1]} are thinking`
    return `${names.length} agents are thinking`
  }, [pendingAgentReply, selectedRoomId, typingNames])

  // Candidate matches for the composer's @-mention autocomplete — filtered
  // by whatever's been typed after the "@" so far (empty query shows
  // everyone, up to a small cap).
  const mentionAutocompleteMatches = useMemo(() => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    if (!q) return mentionCandidates.slice(0, 6)
    return mentionCandidates
      .filter((c) => c.handle.toLowerCase().startsWith(q) || c.displayName.toLowerCase().startsWith(q))
      .slice(0, 6)
  }, [mentionQuery, mentionCandidates])

  // Reaction aggregation per visible message, computed once per render pass
  // (not per-message-per-render) from the SDK's own `room.relations`
  // container — see `getReactionsForEvent`. Recomputes only when the
  // timeline events change, the selected room changes, or a reaction/
  // redaction bumps `reactionsVersion`; nothing here refetches from Matrix.
  const reactionsByEventId = useMemo(() => {
    const map = new Map()
    if (!selectedRoom) return map
    for (const ev of events) {
      if (ev.getType() !== 'm.room.message') continue
      map.set(ev.getId(), getReactionsForEvent(selectedRoom, ev.getId(), selfUserId))
    }
    return map
    // reactionsVersion is an intentional dependency — reaction/redaction
    // events don't otherwise re-trigger this memo (they don't change
    // `events`, the m.room.message list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoom, events, selfUserId, reactionsVersion])

  // Add a reaction, or toggle (redact) one of the current user's own
  // reactions — one click from the emoji picker or an existing chip.
  const handleToggleReaction = useCallback(async (eventId, emoji) => {
    const client = clientRef.current
    const room = selectedRoom
    if (!client || !room) return
    setReactionPickerEventId(null)
    const existing = getReactionsForEvent(room, eventId, selfUserId).find((r) => r.key === emoji)
    try {
      if (existing?.reacted && existing.selfEventId) {
        await client.redactEvent(room.roomId, existing.selfEventId)
      } else {
        await client.sendEvent(room.roomId, 'm.reaction', {
          'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key: emoji },
        })
      }
    } catch (err) {
      setError(err.message || 'Failed to react')
    }
  }, [selectedRoom, selfUserId])

  // Close the invite-agent popover on an outside click or Escape (matches
  // the reaction picker's convention just below — its trigger button is
  // excluded so the toggle click itself doesn't immediately re-close it).
  useEffect(() => {
    if (!inviteAgentOpen) return undefined
    const onDocMouseDown = (e) => {
      if (e.target.closest?.('.mc-invite-popover') || e.target.closest?.('.mc-invite-agent-btn')) return
      setInviteAgentOpen(false)
    }
    const onKeyDown = (e) => { if (e.key === 'Escape') setInviteAgentOpen(false) }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [inviteAgentOpen])

  // Close the reaction picker on an outside click or Escape.
  useEffect(() => {
    if (!reactionPickerEventId) return undefined
    const onDocMouseDown = (e) => {
      if (e.target.closest?.('.mc-reaction-picker') || e.target.closest?.('.mc-react-add-btn')) return
      setReactionPickerEventId(null)
    }
    const onKeyDown = (e) => { if (e.key === 'Escape') setReactionPickerEventId(null) }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [reactionPickerEventId])

  const handleAcceptInvite = useCallback(async (roomId) => {
    const client = clientRef.current
    if (!client) return
    try {
      await client.joinRoom(roomId)
      refreshRooms()
      setSelectedRoomId(roomId)
    } catch (err) {
      setError(err.message || 'Failed to accept invite')
    }
  }, [refreshRooms])

  const handleDeclineInvite = useCallback(async (roomId) => {
    const client = clientRef.current
    if (!client) return
    try {
      await client.leave(roomId)
      refreshRooms()
      setSelectedRoomId((current) => (current === roomId ? null : current))
    } catch (err) {
      setError(err.message || 'Failed to decline invite')
    }
  }, [refreshRooms])

  const handleOpenNewRoom = useCallback(() => {
    setNewRoomName('')
    setNewRoomError(null)
    setNewRoomOpen(true)
  }, [])

  const handleCreateRoom = useCallback(async () => {
    const client = clientRef.current
    const name = newRoomName.trim()
    if (!client || !name || creatingRoom) return
    setCreatingRoom(true)
    setNewRoomError(null)
    try {
      const { room_id: roomId } = await client.createRoom({ name })
      refreshRooms()
      setSelectedRoomId(roomId)
      setNewRoomOpen(false)
      setNewRoomName('')
    } catch (err) {
      setNewRoomError(err.message || 'Failed to create room')
    } finally {
      setCreatingRoom(false)
    }
  }, [newRoomName, creatingRoom, refreshRooms])

  const handleInviteAgent = useCallback(async (agentId) => {
    const client = clientRef.current
    if (!client || !selectedRoomId || invitingAgentId) return
    setInvitingAgentId(agentId)
    setInviteAgentStatus(null)
    const agentUserId = `${AGENT_USER_PREFIX}${agentId}${AGENT_USER_DOMAIN}`
    try {
      await client.invite(selectedRoomId, agentUserId)
      const agent = allAgents.find((a) => a.id === agentId)
      setInviteAgentStatus({ type: 'success', text: `Invited ${agent?.identity?.name || agentId}` })
    } catch (err) {
      setInviteAgentStatus({ type: 'error', text: err.message || 'Failed to invite agent' })
    } finally {
      setInvitingAgentId(null)
    }
  }, [selectedRoomId, invitingAgentId, allAgents])

  const handleSend = useCallback(async () => {
    const body = draft.trim()
    if (!body || !selectedRoomId || !clientRef.current || sending) return
    setSending(true)
    // Stop any in-flight typing notification immediately — no reason to
    // keep showing "typing…" to others once the message is already sent.
    if (typingStopTimeoutRef.current) clearTimeout(typingStopTimeoutRef.current)
    typingLastSentRef.current = 0
    clientRef.current.sendTyping(selectedRoomId, false, 0).catch(() => {})
    try {
      await clientRef.current.sendTextMessage(selectedRoomId, body)
      setDraft('')
      setMentionQuery(null)
      setMentionAnchorIndex(null)
      // Local "thinking" approximation (see pendingAgentReply doc comment) —
      // if this room has an agent member, assume it's about to reply.
      const room = clientRef.current.getRoom(selectedRoomId)
      // Visitor puppets are excluded (QUOXCHAT-PRO P2): a website customer
      // never shows as "thinking" after the operator replies.
      const agentMembers = (room?.getJoinedMembers() || [])
        .filter((m) => isAgentUserId(m.userId) && !isVisitorUserId(m.userId) && m.userId !== selfUserId)
      if (agentMembers.length > 0) {
        const names = agentMembers.map((m) => resolveDisplayName(m.userId, { member: m, client: clientRef.current }))
        if (pendingAgentTimeoutRef.current) clearTimeout(pendingAgentTimeoutRef.current)
        setPendingAgentReply({ roomId: selectedRoomId, names })
        pendingAgentTimeoutRef.current = setTimeout(() => setPendingAgentReply(null), 60000)
      }
    } catch (err) {
      setError(err.message || 'Failed to send message')
    } finally {
      setSending(false)
    }
  }, [draft, selectedRoomId, sending, selfUserId])

  // Upload one or more local files to the homeserver and post each as an
  // m.image / m.video / m.file event (msgtype by MIME class). Shared by the
  // composer attach button (file picker) and drag-and-drop onto the
  // timeline. Size-capped client-side; errors surface in the existing red
  // banner via setError.
  const handleAttachFiles = useCallback(async (fileList) => {
    const client = clientRef.current
    const files = Array.from(fileList || [])
    if (!client || !selectedRoomId || files.length === 0 || uploading) return
    const oversize = files.find((f) => f.size > MAX_UPLOAD_BYTES)
    if (oversize) {
      setError(`"${oversize.name}" is ${formatBytes(oversize.size)}. Attachments are capped at 25 MB.`)
      return
    }
    setUploading(true)
    setUploadPct(0)
    try {
      for (const file of files) {
        const mimetype = file.type || 'application/octet-stream'
        const upload = await client.uploadContent(file, {
          type: mimetype,
          name: file.name,
          progressHandler: ({ loaded, total }) => {
            if (total) setUploadPct(Math.round((loaded / total) * 100))
          }
        })
        const mxc = upload?.content_uri || (typeof upload === 'string' ? upload : null)
        if (!mxc) throw new Error('Upload returned no content URI')
        const info = { mimetype, size: file.size }
        let msgtype = 'm.file'
        if (mimetype.startsWith('image/')) {
          msgtype = 'm.image'
          const dims = await probeImageDimensions(file)
          if (dims?.w && dims?.h) {
            info.w = dims.w
            info.h = dims.h
          }
        } else if (mimetype.startsWith('video/')) {
          msgtype = 'm.video'
        }
        const eventContent = { msgtype, body: file.name, url: mxc, info }
        if (msgtype === 'm.file') eventContent.filename = file.name
        await client.sendEvent(selectedRoomId, 'm.room.message', eventContent)
      }
    } catch (err) {
      setError(err.message || 'Failed to upload attachment')
    } finally {
      setUploading(false)
      setUploadPct(null)
    }
  }, [selectedRoomId, uploading])

  const handleComposerKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (mentionQuery !== null && mentionAutocompleteMatches.length > 0) {
        e.preventDefault()
        completeMention(mentionAutocompleteMatches[0])
        return
      }
      e.preventDefault()
      handleSend()
    } else if (e.key === 'Escape' && mentionQuery !== null) {
      setMentionQuery(null)
      setMentionAnchorIndex(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleSend, mentionQuery, mentionAutocompleteMatches])

  // Composer onChange — tracks the draft AND whether the caret is currently
  // sitting mid-mention (an un-terminated "@word" with no whitespace since
  // the "@"), driving the autocomplete dropdown.
  const handleComposerChange = useCallback((e) => {
    const value = e.target.value
    setDraft(value)
    const caret = e.target.selectionStart
    if (caret == null) { setMentionQuery(null); setMentionAnchorIndex(null); return }
    const upto = value.slice(0, caret)
    const atIndex = upto.lastIndexOf('@')
    if (atIndex === -1) { setMentionQuery(null); setMentionAnchorIndex(null); return }
    const between = upto.slice(atIndex + 1)
    if (between.length > 24 || /\s/.test(between)) { setMentionQuery(null); setMentionAnchorIndex(null); return }
    setMentionQuery(between)
    setMentionAnchorIndex(atIndex)
  }, [])

  // Splice a completed "@Handle " into the draft in place of the in-progress
  // "@query" the user was typing, then re-focus the composer.
  const completeMention = useCallback((candidate) => {
    setDraft((prev) => {
      if (mentionAnchorIndex == null) return prev
      const caretGuess = mentionAnchorIndex + 1 + (mentionQuery?.length || 0)
      const before = prev.slice(0, mentionAnchorIndex)
      const after = prev.slice(caretGuess)
      return `${before}@${candidate.handle} ${after}`
    })
    setMentionQuery(null)
    setMentionAnchorIndex(null)
    requestAnimationFrame(() => composerInputRef.current?.focus())
  }, [mentionAnchorIndex, mentionQuery])

  // Click-to-mention (People panel row or a timeline sender) — append
  // "@Handle " to whatever's already in the composer and focus it.
  const handleInsertMention = useCallback((displayName) => {
    const handle = mentionHandleFor(displayName)
    if (!handle) return
    setDraft((prev) => {
      const needsSpace = prev.length > 0 && !/\s$/.test(prev)
      return `${prev}${needsSpace ? ' ' : ''}@${handle} `
    })
    setMentionQuery(null)
    setMentionAnchorIndex(null)
    requestAnimationFrame(() => {
      const el = composerInputRef.current
      if (!el) return
      el.focus()
      const len = el.value.length
      el.setSelectionRange?.(len, len)
    })
  }, [])

  const noRoomsAtAll = rooms.length === 0 && inviteRooms.length === 0

  // QUOXCHAT-PRO Matrix-less handoff: full-view empty state for deployments
  // with no Matrix stack (token mint 404 -> MatrixNotConfiguredError). All
  // hooks above have already run, so this early return is hook-safe.
  if (status === 'unconfigured') {
    return (
      <div className="qx-view matrix-comms-theme" style={{ padding: '0 16px 0 0', height: '100%', minHeight: 0, overflow: 'hidden' }}>
        <div className="qx-row qx-row--apart" style={{ marginBottom: 16 }}>
          <h2 className="mc-header-title mc-wordmark" style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--glass-text-primary)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <RoomsMarkIcon />
            <span>Quox <span className="mc-wordmark-matrix">MATRIX</span> Rooms</span>
          </h2>
        </div>
        <div className="qx-card" style={{ maxWidth: 560, margin: '72px auto 0', padding: '32px 36px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <RoomsMarkIcon />
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--glass-text-primary)' }}>
            Matrix comms is not configured on this deployment.
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--glass-text-secondary, rgba(255,255,255,0.65))' }}>
            Handoff replies are available from the QuoxChat widget manager Logs tab.
            Open your widget, pick the handed-off conversation, and use the live
            reply box: the visitor sees your reply in the widget.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="qx-view matrix-comms-theme" style={{ padding: '0 16px 0 0', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <MediaLightbox item={mediaLightbox} onClose={() => setMediaLightbox(null)} />
      <div className="qx-row qx-row--apart" style={{ marginBottom: 16 }}>
        <span className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          {/* Branded wordmark (owner ask): "Quox MATRIX Rooms", Quox in the
              normal UI font, MATRIX in the phosphor-green mono glow, led by a
              small rooms glyph. PILOT chip dropped. */}
          <h2 className="mc-header-title mc-wordmark" style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--glass-text-primary)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <RoomsMarkIcon />
            <span>Quox <span className="mc-wordmark-matrix">MATRIX</span> Rooms</span>
          </h2>
          {/* Active-org chip (owner ask): the room list is scoped to the
              active workspace org, so name it in the title row. Makes it clear
              you must change the scope selector to see another org's rooms. */}
          {orgBrand.name && (
            <span
              className="mc-header-org"
              title={`Showing rooms for ${orgBrand.name}. Change the workspace scope to see another org's rooms.`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '3px 11px 3px 4px', borderRadius: 999, background: 'var(--m-bg-base)', border: '1px solid var(--m-border-default)', backdropFilter: 'var(--qx-blur)', WebkitBackdropFilter: 'var(--qx-blur)' }}
            >
              <OrgAvatar name={orgBrand.name} logoUrl={orgBrand.logoUrl} size={20} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--glass-text-primary)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orgBrand.name}</span>
            </span>
          )}
          {/* QuoxChat waiting pill (QUOXCHAT-PRO P2): visible from ANY tab
              while a website customer waits on a reply. */}
          {quoxchatAttention.waitingRooms > 0 && (
            <span
              className="mc-quoxchat-waiting-pill"
              title={`${quoxchatAttention.waitingRooms} website ${quoxchatAttention.waitingRooms === 1 ? 'visitor is' : 'visitors are'} waiting for a reply`}
            >
              <QuoxChatGlyphIcon size={11} /> {quoxchatAttention.waitingRooms} waiting
            </span>
          )}
        </span>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <span style={{
            fontSize: 11, color: status === 'ready' ? 'var(--status-online)' : status === 'error' ? 'var(--status-error)' : 'var(--status-idle)'
          }}>
            {status === 'ready' ? 'Connected' : status === 'error' ? 'Disconnected' : 'Connecting…'}
          </span>
          <button className="glass-btn" onClick={refreshRooms} disabled={status !== 'ready'} style={{ background: 'transparent' }}>
            <RefreshIcon /> Refresh
          </button>
          <button className="glass-btn" onClick={handleOpenNewRoom} disabled={status !== 'ready'}>
            <PlusIcon /> New room
          </button>
        </div>
      </div>

      {error && (
        <div className="qx-card" style={{ padding: '10px 14px', marginBottom: 12, borderColor: 'var(--status-error)' }}>
          <span style={{ fontSize: 12, color: 'var(--status-error)' }}>{error}</span>
        </div>
      )}
      {notice && !error && (
        <div className="qx-card" style={{ padding: '10px 14px', marginBottom: 12, borderColor: 'var(--status-amber, #d9a441)' }}>
          <span style={{ fontSize: 12, color: 'var(--status-amber, #d9a441)' }}>{notice}</span>
        </div>
      )}

      {/* Room-type tab bar (CORECOMM-UX #190), filters the joined-room list
          in the sidebar below by ai.quox.room node_type. Rendered as a
          full-width strip above the sidebar+message-pane row rather than
          inside the narrow sidebar, so it reads as a proper tab bar. */}
      <div className="qx-tabs mc-room-tabs" role="tablist" aria-label="Filter rooms by type">
        {visibleRoomTabs.map((t) => {
          if (t.disabled) {
            // Public rooms (org-wide, open) aren't built yet, greyed,
            // aria-disabled, no click handler at all so it's never
            // reachable as an active tab.
            return (
              <span
                key={t.id}
                role="tab"
                aria-disabled="true"
                aria-selected="false"
                aria-label={`${t.label} rooms, coming soon`}
                className="qx-tab mc-room-tab mc-room-tab--soon"
              >
                {t.label} <span className="mc-room-tab-soon-badge">COMING SOON</span>
              </span>
            )
          }
          const count = t.id === 'all'
            ? scopedRooms.length
            : t.id === 'favourites'
              ? favouriteRooms.length
              : (rosterCounts[t.id] ?? (roomTabCounts[t.id] || 0))
          const unread = roomTabUnread[t.id] || 0
          const active = activeTab === t.id
          // QuoxChat tab (QUOXCHAT-PRO P2): a NUMERIC amber bubble, not the
          // red dot, because each unread here is a waiting customer. The
          // dot-not-number rationale below doesn't apply: this bubble is
          // visually distinct (amber, offset) from the room count.
          const quoxchatBubble = t.id === 'quoxchat' ? quoxchatAttention.bubbleCount : 0
          // Pro label (owner ask): the QuoxChat tab reads "QuoxChat Pro"
          // when the org has the Pro signal (see quoxchatPro memo).
          const tabLabel = t.id === 'quoxchat' && quoxchatPro ? 'QuoxChat Pro' : t.label
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={`Show ${tabLabel} rooms (${count})${unread > 0 ? `, ${unread} unread` : ''}`}
              className={`qx-tab mc-room-tab${active ? ' qx-tab--active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {/* Branded network marks (owner ask): Telegram paper-plane,
                  Slack lattice, QuoxChat bubble, tinted per network. */}
              {TAB_BRAND[t.id] && (
                <span className="mc-room-tab-bridge-dot" style={{ color: TAB_BRAND[t.id].color, display: 'inline-flex' }} aria-hidden="true">
                  {TAB_BRAND[t.id].icon}
                </span>
              )}
              {tabLabel} <span className="mc-room-tab-count">{count}</span>
              {/* Unread is a dot, not a second number: a numeric unread pill
                  next to the count read as a confusing duplicate (owner
                  report). Per-room unread numbers live in the list below. */}
              {t.id === 'quoxchat'
                ? quoxchatBubble > 0 && (
                  <span className="mc-quoxchat-tab-bubble" title={`${quoxchatBubble} unread from website visitors`} aria-label={`${quoxchatBubble} unread`}>
                    {quoxchatBubble > 99 ? '99+' : quoxchatBubble}
                  </span>
                )
                : unread > 0 && <span className="mc-room-tab-unread" title={`${unread} unread`} aria-label={`${unread} unread`} />}
            </button>
          )
        })}
      </div>

      <div className="qx-row" style={{ flex: 1, minHeight: 0, marginTop: 16 }}>
        {/* Spaces / room list */}
        <div className="qx-card mc-room-list-panel" style={{ width: 288, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
          {/* Sort control (owner ask): group by type, most recent activity, or
              alphabetical. Applies to the room-list tabs; entity roster tabs
              (agents/assistants/teams) stay name-sorted. */}
          <div className="qx-row" style={{ padding: '10px 10px 6px', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            {[['group', 'Group'], ['recent', 'Recent'], ['alpha', 'A–Z']].map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={`qx-tab mc-room-tab${roomSort === mode ? ' qx-tab--active' : ''}`}
                onClick={() => setRoomSort(mode)}
                disabled={!!activeRoster}
                style={{ flex: 1, justifyContent: 'center', fontSize: 10, opacity: activeRoster ? 0.4 : 1 }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="qx-pad" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, paddingTop: 4 }}>
            {inviteRooms.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <GroupHeader label="Invitations" icon={<MailIcon />} count={inviteRooms.length} />
                {inviteRooms.map((room) => (
                  <div key={room.roomId} style={{
                    padding: '8px 10px', marginBottom: 6, borderRadius: 12,
                    border: '1px solid rgba(56,189,248,0.28)', background: 'rgba(56,189,248,0.06)',
                  }}>
                    <div className="qx-row qx-row--tight" style={{ alignItems: 'center', marginBottom: 6 }}>
                      <MailIcon />
                      <span style={{ fontSize: 12, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {roomDisplayTitle(room, selfUserId, clientRef.current) || room.roomId}
                      </span>
                    </div>
                    <div className="qx-row qx-row--tight">
                      <button className="glass-btn" onClick={() => handleAcceptInvite(room.roomId)} style={{ flex: 1, justifyContent: 'center' }}>
                        <CheckIcon /> Accept
                      </button>
                      <button className="glass-btn" onClick={() => handleDeclineInvite(room.roomId)} style={{ flex: 1, justifyContent: 'center', background: 'transparent' }}>
                        <XIcon /> Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {noRoomsAtAll && !activeRoster && (
              <div className="mc-empty-state" style={{ padding: '24px 16px', fontSize: 12, opacity: 0.6, textAlign: 'center' }}>
                {status === 'ready' ? 'No rooms yet' : 'Loading rooms…'}
              </div>
            )}

            {activeRoster ? (
              // Entity roster tabs: list ALL agents / assistants / teams from the
              // registry. Entities with a room render as the room; the rest are
              // directory rows that start a chat on click.
              <div style={{ marginBottom: 10 }}>
                {activeRoster.length === 0 && (
                  <div className="mc-empty-state" style={{ padding: '24px 16px', fontSize: 12, opacity: 0.6, textAlign: 'center' }}>
                    {activeTab === 'agentic_team' ? 'No agentic teams installed yet' : 'None available yet'}
                  </div>
                )}
                {activeRoster.map(({ entity, kind }) => {
                  const room = kind === 'team' ? roomByTeamId[entity.id] : roomByAgentId[entity.id]
                  if (room) {
                    return (
                      <RoomRow
                        key={entity.id}
                        room={room}
                        selfUserId={selfUserId}
                        client={clientRef.current}
                        orgBrand={orgBrand}
                        selected={selectedRoomId === room.roomId}
                        onSelect={() => setSelectedRoomId(room.roomId)}
                        favourite={isFavouriteRoom(room)}
                        onToggleFavourite={() => toggleFavouriteRoom(room)}
                        onMenuOpen={(x, y) => openRoomMenu(x, y, room)}
                        entityFor={roomEntityFor}
                      />
                    )
                  }
                  return (
                    <EntityRow
                      key={entity.id}
                      entity={entity}
                      kind={kind}
                      onOpen={() => openEntityRoom(entity, kind)}
                      onMenuOpen={(x, y) => openRowMenu(x, y, { entity, kind }, null)}
                    />
                  )
                })}
              </div>
            ) : roomSort === 'group' ? (
              <>
                {activeTab !== 'all' && visibleRooms.length === 0 && (
                  <div className={`mc-empty-state${BRIDGE_TAB_EMPTY[activeTab] ? ' mc-empty-state--bridge' : ''}`} style={{ padding: '24px 16px', fontSize: 12, opacity: 0.6, textAlign: 'center' }}>
                    {TAB_EMPTY_HINT[activeTab] || 'No rooms in this category yet'}
                  </div>
                )}
                {ROOM_GROUP_ORDER.map((groupKey) => {
                  const groupRooms = roomGroups[groupKey]
                  if (!groupRooms || groupRooms.length === 0) return null
                  const meta = ROOM_GROUP_META[groupKey]
                  return (
                    <div key={groupKey} style={{ marginBottom: 10 }}>
                      <GroupHeader
                        label={groupKey === 'quoxchat' && quoxchatPro ? 'QuoxChat Pro' : meta.label}
                        icon={meta.icon}
                        count={groupRooms.length}
                        className={groupKey === 'agents' ? 'mc-group-agents' : undefined}
                      />
                      {groupRooms.map((room) => (
                        <RoomRow
                          key={room.roomId}
                          room={room}
                          selfUserId={selfUserId}
                          client={clientRef.current}
                          orgBrand={orgBrand}
                          selected={selectedRoomId === room.roomId}
                          onSelect={() => setSelectedRoomId(room.roomId)}
                          favourite={isFavouriteRoom(room)}
                          onToggleFavourite={() => toggleFavouriteRoom(room)}
                          onMenuOpen={(x, y) => openRoomMenu(x, y, room)}
                          entityFor={roomEntityFor}
                        />
                      ))}
                    </div>
                  )
                })}
              </>
            ) : (
              <>
                {visibleRooms.length === 0 && (
                  <div className={`mc-empty-state${BRIDGE_TAB_EMPTY[activeTab] ? ' mc-empty-state--bridge' : ''}`} style={{ padding: '24px 16px', fontSize: 12, opacity: 0.6, textAlign: 'center' }}>
                    {TAB_EMPTY_HINT[activeTab] || 'No rooms'}
                  </div>
                )}
                {flatRooms.map((room) => (
                  <RoomRow
                    key={room.roomId}
                    room={room}
                    selfUserId={selfUserId}
                    client={clientRef.current}
                    orgBrand={orgBrand}
                    selected={selectedRoomId === room.roomId}
                    onSelect={() => setSelectedRoomId(room.roomId)}
                    favourite={isFavouriteRoom(room)}
                    onToggleFavourite={() => toggleFavouriteRoom(room)}
                    onMenuOpen={(x, y) => openRoomMenu(x, y, room)}
                    entityFor={roomEntityFor}
                  />
                ))}
              </>
            )}
          </div>
        </div>

        {/* Timeline + composer */}
        <div className="qx-card mc-room-content" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
          {!selectedRoomId && (
            <div className="mc-empty-state" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, textAlign: 'center', padding: 24 }}>
              <EmptyRoomIcon />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 14, fontWeight: 600, opacity: 0.85 }}>Select a room</span>
                <span style={{ fontSize: 12, opacity: 0.5 }}>Pick a conversation on the left, or start a new one to get going.</span>
              </div>
            </div>
          )}

          {selectedRoomId && (
            <>
              <div className="mc-room-header" style={{ padding: '12px 16px', borderBottom: '1px solid var(--glass-edge-dim)' }}>
                <div className="qx-row qx-row--apart" style={{ alignItems: 'center', position: 'relative' }}>
                  <span className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{selectedRoomTitle || selectedRoomId}</span>
                    {/* Operator context (QUOXCHAT-PRO P2): this room is a
                        live website chat, replies go to the visitor. */}
                    {selectedRoomIsQuoxchat && (
                      <span
                        className="mc-bridge mc-bridge--quoxchat qx-tip"
                        data-tip="Live website chat: your replies go to the visitor"
                        style={{ cursor: 'default' }}
                      >
                        <QuoxChatGlyphIcon size={11} /> Website visitor
                      </span>
                    )}
                    <span
                      className="qx-pill qx-pill--success qx-pill--xs qx-tip mc-witnessed-pill"
                      data-tip="Every event in this room is tamper-evidently witnessed into WARD"
                      style={{ cursor: 'default' }}
                    >
                      <ShieldCheckIcon /> Witnessed
                    </span>
                  </span>
                  <span className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                    {/* Header favourite toggle (ROOMS-FAV): same m.favourite
                        room tag the room-row stars flip. */}
                    {(() => {
                      const fav = isFavouriteRoom(selectedRoom)
                      return (
                        <button
                          className={`glass-btn mc-fav-btn${fav ? ' mc-fav-btn--active' : ''}`}
                          onClick={() => toggleFavouriteRoom(selectedRoom)}
                          style={{ background: 'transparent' }}
                          aria-pressed={fav}
                          aria-label={fav ? 'Remove this room from favourites' : 'Add this room to favourites'}
                          title={fav ? 'Remove from favourites' : 'Add to favourites'}
                        >
                          <StarIcon filled={fav} />
                        </button>
                      )
                    })()}
                    <button
                      className="glass-btn mc-invite-agent-btn"
                      onClick={() => setInviteAgentOpen((v) => !v)}
                      style={{ background: inviteAgentOpen ? undefined : 'transparent' }}
                      aria-expanded={inviteAgentOpen}
                    >
                      <UserPlusIcon /> Invite agent
                    </button>
                  </span>

                  {inviteAgentOpen && (
                    <div
                      ref={invitePopoverRef}
                      className="qx-card mc-invite-popover"
                      style={{ position: 'absolute', top: '100%', right: 0, marginTop: 10, width: 264, zIndex: 25, padding: 10 }}
                    >
                      <input
                        className="glass-input"
                        style={{ width: '100%', marginBottom: 8 }}
                        placeholder="Search agents…"
                        value={inviteAgentSearch}
                        onChange={(e) => setInviteAgentSearch(e.target.value)}
                        autoFocus
                      />
                      <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                        {filteredAgents.length === 0 && (
                          <div style={{ fontSize: 12, opacity: 0.5, padding: '8px 4px', textAlign: 'center' }}>No agents match</div>
                        )}
                        {filteredAgents.map((agent) => (
                          <button
                            key={agent.id}
                            className="glass-nav"
                            onClick={() => handleInviteAgent(agent.id)}
                            disabled={!!invitingAgentId}
                            style={{ width: '100%', marginBottom: 4, textAlign: 'left', background: 'transparent' }}
                          >
                            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {agent.identity?.name || agent.id}
                              </span>
                              <span style={{ fontSize: 10, opacity: 0.5, textTransform: 'capitalize' }}>
                                {agent.hierarchy?.role || 'specialist'}
                              </span>
                            </div>
                            {invitingAgentId === agent.id && <span style={{ fontSize: 10, opacity: 0.6 }}>Inviting…</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {inviteAgentStatus && (
                  <div style={{
                    marginTop: 8, fontSize: 11,
                    color: inviteAgentStatus.type === 'success' ? 'var(--status-online)' : 'var(--status-error)'
                  }}>
                    {inviteAgentStatus.text}
                  </div>
                )}

              </div>

              <div
                style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}
                onDragEnter={(e) => {
                  if (!e.dataTransfer?.types?.includes('Files')) return
                  e.preventDefault()
                  dragDepthRef.current += 1
                  setDragActive(true)
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
                }}
                onDragLeave={() => {
                  dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
                  if (dragDepthRef.current === 0) setDragActive(false)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  dragDepthRef.current = 0
                  setDragActive(false)
                  if (e.dataTransfer?.files?.length) handleAttachFiles(e.dataTransfer.files)
                }}
              >
              {dragActive && (
                <div className="mc-drop-overlay" aria-hidden="true">
                  <span className="mc-drop-overlay-label"><PaperclipIcon /> Drop to attach</span>
                </div>
              )}
              <div
                className="qx-pad mc-timeline-scroll"
                ref={timelineScrollRef}
                onScroll={handleTimelineScroll}
                style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}
              >
                {timelineItems.length === 0 && (
                  <div className="mc-empty-state" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, textAlign: 'center', padding: 24 }}>
                    <EmptyMessagesIcon />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, opacity: 0.85 }}>No messages yet</span>
                      <span style={{ fontSize: 12, opacity: 0.5 }}>Say hello — everything here is witnessed into WARD.</span>
                    </div>
                  </div>
                )}
                {timelineItems.map((item) => {
                  if (item.kind === 'day') {
                    return <DaySeparator key={item.key} ts={item.ts} />
                  }
                  if (item.kind === 'sys') {
                    return <SysLine key={item.key} text={item.text} />
                  }
                  const group = item.group
                  const firstEv = group.events[0]
                  const senderId = group.senderId
                  const badge = senderBadge(senderId)
                  const isAgent = badge?.type === 'agent'
                  const isSelfSender = senderId === selfUserId
                  // Agent role tag (ROOMS-GREEN, mockup mcx-role): resolved
                  // from the registry entity behind the puppet; falls back
                  // to the population label, never a raw ULID.
                  const senderEntityInfo = isAgent ? memberEntityFor(senderId) : null
                  const senderRoleRaw = senderEntityInfo?.entity?.hierarchy?.role
                  const senderRole = isAgent
                    ? (senderRoleRaw && !isUlid(senderRoleRaw)
                      ? senderRoleRaw[0].toUpperCase() + senderRoleRaw.slice(1)
                      : (senderEntityInfo?.kind === 'assistant' ? 'Assistant' : 'Agent'))
                    : null
                  const senderName = resolveDisplayName(senderId, { member: firstEv.sender, client: clientRef.current })
                  const senderAvatarUrl = resolveAvatar(senderId, { member: firstEv.sender, client: clientRef.current })
                  // Click a sender's name/avatar to @-mention them (chat-app
                  // polish) — not for your own messages.
                  const onSenderClick = senderId === selfUserId ? undefined : () => handleInsertMention(senderName)
                  return (
                    // Bubble timeline (owner ask: "Telegram/WhatsApp, not
                    // IRC"). Own messages align right with the green-tinted
                    // bubble and no avatar/name header; others keep the
                    // avatar (once per group: grouping already collapses
                    // consecutive sends) + name/role header above the first
                    // bubble. Timestamps live INSIDE each bubble,
                    // bottom-right. Syslines/day pills stay centered.
                    <div key={firstEv.getId()} className={`qx-row mc-msg-group${isSelfSender ? ' mc-msg-group--own' : ''}`} style={{ gap: 10, alignItems: 'flex-start' }}>
                      {!isSelfSender && (
                        <div
                          className={`qx-avatar qx-avatar--sm${isAgent ? ' mc-agent-avatar' : ''}`}
                          style={{ marginTop: 2, cursor: onSenderClick ? 'pointer' : 'default' }}
                          onClick={onSenderClick}
                          title={onSenderClick ? `Mention ${senderName}` : undefined}
                        >
                          <AvatarFace avatarUrl={senderAvatarUrl} alt={senderName} client={clientRef.current}>
                            {monogram(senderName)}
                          </AvatarFace>
                        </div>
                      )}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0, alignItems: isSelfSender ? 'flex-end' : 'stretch' }}>
                        {!isSelfSender && (
                          <div className="qx-row qx-row--tight" style={{ alignItems: 'baseline' }}>
                            <span
                              className={onSenderClick ? 'mc-mentionable' : undefined}
                              style={{ fontSize: 13, fontWeight: 700, color: isAgent ? 'var(--matrix-green, #38bdf8)' : 'var(--glass-text-primary)', cursor: onSenderClick ? 'pointer' : 'default' }}
                              onClick={onSenderClick}
                              title={onSenderClick ? `Mention ${senderName}` : undefined}
                            >
                              {senderName}
                            </span>
                            {/* Agent role tag + bridged-source pill
                                (ROOMS-GREEN, mockup mcx-role / mcx-bridge
                                parity). Agents show their registry role
                                instead of a generic "Agent" pill. */}
                            {isAgent && senderRole && (
                              <span className="mc-role">{senderRole}</span>
                            )}
                            {badge && !isAgent && (
                              <span className={badge.className}>
                                {badge.icon} {badge.label}
                              </span>
                            )}
                            {/* Per-message witnessed shield (ROOMS-GREEN,
                                mockup mcx-msg-shield): agent messages are
                                the witnessed ones, hash-chained into WARD. */}
                            {isAgent && (
                              <span className="mc-msg-shield" title="Hash-chained into WARD">◈</span>
                            )}
                          </div>
                        )}
                        {group.events.map((ev) => {
                          const content = ev.getContent()
                          const isText = content.msgtype === 'm.text' || content.msgtype === 'm.notice'
                          const eventId = ev.getId()
                          const reactions = reactionsByEventId.get(eventId) || []
                          const pickerOpen = reactionPickerEventId === eventId
                          // HITL proposal card (ROOMS-GREEN): a governed
                          // approval request posted by hitlProposal.js.
                          // The 👍/👎 buttons send the REAL m.reaction the
                          // appservice's hitlReaction.js resolves; any
                          // matching reaction already on the event (local
                          // echo or another approver's) collapses the card
                          // into its resolved state.
                          const proposal = parseHitlProposal(senderId, content)
                          const proposalApproved = proposal && reactions.some((r) => normalizeEmojiKey(r.key) === '👍')
                          const proposalDeclined = proposal && !proposalApproved && reactions.some((r) => normalizeEmojiKey(r.key) === '👎')
                          const proposalState = proposal
                            ? (proposalApproved ? 'approved' : proposalDeclined ? 'declined' : 'awaiting')
                            : null
                          // Timestamp INSIDE the bubble, bottom-right
                          // (owner ask). Floated after the text so it sits
                          // on the last line when there is room, wraps
                          // below otherwise, the classic chat-app trick.
                          const bubbleTs = (
                            <span className="mc-bubble-ts" title={formatAbsoluteTooltip(ev.getTs())}>
                              {formatCompactTime(ev.getTs(), nowTick)}
                            </span>
                          )
                          const isMediaMsg = content.msgtype === 'm.image' || content.msgtype === 'm.video'
                          return (
                            <div key={eventId} className="mc-msg-wrap" style={{ position: 'relative', maxWidth: '100%' }}>
                              <div className="qx-row mc-msg-row" style={{ alignItems: 'flex-end', gap: 4, padding: '1px 0' }}>
                                {proposal ? (
                                  <div className={`mc-proposal mc-proposal--${proposalState}`} style={{ flex: 1, minWidth: 0 }}>
                                    <div className="mc-proposal-head">
                                      {proposalState === 'awaiting' && (
                                        <><span className="mc-proposal-warn" aria-hidden="true">⚠</span> Requires your approval</>
                                      )}
                                      {proposalState === 'approved' && (
                                        <span className="mc-proposal-decided mc-proposal-decided--yes">✓ Approved</span>
                                      )}
                                      {proposalState === 'declined' && (
                                        <span className="mc-proposal-decided mc-proposal-decided--no">✕ Declined</span>
                                      )}
                                    </div>
                                    <div className="mc-proposal-action">run `{proposal.tool}`</div>
                                    {proposalState === 'awaiting' && (
                                      <div className="mc-proposal-foot">
                                        <button
                                          type="button"
                                          className="mc-proposal-approve"
                                          onClick={() => handleToggleReaction(eventId, '👍')}
                                        >
                                          👍 Approve
                                        </button>
                                        <button
                                          type="button"
                                          className="mc-proposal-decline"
                                          onClick={() => handleToggleReaction(eventId, '👎')}
                                        >
                                          👎 Decline
                                        </button>
                                        <span className="mc-proposal-hint">Your call. The reaction is the approval.</span>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  // Message bubble (owner ask): rounded,
                                  // own = green-tinted glass on the right,
                                  // others = panel glass on the left.
                                  // Media renders inside the bubble too.
                                  <div className={`mc-bubble ${isSelfSender ? 'mc-bubble--own' : 'mc-bubble--other'}${isMediaMsg ? ' mc-bubble--media' : ''}`}>
                                    {isText ? (
                                      <span style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                        {renderMessageBody(content.body, mentionCandidates)}
                                      </span>
                                    ) : content.msgtype === 'm.image' ? (
                                      <TimelineImage content={content} client={clientRef.current} onExpand={setMediaLightbox} />
                                    ) : content.msgtype === 'm.video' ? (
                                      <TimelineVideo content={content} client={clientRef.current} onExpand={setMediaLightbox} />
                                    ) : content.msgtype === 'm.file' || content.msgtype === 'm.audio' ? (
                                      <TimelineFileChip content={content} client={clientRef.current} />
                                    ) : (
                                      <span className="glass-btn" style={{ display: 'inline-flex', width: 'fit-content', background: 'transparent', cursor: 'default' }}>
                                        <MediaIcon /> {content.msgtype || 'media'} attachment
                                      </span>
                                    )}
                                    {bubbleTs}
                                  </div>
                                )}
                                <button
                                  type="button"
                                  className={`glass-btn mc-react-add-btn${pickerOpen ? ' mc-react-add-btn--open' : ''}`}
                                  aria-label="Add reaction"
                                  onClick={() => setReactionPickerEventId((cur) => (cur === eventId ? null : eventId))}
                                  style={{ background: 'transparent', padding: '2px 4px', flexShrink: 0, marginLeft: 4 }}
                                >
                                  <SmileyIcon />
                                </button>
                                <span
                                  className="qx-tip"
                                  data-tip="Witnessed into WARD"
                                  style={{ display: 'inline-flex', opacity: 0.5, cursor: 'default', flexShrink: 0, marginLeft: 4 }}
                                >
                                  <ShieldCheckIcon />
                                </span>
                              </div>

                              {pickerOpen && (
                                <div className="qx-card mc-reaction-picker" style={{ position: 'absolute', top: '100%', right: 0, zIndex: 30, padding: 6 }}>
                                  {REACTION_EMOJI_SET.map((emoji) => (
                                    <button
                                      key={emoji}
                                      type="button"
                                      className="mc-reaction-picker-emoji"
                                      aria-label={`React with ${emoji}`}
                                      onClick={() => handleToggleReaction(eventId, emoji)}
                                    >
                                      {emoji}
                                    </button>
                                  ))}
                                </div>
                              )}

                              {reactions.length > 0 && (
                                <div className="qx-row qx-row--tight mc-reactions-row" style={{ padding: '2px 6px 4px' }}>
                                  {reactions.map((r) => (
                                    <button
                                      key={r.key}
                                      type="button"
                                      className={`qx-chip qx-chip--xs mc-reaction-chip${r.reacted ? ' mc-reaction-chip--mine' : ''}`}
                                      onClick={() => handleToggleReaction(eventId, r.key)}
                                      title={r.reacted ? 'Remove your reaction' : `React with ${r.key}`}
                                    >
                                      <span aria-hidden="true">{r.key}</span>
                                      <span className="mc-reaction-count">{r.count}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
                {/* In-timeline typing row (ROOMS-GREEN, mockup mcx-typing
                    parity): the first typing member's avatar + bouncing
                    dots + "DAEDALUS is typing…". Backed by the native m.typing
                    roster; dots go static under prefers-reduced-motion via
                    the theme CSS. */}
                {typingLabel && (() => {
                  const firstTypingId = typingUserIds[0]
                  const typingMember = selectedRoom?.getMember?.(firstTypingId)
                  const typingAvatarUrl = resolveAvatar(firstTypingId, { member: typingMember, client: clientRef.current })
                  // Visitor puppets excluded (QUOXCHAT-PRO P2): a typing
                  // website customer keeps the neutral avatar treatment.
                  const typingIsAgent = isAgentUserId(firstTypingId) && !isVisitorUserId(firstTypingId)
                  return (
                    <div className="qx-row mc-typing-row" style={{ gap: 10, alignItems: 'center' }}>
                      <div className={`qx-avatar qx-avatar--sm${typingIsAgent ? ' mc-agent-avatar' : ''}`}>
                        <AvatarFace avatarUrl={typingAvatarUrl} alt={typingNames[0] || ''} client={clientRef.current}>
                          {monogram(typingNames[0] || firstTypingId)}
                        </AvatarFace>
                      </div>
                      <span className="mc-typing-dots" aria-hidden="true"><span /><span /><span /></span>
                      <span style={{ fontSize: 11, opacity: 0.55 }}>{typingLabel}…</span>
                    </div>
                  )
                })()}
                <div ref={timelineEndRef} />
              </div>

              {showJumpToBottom && (
                <button
                  type="button"
                  className="glass-btn mc-jump-bottom-pill"
                  onClick={scrollToBottom}
                  style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)' }}
                >
                  <ArrowDownIcon /> New messages
                </button>
              )}
              </div>

              {thinkingLabel && (
                <div className="qx-row qx-row--tight mc-typing-indicator mc-thinking-indicator" style={{ alignItems: 'center', gap: 7, padding: '4px 16px' }}>
                  <AgentGlyphIcon />
                  <span className="mc-typing-dots" aria-hidden="true"><span /><span /><span /></span>
                  <span style={{ fontSize: 11, opacity: 0.6 }}>{thinkingLabel}…</span>
                </div>
              )}

              <div className="qx-row qx-row--tight" style={{ padding: 12, borderTop: '1px solid var(--glass-edge-dim)', position: 'relative' }}>
                {mentionQuery !== null && mentionAutocompleteMatches.length > 0 && (
                  <div className="mc-mention-autocomplete">
                    {mentionAutocompleteMatches.map((c) => (
                      <button
                        key={c.userId}
                        type="button"
                        className="glass-nav mc-mention-autocomplete-item"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => completeMention(c)}
                      >
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{c.displayName}</span>
                        <span style={{ fontSize: 11, opacity: 0.5 }}>@{c.handle}</span>
                      </button>
                    ))}
                  </div>
                )}
                <input
                  ref={attachInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    handleAttachFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
                <button
                  type="button"
                  className="glass-btn mc-attach-btn"
                  onClick={() => attachInputRef.current?.click()}
                  disabled={uploading || status !== 'ready'}
                  aria-label="Attach a file"
                  title="Attach a file (25 MB max)"
                >
                  <PaperclipIcon />
                  {uploading && (
                    <span className="mc-attach-pct">{uploadPct != null ? `${uploadPct}%` : '…'}</span>
                  )}
                </button>
                <input
                  ref={composerInputRef}
                  className="glass-input mc-composer-input"
                  style={{ flex: 1 }}
                  placeholder={selectedRoomIsQuoxchat ? 'Reply to the visitor...' : 'Message this room…'}
                  value={draft}
                  onChange={handleComposerChange}
                  onKeyDown={handleComposerKeyDown}
                  onBlur={() => setTimeout(() => { setMentionQuery(null); setMentionAnchorIndex(null) }, 100)}
                  disabled={sending}
                />
                <button className="glass-btn mc-send-btn" onClick={handleSend} disabled={sending || !draft.trim()}>
                  <SendIcon /> {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </>
          )}
        </div>

        {/* People panel — IRC-style roster (Agents / People), only when a
            room is selected. Independent scroll, collapsible on narrow
            viewports (see the matchMedia effect above). */}
        {selectedRoomId && (
          <div
            className="qx-card mc-people-panel"
            style={{
              width: peopleCollapsed ? 44 : 240,
              flexShrink: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              padding: 0,
              overflow: 'hidden',
            }}
          >
            <div
              className="qx-row qx-row--apart"
              style={{ alignItems: 'center', padding: '10px 12px', borderBottom: peopleCollapsed ? 'none' : '1px solid var(--glass-edge-dim)' }}
            >
              {!peopleCollapsed && (
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', opacity: 0.6 }}>
                  {selectedMembers.length} in room
                </span>
              )}
              <button
                className="glass-btn"
                onClick={togglePeopleCollapsed}
                style={{ background: 'transparent', padding: '4px 6px', marginLeft: peopleCollapsed ? 0 : 'auto' }}
                aria-label={peopleCollapsed ? 'Expand people panel' : 'Collapse people panel'}
              >
                <ChevronIcon direction={peopleCollapsed ? 'left' : 'right'} />
              </button>
            </div>

            {!peopleCollapsed && (
              <div className="qx-pad" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 }}>
                {peopleRoster.agents.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <GroupHeader label="Agents" icon={<AgentGlyphIcon />} count={peopleRoster.agents.length} className="mc-group-agents" />
                    {peopleRoster.agents.map(({ member, displayName, subLabel, avatarUrl }) => {
                      // Context menu (ROOMS-CTX): only for members that
                      // resolve to a registry entity (profile / settings /
                      // start-chat routes need one). Humans below have no
                      // profile surface yet, so they get no kebab.
                      const entityInfo = memberEntityFor(member.userId)
                      return (
                        <PeopleRow
                          key={member.userId}
                          userId={member.userId}
                          displayName={displayName}
                          subLabel={typingUserIds.includes(member.userId) ? `${subLabel} · typing` : subLabel}
                          subIcon={<AgentGlyphIcon />}
                          avatarClassName="mc-agent-avatar"
                          avatarUrl={avatarUrl}
                          presence="var(--matrix-green, #30ff90)"
                          client={clientRef.current}
                          onMentionClick={() => handleInsertMention(displayName)}
                          onMenuOpen={entityInfo ? (x, y) => openRowMenu(x, y, entityInfo, roomByAgentId[entityInfo.entity.id] || null) : undefined}
                        />
                      )
                    })}
                  </div>
                )}
                {peopleRoster.people.length > 0 && (
                  <div>
                    <GroupHeader label="People" icon={<DMGlyphIcon />} count={peopleRoster.people.length} />
                    {peopleRoster.people.map(({ member, displayName, network, subLabel, presence, avatarUrl }) => (
                      <PeopleRow
                        key={member.userId}
                        userId={member.userId}
                        displayName={displayName}
                        subLabel={typingUserIds.includes(member.userId) ? `${subLabel} · typing` : subLabel}
                        network={network}
                        avatarUrl={avatarUrl}
                        presence={presenceDotColor(presence)}
                        client={clientRef.current}
                        onMentionClick={member.userId === selfUserId ? undefined : () => handleInsertMention(displayName)}
                        onMenuOpen={(x, y) => openPersonMenu(x, y, { userId: member.userId, displayName, network })}
                      />
                    ))}
                  </div>
                )}
                {selectedMembers.length === 0 && (
                  <div style={{ padding: 16, fontSize: 12, opacity: 0.5, textAlign: 'center' }}>No members yet</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Row context menu (ROOMS-CTX): one instance, fed by whichever row
          opened it (kebab or right-click). */}
      {ctxMenu && (
        <ContextFlyout x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={closeCtxMenu} />
      )}

      {/* Person info flyout (owner ask): display name, MXID, org-scoped
          identity note, bridge origin when bridged. */}
      {personInfo && (
        <InfoFlyout x={personInfo.x} y={personInfo.y} onClose={closePersonInfo}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 260 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{personInfo.displayName || personInfo.userId}</span>
            <span className="mc-person-info-mxid">{personInfo.userId}</span>
            {personInfo.network && (
              <span className={`mc-bridge mc-bridge--${personInfo.network.key}`} style={{ alignSelf: 'flex-start' }}>
                {personInfo.network.icon} Bridged via {personInfo.network.label}
              </span>
            )}
            <span style={{ fontSize: 11, opacity: 0.55, lineHeight: 1.45 }}>
              Org-scoped identity: this Matrix ID exists only inside {currentOrg?.name || 'this organisation'} and is isolated from other orgs.
            </span>
          </div>
        </InfoFlyout>
      )}

      <Modal isOpen={newRoomOpen} onClose={() => setNewRoomOpen(false)} size="sm">
        <Modal.Header title="New room" onClose={() => setNewRoomOpen(false)} />
        <Modal.Body>
          <input
            className="glass-input"
            style={{ width: '100%' }}
            placeholder="Room name…"
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateRoom() }}
            autoFocus
          />
          {newRoomError && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--status-error)' }}>{newRoomError}</div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <button className="glass-btn" onClick={() => setNewRoomOpen(false)} style={{ background: 'transparent' }}>
            <XIcon /> Cancel
          </button>
          <button className="glass-btn" onClick={handleCreateRoom} disabled={!newRoomName.trim() || creatingRoom}>
            <PlusIcon /> {creatingRoom ? 'Creating…' : 'Create'}
          </button>
        </Modal.Footer>
      </Modal>
    </div>
  )
}
