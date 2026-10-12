/**
 * QuoxCORE UI Component Library
 *
 * A unified design system for the QuoxCORE dashboard.
 *
 * Usage:
 *   import { Button, Card, Modal } from '@/components/ui'
 *   // or
 *   import Button from '@/components/ui/Button'
 *
 * Components:
 * - Button, IconButton, ButtonGroup - Action buttons
 * - Card (with Header, Body, Footer) - Content containers
 * - Panel (with Header, Body) - Dashboard panels
 * - Modal (with Header, Body, Footer) - Dialogs
 * - Input, Textarea, Select, SearchInput, CodeInput, FormField - Form inputs
 * - Badge, StatusBadge, TypeBadge, SeverityBadge - Labels
 * - Spinner, Loading, Skeleton*, LoadingOverlay - Loading states
 * - Empty, ErrorState, ErrorMessage, NoData - Empty/error states
 * - Collapsible, CollapsibleGroup, useCollapsible - Expandable sections
 * - Progress, ResourceBar, StorageBar, CircularProgress - Progress indicators
 * - Status, StatusDot, ConnectionStatus, HealthStatus - Status indicators
 * - Tabs, Tab, TabPanel - Tab navigation
 * - List, ListItem, DataRow, DataGrid - List displays
 * - Table, TableHeader, TableBody, TableRow, TableCell - Tables
 *
 * CSS:
 *   import '@/components/ui/ui.css'
 *
 * Design tokens are defined as CSS variables (see ui.css).
 */

// Button
export { default as Button, IconButton, ButtonGroup } from './Button'

// Card
export { default as Card } from './Card'

// Panel
export { default as Panel, RefreshButton } from './Panel'

// Modal
export { default as Modal } from './Modal'

// Input & Form Controls
export {
  Input,
  Textarea,
  Select,
  FormField,
  SearchInput,
  CodeInput,
  Checkbox,
  Toggle,
  SettingItem,
  RadioGroup,
  Alert
} from './Input'

// Badge
export {
  default as Badge,
  StatusBadge,
  CountBadge,
  TypeBadge,
  SeverityBadge
} from './Badge'

// Loading
export {
  Spinner,
  Loading,
  Skeleton,
  SkeletonText,
  SkeletonCard,
  SkeletonList,
  SkeletonTable,
  LoadingOverlay
} from './Loading'

// Empty & Error
export {
  Empty,
  ErrorState,
  ErrorMessage,
  NoData,
  EmptySearch,
  EmptyList,
  EmptyFolder,
  EmptyConnection
} from './Empty'

// Collapsible
export {
  default as Collapsible,
  CollapsibleGroup,
  useCollapsible
} from './Collapsible'

// Progress
export {
  Progress,
  ResourceBar,
  StorageBar,
  CircularProgress
} from './Progress'

// Status
export {
  Status,
  StatusDot,
  ConnectionStatus,
  HealthStatus,
  OnlineIndicator,
  StatusBanner
} from './Status'

// Tabs
export {
  Tabs,
  Tab,
  TabPanel,
  TabsWithPanels
} from './Tabs'

// List
export {
  List,
  ListItem,
  DataRow,
  DataGrid,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableCell
} from './List'
