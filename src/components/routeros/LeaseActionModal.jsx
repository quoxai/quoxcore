/**
 * LeaseActionModal - DHCP Lease Actions
 *
 * Actions:
 * - Reserve IP (make static)
 * - Release lease
 * - Before/after preview
 */

import { useState } from 'react';
import { reserveLease, releaseLease } from '../../services/routerosClient';
import './routeros.css';

// Icons
const DHCPIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 11a9 9 0 0 1 9 9"/>
        <path d="M4 4a16 16 0 0 1 16 16"/>
        <circle cx="5" cy="19" r="2"/>
    </svg>
);

const CloseIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
);

function formatTimeRemaining(expiresAt) {
    if (!expiresAt) return 'Never (Static)';

    const now = new Date();
    const expires = new Date(expiresAt);
    const diff = expires - now;

    if (diff <= 0) return 'Expired';

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) return `${hours}h ${minutes}m remaining`;
    return `${minutes}m remaining`;
}

export default function LeaseActionModal({ lease, routerId, onClose }) {
    const [action, setAction] = useState(null);
    const [processing, setProcessing] = useState(false);
    const [result, setResult] = useState(null);

    const handleReserve = async () => {
        setProcessing(true);
        try {
            const res = await reserveLease(routerId, lease.id);
            setResult({ success: true, message: 'IP address reserved successfully!' });
        } catch (err) {
            setResult({ success: false, message: err.message || 'Failed to reserve IP' });
        } finally {
            setProcessing(false);
        }
    };

    const handleRelease = async () => {
        setProcessing(true);
        try {
            const res = await releaseLease(routerId, lease.id);
            setResult({ success: true, message: 'Lease released successfully!' });
        } catch (err) {
            setResult({ success: false, message: err.message || 'Failed to release lease' });
        } finally {
            setProcessing(false);
        }
    };

    return (
        <div className="ros-modal">
            <div className="ros-modal__backdrop" onClick={onClose} />
            <div className="ros-modal__content">
                <div className="ros-modal__header">
                    <h2 className="ros-modal__title">
                        <DHCPIcon />
                        DHCP Lease
                    </h2>
                    <button className="ros-modal__close" onClick={onClose}>
                        <CloseIcon />
                    </button>
                </div>

                <div className="ros-modal__body">
                    {/* Lease Info Preview */}
                    <div className="ros-lease-action__preview">
                        <div className="ros-lease-action__row">
                            <span className="ros-lease-action__label">IP Address</span>
                            <span className="ros-lease-action__value">{lease.ip}</span>
                        </div>
                        <div className="ros-lease-action__row">
                            <span className="ros-lease-action__label">Hostname</span>
                            <span className="ros-lease-action__value">{lease.hostname || 'Unknown'}</span>
                        </div>
                        <div className="ros-lease-action__row">
                            <span className="ros-lease-action__label">MAC Address</span>
                            <span className="ros-lease-action__value">{lease.mac}</span>
                        </div>
                        <div className="ros-lease-action__row">
                            <span className="ros-lease-action__label">Vendor</span>
                            <span className="ros-lease-action__value">{lease.vendor || 'Unknown'}</span>
                        </div>
                        <div className="ros-lease-action__row">
                            <span className="ros-lease-action__label">Type</span>
                            <span className="ros-lease-action__value">
                                {lease.isStatic ? 'Static Reservation' : 'Dynamic Lease'}
                            </span>
                        </div>
                        <div className="ros-lease-action__row">
                            <span className="ros-lease-action__label">Expires</span>
                            <span className="ros-lease-action__value">
                                {formatTimeRemaining(lease.expires)}
                            </span>
                        </div>
                    </div>

                    {/* Result Message */}
                    {result && (
                        <div style={{
                            padding: '12px 16px',
                            background: result.success ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                            border: `1px solid ${result.success ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                            borderRadius: '8px',
                            color: result.success ? '#10b981' : '#ef4444',
                            marginBottom: '16px'
                        }}>
                            {result.message}
                        </div>
                    )}

                    {/* Info about actions */}
                    {!result && (
                        <div style={{ color: 'var(--m-text-secondary)', fontSize: '14px', lineHeight: '1.5' }}>
                            <p style={{ margin: '0 0 12px' }}>
                                <strong>Reserve IP:</strong> Makes this IP address permanently assigned to this device.
                                The device will always get the same IP address.
                            </p>
                            <p style={{ margin: '0' }}>
                                <strong>Release Lease:</strong> Removes this lease and frees up the IP address
                                for other devices.
                            </p>
                        </div>
                    )}
                </div>

                <div className="ros-modal__footer">
                    {!result ? (
                        <>
                            {!lease.isStatic && (
                                <button
                                    className="ros-modal__btn ros-modal__btn--primary"
                                    onClick={handleReserve}
                                    disabled={processing}
                                >
                                    {processing ? 'Processing...' : 'Reserve IP'}
                                </button>
                            )}
                            <button
                                className="ros-modal__btn ros-modal__btn--danger"
                                onClick={handleRelease}
                                disabled={processing}
                            >
                                {processing ? 'Processing...' : 'Release Lease'}
                            </button>
                            <button
                                className="ros-modal__btn"
                                onClick={onClose}
                            >
                                Cancel
                            </button>
                        </>
                    ) : (
                        <button
                            className="ros-modal__btn ros-modal__btn--primary"
                            onClick={onClose}
                        >
                            Close
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
