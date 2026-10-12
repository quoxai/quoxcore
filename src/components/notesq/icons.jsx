/** Inline SVG icons for NotesQ (every button carries one). */
const base = {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
};
const mk = (children) => function Icon({ size = 14, strokeWidth }) {
  return <svg {...base} width={size} height={size} strokeWidth={strokeWidth || base.strokeWidth}>{children}</svg>;
};
export const NotesIcon = mk(<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h6" /></>);
export const GearIcon = mk(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>);
export const PlusIcon = mk(<path d="M12 5v14M5 12h14" />);
export const PinIcon = mk(<><path d="M12 17v5" /><path d="M9 3h6l-1 6 3 3H7l3-3z" /></>);
export const ArchiveIcon = mk(<><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></>);
export const SearchIcon = mk(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>);
export const EditIcon = mk(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>);
export const EyeIcon = mk(<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>);
export const TrashIcon = mk(<><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></>);
export const HistoryIcon = mk(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>);
export const CopyIcon = mk(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>);
export const RestoreIcon = mk(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>);
export const ChevronLeftIcon = mk(<path d="M15 18l-6-6 6-6" />);
export const SidebarIcon = mk(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>);
export const CheckIcon = mk(<path d="M20 6L9 17l-5-5" />);
export const RefreshIcon = mk(<><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>);
export const SendIcon = mk(<><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></>);
export const RouteIcon = mk(<><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M8 19h6a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h6" /></>);
export const XIcon = mk(<path d="M18 6L6 18M6 6l12 12" />);
const txt = (label) => <text x="12" y="17" textAnchor="middle" fontSize="14" fontWeight="900" fill="currentColor" stroke="none">{label}</text>
export const BoldIcon = mk(<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />);
export const ItalicIcon = mk(<path d="M19 4h-9M14 20H5M15 4L9 20" />);
export const StrikeIcon = mk(<path d="M16 6a4 4 0 0 0-4-2c-2.5 0-4 1.3-4 3s1.5 2.5 4 3M4 12h16M8 18a4 4 0 0 0 4 2c2.5 0 4-1.3 4-3.2" />);
export const H1Icon = mk(txt('H1'));
export const H2Icon = mk(txt('H2'));
export const H3Icon = mk(txt('H3'));
export const ListIcon = mk(<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />);
export const ListOrderedIcon = mk(<><path d="M10 6h10M10 12h10M10 18h10" /><path d="M4 5l1.5-1v4M4 13h3l-3 3h3M4 18.5h2.5l-1.5 1.5h1.5a1 1 0 0 1 0 2H4" strokeWidth="1.3" /></>);
export const CheckSquareIcon = mk(<><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 12l3 3 5-6" /></>);
export const QuoteIcon = mk(<path d="M4 6v6h5a4 4 0 0 1-4 4M14 6v6h5a4 4 0 0 1-4 4" />);
export const CodeIcon = mk(<path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />);
export const CodeBlockIcon = mk(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M10 9l-3 3 3 3M14 9l3 3-3 3" /></>);
export const LinkIcon = mk(<><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>);
export const NoteLinkIcon = mk(<path d="M8 4H5v16h3M16 4h3v16h-3" />);
export const HrIcon = mk(<path d="M3 12h18M7 7h.01M12 7h.01M17 7h.01M7 17h.01M12 17h.01M17 17h.01" />);
export const SplitIcon = mk(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></>);
export const FocusIcon = mk(<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />);
export const FocusExitIcon = mk(<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M16 21v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />);
export const PanelLeftIcon = mk(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>);
export const ChevronsLeftIcon = mk(<path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />);
export const ChevronsRightIcon = mk(<path d="M13 17l5-5-5-5M6 17l5-5-5-5" />);
export const UserIcon = mk(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>);
export const OrgIcon = mk(<><circle cx="9" cy="8" r="3.5" /><path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 20a6 6 0 0 0-3-5.2" /></>);
export const LayersIcon = mk(<><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>);
export const CameraIcon = mk(<><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><circle cx="12" cy="13.5" r="3.5" /></>);
export const PaperclipIcon = mk(<path d="M21 11.5l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3" />);
export const FilterIcon = mk(<path d="M3 5h18l-7 8v6l-4 2v-8z" />);
export const ChatIcon = mk(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z" />);
export const UploadIcon = mk(<><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>);
export const TemplateIcon = mk(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></>);
export const CalendarIcon = mk(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>);
export const PauseIcon = mk(<path d="M8 5v14M16 5v14" />);
export const PlayIcon = mk(<path d="M7 4l13 8-13 8z" />);
export const HeartbeatIcon = mk(<path d="M3 12h4l2-6 4 12 2-6h6" />);
export const BookOpenIcon = mk(<><path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" /><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" /></>);
// Text size: a letter A with minus / plus.
