/**
 * TipTap extension set for NotesQ rich mode. Markdown is canonical: the doc is
 * only a view of it, bridged by @tiptap/markdown (marked tokenizer + per-node
 * serialisers). Nothing here may be imported from the main bundle: it is only
 * reached through the lazy NotesQRichEditor chunk and the round-trip guard.
 */
import { Node, Extension, mergeAttributes, nodeInputRule } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from '@tiptap/markdown'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { isAttachmentHref } from './attachments'

const WIKI = /^\[\[([^\]\n]+)\]\]/

/** [[Title]] as an inline atom. Serialises back to [[Title]] verbatim (never escaped). */
export const Wikilink = Node.create({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() { return { title: { default: '' } } },
  parseHTML() { return [{ tag: 'span[data-wikilink]', getAttrs: (el) => ({ title: el.getAttribute('data-wikilink') }) }] },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-wikilink': node.attrs.title, class: 'nq-wikilink' }), `[[${node.attrs.title}]]`]
  },
  renderText({ node }) { return `[[${node.attrs.title}]]` },
  markdownTokenName: 'wikilink',
  markdownTokenizer: {
    name: 'wikilink',
    level: 'inline',
    start: (src) => src.indexOf('[['),
    tokenize(src) {
      const m = WIKI.exec(src)
      return m ? { type: 'wikilink', raw: m[0], title: m[1] } : undefined
    },
  },
  parseMarkdown(token, h) { return h.createNode('wikilink', { title: token.title }) },
  renderMarkdown(node) { return `[[${node.attrs?.title ?? ''}]]` },
  // Typing the closing ]] of [[Title converts it to the atom.
  addInputRules() {
    return [nodeInputRule({ find: /\[\[([^\]\n]+)\]\]$/, type: this.type, getAttributes: (m) => ({ title: m[1] }) })]
  },
})

/**
 * ![alt](src) as an inline atom (marked emits images as inline tokens). Only
 * same-origin attachment URLs and http(s) are ever rendered as <img>.
 */
const SAFE_SRC = /^(\/api\/orgs\/|https?:\/\/)/i
export const NqImage = Node.create({
  name: 'nqImage',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,
  addAttributes() { return { src: { default: '' }, alt: { default: '' }, title: { default: null } } },
  parseHTML() { return [{ tag: 'img[src]', getAttrs: (el) => ({ src: el.getAttribute('src'), alt: el.getAttribute('alt') || '', title: el.getAttribute('title') }) }] },
  renderHTML({ node }) {
    const { src, alt, title } = node.attrs
    return ['img', { src: SAFE_SRC.test(src) ? src : '', alt, ...(title ? { title } : {}), class: 'nq-img', loading: 'lazy' }]
  },
  renderText({ node }) { return `![${node.attrs.alt}](${node.attrs.src})` },
  markdownTokenName: 'image',
  parseMarkdown(token, h) { return h.createNode('nqImage', { src: token.href, alt: token.text || '', title: token.title || null }) },
  renderMarkdown(node) {
    const { src, alt, title } = node.attrs
    return `![${alt || ''}](${src}${title ? ` "${title}"` : ''})`
  },
})

/** Link that styles our own attachment links as file chips (the markdown is unchanged). */
export const NqLink = Link.extend({
  renderHTML({ HTMLAttributes, mark }) {
    const attach = isAttachmentHref(mark.attrs.href)
    const attrs = attach ? { ...HTMLAttributes, class: 'qx-chip nq-file', target: null, download: '' } : HTMLAttributes
    return ['a', attrs, 0]
  },
})

export const uploadKey = new PluginKey('nqUploads')

/**
 * Uploading placeholders are widget decorations, NOT document content: they
 * never reach markdown or autosave, they ride along with edits via mapping, and
 * a failed upload just drops the widget. Meta: { add: {id, pos, name} } | { remove: id }.
 */
export const UploadPlaceholders = Extension.create({
  name: 'nqUploads',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: uploadKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          set = set.map(tr.mapping, tr.doc)
          const m = tr.getMeta(uploadKey)
          if (m?.add) {
            const el = document.createElement('span')
            el.className = 'nq-uploading'
            el.setAttribute('role', 'status')
            el.textContent = `Uploading ${m.add.name}\u2026`
            set = set.add(tr.doc, [Decoration.widget(m.add.pos, el, { id: m.add.id, side: -1 })])
          }
          if (m?.remove) set = set.remove(set.find(undefined, undefined, (sp) => sp.id === m.remove))
          return set
        },
      },
      props: { decorations(state) { return uploadKey.getState(state) } },
    })]
  },
})

/** Current position of an upload placeholder, or null if it was removed. */
export function placeholderPos(state, id) {
  const f = uploadKey.getState(state)?.find(undefined, undefined, (sp) => sp.id === id)
  return f && f.length ? f[0].from : null
}

export function buildExtensions({ placeholder } = {}) {
  return [
    // underline has no markdown form; StarterKit 3 ships its own Link, replaced below.
    StarterKit.configure({ link: false, underline: false }),
    NqLink.configure({ openOnClick: false, autolink: false, HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Wikilink,
    NqImage,
    UploadPlaceholders,
    Markdown,
    ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
  ]
}
