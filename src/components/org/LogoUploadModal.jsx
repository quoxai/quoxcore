/**
 * LogoUploadModal — Image crop, position & background colour editor.
 *
 * User selects/drops an image, positions and zooms it on a canvas,
 * optionally picks a background colour (for PNGs with transparency),
 * then uploads the cropped result.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import './LogoUploadModal.css';

// Output size of the cropped logo
const CANVAS_SIZE = 256;
// Display size of the preview canvas
const PREVIEW_SIZE = 280;

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
const TRANSPARENT_TYPES = ['image/png', 'image/gif', 'image/webp', 'image/svg+xml'];

const BG_PRESETS = [
    { colour: '#ffffff', label: 'White' },
    { colour: '#e5e7eb', label: 'Light grey' },
    { colour: '#1a1a1e', label: 'Dark' },
    { colour: '#000000', label: 'Black' },
    { colour: '#4ecdc4', label: 'Teal' },
    { colour: '#38bdf8', label: 'Sky' },
];

// Icons
const UploadIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
);

const ImageIcon = () => (
    <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
    </svg>
);

export default function LogoUploadModal({
    isOpen,
    onClose,
    orgId,
    authFetch,
    onUploaded,
}) {
    // Image state
    const [imageFile, setImageFile] = useState(null);
    const [imageEl, setImageEl] = useState(null);
    const [fileType, setFileType] = useState(null);

    // Crop state
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });

    // Background colour (for transparent images)
    const [bgColour, setBgColour] = useState('#ffffff');

    // UI state
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState(null);
    const [dragOver, setDragOver] = useState(false);

    // Refs
    const canvasRef = useRef(null);
    const fileInputRef = useRef(null);
    const dragRef = useRef(null);

    const isTransparent = fileType && TRANSPARENT_TYPES.includes(fileType);

    // Reset state when modal closes
    useEffect(() => {
        if (!isOpen) {
            setImageFile(null);
            setImageEl(null);
            setFileType(null);
            setZoom(1);
            setPan({ x: 0, y: 0 });
            setBgColour('#ffffff');
            setError(null);
            setDragOver(false);
        }
    }, [isOpen]);

    // Load image when file changes
    useEffect(() => {
        if (!imageFile) return;

        const img = new Image();
        img.onload = () => {
            setImageEl(img);
            // Reset pan to center
            setPan({ x: 0, y: 0 });
            // Set initial zoom so image fills canvas
            const minDim = Math.min(img.naturalWidth, img.naturalHeight);
            const initialZoom = CANVAS_SIZE / minDim;
            setZoom(Math.max(1, initialZoom));
        };
        img.onerror = () => {
            setError('Failed to load image. Please try a different file.');
            setImageFile(null);
        };
        img.src = URL.createObjectURL(imageFile);

        return () => URL.revokeObjectURL(img.src);
    }, [imageFile]);

    // Draw canvas whenever image, zoom, pan, or bg changes
    const drawCanvas = useCallback(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!ctx || !imageEl) return;

        canvas.width = CANVAS_SIZE;
        canvas.height = CANVAS_SIZE;

        // Background
        if (isTransparent) {
            ctx.fillStyle = bgColour;
            ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        } else {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        }

        // Draw image centered with pan + zoom
        const imgW = imageEl.naturalWidth * zoom;
        const imgH = imageEl.naturalHeight * zoom;
        const x = (CANVAS_SIZE - imgW) / 2 + pan.x;
        const y = (CANVAS_SIZE - imgH) / 2 + pan.y;

        ctx.drawImage(imageEl, x, y, imgW, imgH);
    }, [imageEl, zoom, pan, bgColour, isTransparent]);

    useEffect(() => {
        drawCanvas();
    }, [drawCanvas]);

    // --- File handling ---

    const handleFile = (file) => {
        setError(null);
        if (!file) return;

        if (!ACCEPTED_TYPES.includes(file.type)) {
            setError('Unsupported file type. Use JPEG, PNG, GIF, WebP, or SVG.');
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            setError('File too large. Maximum size is 2MB.');
            return;
        }

        setFileType(file.type);
        setImageFile(file);
    };

    const handleFileInput = (e) => {
        handleFile(e.target.files?.[0]);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer?.files?.[0];
        handleFile(file);
    };

    const handleDragOver = (e) => {
        e.preventDefault();
        setDragOver(true);
    };

    const handleDragLeave = () => {
        setDragOver(false);
    };

    // --- Pan via drag ---

    const handlePointerDown = (e) => {
        if (!imageEl) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const startPan = { ...pan };

        const handlePointerMove = (ev) => {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            // Scale mouse movement to canvas coordinates
            const scale = CANVAS_SIZE / PREVIEW_SIZE;
            setPan({
                x: startPan.x + dx * scale,
                y: startPan.y + dy * scale,
            });
        };

        const handlePointerUp = () => {
            document.removeEventListener('pointermove', handlePointerMove);
            document.removeEventListener('pointerup', handlePointerUp);
        };

        document.addEventListener('pointermove', handlePointerMove);
        document.addEventListener('pointerup', handlePointerUp);
    };

    // --- Zoom via wheel ---

    const handleWheel = (e) => {
        if (!imageEl) return;
        e.preventDefault();
        setZoom(prev => {
            const delta = e.deltaY > 0 ? -0.05 : 0.05;
            return Math.max(0.2, Math.min(5, prev + delta));
        });
    };

    // --- Upload ---

    const handleUpload = async () => {
        const canvas = canvasRef.current;
        if (!canvas || !imageEl) return;

        // Ensure final draw
        drawCanvas();

        setUploading(true);
        setError(null);

        try {
            const blob = await new Promise((resolve, reject) => {
                canvas.toBlob(
                    (b) => b ? resolve(b) : reject(new Error('Canvas export failed')),
                    'image/png',
                    0.95
                );
            });

            const formData = new FormData();
            formData.append('logo', blob, 'logo.png');

            const response = await authFetch(`/api/uploads/org/${orgId}/logo`, {
                method: 'POST',
                body: formData,
            });

            if (response.ok) {
                const data = await response.json();
                onUploaded?.(data.logo_url);
                onClose();
            } else {
                const data = await response.json().catch(() => ({}));
                setError(data.message || 'Upload failed');
            }
        } catch (err) {
            setError(err.message || 'Upload failed');
        } finally {
            setUploading(false);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={uploading ? undefined : onClose}
            size="md"
            closeOnOverlay={!uploading}
            closeOnEscape={!uploading}
        >
            <Modal.Header
                title="Upload Logo"
                description="Position and crop your logo"
                icon={<UploadIcon />}
                onClose={!uploading ? onClose : undefined}
            />

            <Modal.Body>
                {error && (
                    <div style={{
                        padding: '0.75rem 1rem',
                        background: 'rgba(239, 68, 68, 0.08)',
                        borderRadius: '8px',
                        borderLeft: '3px solid var(--color-danger, #ef4444)',
                        fontSize: '0.8rem',
                        color: 'var(--color-danger, #ef4444)',
                        marginBottom: '1rem'
                    }}>
                        {error}
                    </div>
                )}

                <div className="logo-editor">
                    {!imageEl ? (
                        /* Dropzone */
                        <div
                            className={`logo-editor__dropzone ${dragOver ? 'logo-editor__dropzone--dragover' : ''}`}
                            onClick={() => fileInputRef.current?.click()}
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                            onDragLeave={handleDragLeave}
                        >
                            <span className="logo-editor__dropzone-icon">
                                <ImageIcon />
                            </span>
                            <span className="logo-editor__dropzone-text">
                                Drop an image here or click to browse
                            </span>
                            <span className="logo-editor__dropzone-hint">
                                JPEG, PNG, GIF, WebP, or SVG — max 2MB
                            </span>
                        </div>
                    ) : (
                        /* Canvas editor */
                        <>
                            <div className="logo-editor__preview">
                                <canvas
                                    ref={canvasRef}
                                    className="logo-editor__canvas"
                                    style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
                                    onPointerDown={handlePointerDown}
                                    onWheel={handleWheel}
                                />
                                <span className="logo-editor__canvas-hint">
                                    Drag to reposition — scroll to zoom
                                </span>
                            </div>

                            {/* Controls */}
                            <div className="logo-editor__controls">
                                {/* Zoom */}
                                <div className="logo-editor__control-row">
                                    <span className="logo-editor__label">Zoom</span>
                                    <input
                                        type="range"
                                        className="logo-editor__slider"
                                        min="0.2"
                                        max="5"
                                        step="0.01"
                                        value={zoom}
                                        onChange={(e) => setZoom(parseFloat(e.target.value))}
                                    />
                                    <span className="logo-editor__zoom-value">
                                        {Math.round(zoom * 100)}%
                                    </span>
                                </div>

                                {/* Background colour (transparent formats only) */}
                                {isTransparent && (
                                    <div className="logo-editor__control-row">
                                        <span className="logo-editor__label">Background</span>
                                        <div className="logo-editor__colours">
                                            {BG_PRESETS.map(p => (
                                                <button
                                                    key={p.colour}
                                                    type="button"
                                                    className={`logo-editor__colour-swatch ${bgColour === p.colour ? 'logo-editor__colour-swatch--active' : ''}`}
                                                    style={{ background: p.colour }}
                                                    title={p.label}
                                                    onClick={() => setBgColour(p.colour)}
                                                />
                                            ))}
                                            <span className="logo-editor__colour-custom" title="Custom colour">
                                                <input
                                                    type="color"
                                                    value={bgColour}
                                                    onChange={(e) => setBgColour(e.target.value)}
                                                />
                                            </span>
                                        </div>
                                    </div>
                                )}

                                {/* Change file */}
                                <div style={{ textAlign: 'center' }}>
                                    <button
                                        type="button"
                                        className="logo-editor__change-file"
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        Choose a different image
                                    </button>
                                </div>
                            </div>
                        </>
                    )}

                    {/* Hidden file input */}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept={ACCEPTED_TYPES.join(',')}
                        onChange={handleFileInput}
                        style={{ display: 'none' }}
                    />
                </div>
            </Modal.Body>

            <Modal.Footer>
                <Button
                    type="button"
                    variant="ghost"
                    onClick={onClose}
                    disabled={uploading}
                >
                    Cancel
                </Button>
                <Button
                    type="button"
                    variant="primary"
                    onClick={handleUpload}
                    loading={uploading}
                    disabled={!imageEl || uploading}
                    style={{ marginLeft: 'auto' }}
                >
                    <UploadIcon />
                    <span style={{ marginLeft: '6px' }}>{uploading ? 'Uploading...' : 'Upload'}</span>
                </Button>
            </Modal.Footer>
        </Modal>
    );
}
