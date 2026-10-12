/**
 * CollectionImporter - Import ZIP files or folders of n8n workflows
 *
 * Allows bulk importing workflow collections into the library:
 * - Drag & drop ZIP files
 * - Process and analyze workflows
 * - Preview before adding to library
 * - Download as indexed collection
 */

import { useState, useCallback, useRef } from 'react';
import JSZip from 'jszip';
import { indexWorkflows, isN8nWorkflow, CATEGORY_CONFIG } from '../../services/workflowIndexer';
import './WorkflowExplainer.css';

function CollectionImporter({ onImportComplete }) {
    const [dragOver, setDragOver] = useState(false);
    const [processing, setProcessing] = useState(false);
    const [progress, setProgress] = useState({ current: 0, total: 0, status: '' });
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const [collectionName, setCollectionName] = useState('');
    const fileInputRef = useRef(null);

    // Process ZIP file
    const processZipFile = useCallback(async (file) => {
        setProcessing(true);
        setError(null);
        setResult(null);
        setProgress({ current: 0, total: 0, status: 'Reading ZIP file...' });

        try {
            const zip = new JSZip();
            const contents = await zip.loadAsync(file);

            // Find all JSON files
            const jsonFiles = [];
            contents.forEach((relativePath, zipEntry) => {
                if (relativePath.endsWith('.json') && !relativePath.startsWith('__MACOSX')) {
                    jsonFiles.push({ path: relativePath, entry: zipEntry });
                }
            });

            if (jsonFiles.length === 0) {
                throw new Error('No JSON files found in ZIP');
            }

            setProgress({ current: 0, total: jsonFiles.length, status: 'Extracting workflows...' });

            // Extract and validate workflows
            const workflows = [];
            for (let i = 0; i < jsonFiles.length; i++) {
                const { path, entry } = jsonFiles[i];
                try {
                    const content = await entry.async('string');
                    if (isN8nWorkflow(content)) {
                        workflows.push({ content, path });
                    }
                } catch {
                    // Skip invalid files
                }
                setProgress({
                    current: i + 1,
                    total: jsonFiles.length,
                    status: `Processing ${path.split('/').pop()}...`
                });
            }

            if (workflows.length === 0) {
                throw new Error('No valid n8n workflows found in ZIP');
            }

            // Index workflows
            setProgress({
                current: workflows.length,
                total: workflows.length,
                status: 'Generating index...'
            });

            const indexed = indexWorkflows(workflows, {
                source: 'zip-import',
                author: 'User Import',
                collectionName: collectionName || file.name.replace('.zip', '')
            });

            setResult(indexed);
            setProgress({
                current: workflows.length,
                total: workflows.length,
                status: 'Complete!'
            });
        } catch (err) {
            setError(err.message);
        } finally {
            setProcessing(false);
        }
    }, [collectionName]);

    // Process multiple JSON files
    const processJsonFiles = useCallback(async (files) => {
        setProcessing(true);
        setError(null);
        setResult(null);
        setProgress({ current: 0, total: files.length, status: 'Processing files...' });

        try {
            const workflows = [];

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (file.name.endsWith('.json')) {
                    const content = await file.text();
                    if (isN8nWorkflow(content)) {
                        workflows.push({ content, path: file.name });
                    }
                }
                setProgress({
                    current: i + 1,
                    total: files.length,
                    status: `Processing ${file.name}...`
                });
            }

            if (workflows.length === 0) {
                throw new Error('No valid n8n workflows found');
            }

            setProgress({
                current: workflows.length,
                total: workflows.length,
                status: 'Generating index...'
            });

            const indexed = indexWorkflows(workflows, {
                source: 'file-import',
                author: 'User Import',
                collectionName: collectionName || 'Imported Workflows'
            });

            setResult(indexed);
        } catch (err) {
            setError(err.message);
        } finally {
            setProcessing(false);
        }
    }, [collectionName]);

    // Handle file drop
    const handleDrop = useCallback((e) => {
        e.preventDefault();
        setDragOver(false);

        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;

        // Check if it's a ZIP file
        const zipFile = files.find(f => f.name.endsWith('.zip'));
        if (zipFile) {
            processZipFile(zipFile);
        } else {
            // Process as JSON files
            const jsonFiles = files.filter(f => f.name.endsWith('.json'));
            if (jsonFiles.length > 0) {
                processJsonFiles(jsonFiles);
            } else {
                setError('Please drop a ZIP file or JSON workflow files');
            }
        }
    }, [processZipFile, processJsonFiles]);

    // Handle file input change
    const handleFileSelect = useCallback((e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        const zipFile = files.find(f => f.name.endsWith('.zip'));
        if (zipFile) {
            processZipFile(zipFile);
        } else {
            processJsonFiles(files);
        }
    }, [processZipFile, processJsonFiles]);

    // Download indexed collection
    const downloadIndex = useCallback(() => {
        if (!result) return;

        const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${result.source || 'workflows'}-index.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, [result]);

    // Add to library (merge with existing)
    const addToLibrary = useCallback(() => {
        if (!result || !onImportComplete) return;
        onImportComplete(result);
    }, [result, onImportComplete]);

    // Reset
    const handleReset = useCallback(() => {
        setResult(null);
        setError(null);
        setProgress({ current: 0, total: 0, status: '' });
        setCollectionName('');
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    }, []);

    return (
        <div className="collection-importer">
            <div className="collection-importer__header">
                <h3>Import Workflow Collection</h3>
                <p>Import a ZIP file or folder of n8n workflow JSON files</p>
            </div>

            {!result && !processing && (
                <>
                    {/* Collection Name Input */}
                    <div className="collection-importer__name-input">
                        <label>Collection Name (optional)</label>
                        <input
                            type="text"
                            placeholder="e.g., My Automation Templates"
                            value={collectionName}
                            onChange={(e) => setCollectionName(e.target.value)}
                        />
                    </div>

                    {/* Drop Zone */}
                    <div
                        className={`collection-importer__dropzone ${dragOver ? 'collection-importer__dropzone--active' : ''}`}
                        onDrop={handleDrop}
                        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                        onDragLeave={() => setDragOver(false)}
                        onClick={() => fileInputRef.current?.click()}
                    >
                        <div className="collection-importer__dropzone-content">
                            <div className="collection-importer__dropzone-icon">
                                {dragOver ? '📂' : '📦'}
                            </div>
                            <p className="collection-importer__dropzone-text">
                                {dragOver
                                    ? 'Drop files here'
                                    : 'Drag & drop a ZIP file or click to browse'
                                }
                            </p>
                            <p className="collection-importer__dropzone-hint">
                                Supports .zip archives or multiple .json files
                            </p>
                        </div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".zip,.json"
                            multiple
                            onChange={handleFileSelect}
                            style={{ display: 'none' }}
                        />
                    </div>
                </>
            )}

            {/* Processing Progress */}
            {processing && (
                <div className="collection-importer__progress">
                    <div className="collection-importer__progress-bar">
                        <div
                            className="collection-importer__progress-fill"
                            style={{
                                width: progress.total > 0
                                    ? `${(progress.current / progress.total) * 100}%`
                                    : '0%'
                            }}
                        />
                    </div>
                    <p className="collection-importer__progress-status">
                        {progress.status}
                    </p>
                    <p className="collection-importer__progress-count">
                        {progress.current} / {progress.total} files
                    </p>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="collection-importer__error">
                    <p>{error}</p>
                    <button className="btn" onClick={handleReset}>Try Again</button>
                </div>
            )}

            {/* Results */}
            {result && (
                <div className="collection-importer__results">
                    <div className="collection-importer__results-header">
                        <h4>Import Complete</h4>
                        <span className="collection-importer__results-count">
                            {result.totalWorkflows} workflows indexed
                        </span>
                    </div>

                    {/* Category Breakdown */}
                    <div className="collection-importer__categories">
                        <h5>By Category</h5>
                        <div className="collection-importer__category-list">
                            {Object.entries(result.categories)
                                .sort((a, b) => b[1] - a[1])
                                .map(([cat, count]) => (
                                    <div
                                        key={cat}
                                        className="collection-importer__category-item"
                                        style={{ borderLeftColor: CATEGORY_CONFIG[cat]?.color || '#6b7280' }}
                                    >
                                        <span className="icon">{CATEGORY_CONFIG[cat]?.icon || '📦'}</span>
                                        <span className="name">{cat}</span>
                                        <span className="count">{count}</span>
                                    </div>
                                ))
                            }
                        </div>
                    </div>

                    {/* Errors */}
                    {result.errors && result.errors.length > 0 && (
                        <div className="collection-importer__errors">
                            <h5>Skipped Files ({result.errors.length})</h5>
                            <ul>
                                {result.errors.slice(0, 5).map((err, i) => (
                                    <li key={i}>{err.path}: {err.error}</li>
                                ))}
                                {result.errors.length > 5 && (
                                    <li>...and {result.errors.length - 5} more</li>
                                )}
                            </ul>
                        </div>
                    )}

                    {/* Sample Workflows */}
                    <div className="collection-importer__samples">
                        <h5>Sample Workflows</h5>
                        <div className="collection-importer__sample-list">
                            {result.workflows.slice(0, 5).map(wf => (
                                <div key={wf.id} className="collection-importer__sample-item">
                                    <span
                                        className="icon"
                                        style={{ background: CATEGORY_CONFIG[wf.identity.category]?.color }}
                                    >
                                        {CATEGORY_CONFIG[wf.identity.category]?.icon || '📦'}
                                    </span>
                                    <div className="info">
                                        <span className="name">{wf.identity.name}</span>
                                        <span className="integrations">
                                            {wf.capabilities?.integrations?.slice(0, 3).join(', ') || 'No integrations'}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="collection-importer__actions">
                        <button className="btn" onClick={handleReset}>
                            Import Another
                        </button>
                        <button className="btn" onClick={downloadIndex}>
                            Download Index
                        </button>
                        {onImportComplete && (
                            <button className="btn btn--primary" onClick={addToLibrary}>
                                Add to Library
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export default CollectionImporter;
export { CollectionImporter };
