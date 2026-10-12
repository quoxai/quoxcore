/**
 * PayloadSections — Collapsible content sections for inbox items
 *
 * Renders an array of sections as <details> elements with markdown content.
 * Each section has a title, markdown body, and optional collapsed state.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './payload-renderer.css';

// Reuse markdown components for section content
const sectionMdComponents = {
    p: ({ children }) => <p className="md-p">{children}</p>,
    strong: ({ children }) => <strong>{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    code: ({ children }) => <code className="inline-code">{children}</code>,
    pre: ({ children }) => <pre className="code-block">{children}</pre>,
    h1: ({ children }) => <strong style={{ fontSize: '1.1em', display: 'block', marginBottom: 4 }}>{children}</strong>,
    h2: ({ children }) => <strong style={{ fontSize: '1.05em', display: 'block', marginBottom: 4 }}>{children}</strong>,
    h3: ({ children }) => <strong style={{ display: 'block', marginBottom: 4 }}>{children}</strong>,
    ul: ({ children }) => <ul className="md-list">{children}</ul>,
    ol: ({ children }) => <ol className="md-list md-list-ordered">{children}</ol>,
    li: ({ children }) => <li className="md-li">{children}</li>,
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ src, alt }) => (
        <img
            src={src}
            alt={alt || ''}
            className="inbox-item-detail__img"
            loading="lazy"
            onError={(e) => { e.target.style.display = 'none'; }}
        />
    ),
    table: ({ children }) => <table className="chat-table">{children}</table>,
    th: ({ children }) => <th>{children}</th>,
    td: ({ children }) => <td>{children}</td>,
};

export default function PayloadSections({ sections }) {
    if (!Array.isArray(sections) || sections.length === 0) return null;

    return (
        <div className="payload-sections">
            {sections.map((section, i) => (
                <details
                    key={i}
                    className="payload-section"
                    open={!section.collapsed}
                >
                    <summary>{section.title || `Section ${i + 1}`}</summary>
                    {section.content_md && (
                        <div className="payload-section__content">
                            <div className="message-text">
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={sectionMdComponents}>
                                    {section.content_md}
                                </ReactMarkdown>
                            </div>
                        </div>
                    )}
                </details>
            ))}
        </div>
    );
}
