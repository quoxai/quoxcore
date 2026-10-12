// File management components
// LICENSE-LAUNCH LL-7 increment 3h: FileManager is a coreModule of the stripped
// files bundle. Re-exporting it from this barrel would make the barrel import a
// coreModule and trip the ESLint strip boundary. Its only consumer, FilesView,
// imports it directly from './FileManager', so the barrel no longer needs it.
export { FolderTree } from './FolderTree'
export { FolderChat } from './FolderChat'
export { FileSkillPanel } from './FileSkillPanel'
export { ArchivistPanel } from './ArchivistPanel'
