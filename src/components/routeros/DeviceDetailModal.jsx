/**
 * DeviceDetailModal - Full Device Info and Actions
 *
 * Displays:
 * - All device properties
 * - Traffic history
 * - Block/unblock actions
 * - Create static reservation
 */

import { useState } from 'react';
import { blockDevice, unblockDevice } from '../../services/routerosClient';
import './routeros.css';

// Icons
const DeviceIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
);

const CloseIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
);

const ChatIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
);

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(timestamp) {
    if (!timestamp) return 'Unknown';
    return new Date(timestamp).toLocaleString();
}

export default function DeviceDetailModal({ device, routerId, onClose, onAskNetwatch }) {
    const [blocking, setBlocking] = useState(false);
    const [blocked, setBlocked] = useState(device.blocked || false);

    const handleBlock = async () => {
        setBlocking(true);
        try {
            if (blocked) {
                await unblockDevice(routerId, device.id);
                setBlocked(false);
            } else {
                await blockDevice(routerId, device.id);
                setBlocked(true);
            }
        } catch (err) {
            console.error('Failed to block/unblock device:', err);
        } finally {
            setBlocking(false);
        }
    };

    const handleAskNetwatch = () => {
        onAskNetwatch(`Tell me more about the device "${device.hostname || device.ip}". Is it safe? What is it doing on my network?`);
        onClose();
    };

    return (
        <div className="ros-modal">
            <div className="ros-modal__backdrop" onClick={onClose} />
            <div className="ros-modal__content">
                <div className="ros-modal__header">
                    <h2 className="ros-modal__title">
                        <DeviceIcon />
                        Device Details
                    </h2>
                    <button className="ros-modal__close" onClick={onClose}>
                        <CloseIcon />
                    </button>
                </div>

                <div className="ros-modal__body">
                    {/* Basic Info */}
                    <div className="ros-device-detail__section">
                        <h3 className="ros-device-detail__section-title">Basic Information</h3>
                        <div className="ros-device-detail__grid">
                            <div className="ros-device-detail__item">
                                <span className="ros-device-detail__label">Hostname</span>
                                <span className="ros-device-detail__value">
                                    {device.hostname || 'Unknown'}
                                </span>
                            </div>
                            <div className="ros-device-detail__item">
                                <span className="ros-device-detail__label">Status</span>
                                <span className="ros-device-detail__value" style={{
                                    color: device.status === 'online' ? '#10b981' : '#6b7280'
                                }}>
                                    {device.status === 'online' ? 'Online' : 'Offline'}
                                </span>
                            </div>
                            <div className="ros-device-detail__item">
                                <span className="ros-device-detail__label">IP Address</span>
                                <span className="ros-device-detail__value">{device.ip}</span>
                            </div>
                            <div className="ros-device-detail__item">
                                <span className="ros-device-detail__label">MAC Address</span>
                                <span className="ros-device-detail__value">{device.mac}</span>
                            </div>
                            <div className="ros-device-detail__item">
                                <span className="ros-device-detail__label">Vendor</span>
                                <span className="ros-device-detail__value">{device.vendor || 'Unknown'}</span>
                            </div>
                            <div className="ros-device-detail__item">
                                <span className="ros-device-detail__label">Device Type</span>
                                <span className="ros-device-detail__value" style={{ textTransform: 'capitalize' }}>
                                    {device.type || 'Unknown'}
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* Traffic Stats */}
                    <div className="ros-device-detail__section">
                        <h3 className="ros-device-detail__section-title">Traffic Statistics</h3>
                        <div className="ros-device-detail__grid">
                            <div className="ros-device-detail__item">
                                <span className="ros-device-detail__label">Download</span>
                                <span className="ros-device-detail__value">
                                    {formatBytes(device.trafficIn)}
                                </span>
                            </div>
                            <div className="ros-device-detail__item">
                                <span className="ros-device-detail__label">Upload</span>
                                <span className="ros-device-detail__value">
                                    {formatBytes(device.trafficOut)}
                                </span>
                            </div>
                            <div className="ros-device-detail__item">
                                <span className="ros-device-detail__label">Last Seen</span>
                                <span className="ros-device-detail__value">
                                    {formatDate(device.lastSeen)}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="ros-modal__footer">
                    <button
                        className="ros-modal__btn"
                        onClick={handleAskNetwatch}
                    >
                        <ChatIcon />
                        Ask NETWATCH
                    </button>
                    <button
                        className={`ros-modal__btn ${blocked ? '' : 'ros-modal__btn--danger'}`}
                        onClick={handleBlock}
                        disabled={blocking}
                    >
                        {blocking ? 'Processing...' : blocked ? 'Unblock Device' : 'Block Device'}
                    </button>
                    <button
                        className="ros-modal__btn ros-modal__btn--primary"
                        onClick={onClose}
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
