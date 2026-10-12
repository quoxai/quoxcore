/**
 * DeviceInventoryPanel - Connected Devices List
 *
 * Displays:
 * - Searchable/filterable device list
 * - Device type icons (phone, laptop, printer, etc.)
 * - MAC vendor lookup display
 * - Online/offline status dots
 * - Click for details modal
 */

import { useState, useMemo } from 'react';
import './routeros.css';

// Icons
const DevicesIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
);

const SearchIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8"/>
        <path d="m21 21-4.3-4.3"/>
    </svg>
);

const PhoneIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
        <line x1="12" y1="18" x2="12.01" y2="18"/>
    </svg>
);

const LaptopIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
        <line x1="2" y1="20" x2="22" y2="20"/>
    </svg>
);

const TvIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="7" width="20" height="15" rx="2" ry="2"/>
        <polyline points="17 2 12 7 7 2"/>
    </svg>
);

const PrinterIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="6 9 6 2 18 2 18 9"/>
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
        <rect x="6" y="14" width="12" height="8"/>
    </svg>
);

const IoTIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5 5 4 4 0 0 1-5-5 10 10 0 0 0 0-10"/>
        <circle cx="12" cy="12" r="3"/>
    </svg>
);

const UnknownIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10"/>
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
);

const DEVICE_ICONS = {
    phone: PhoneIcon,
    laptop: LaptopIcon,
    tv: TvIcon,
    printer: PrinterIcon,
    iot: IoTIcon,
    unknown: UnknownIcon
};

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function DeviceItem({ device, onClick }) {
    const Icon = DEVICE_ICONS[device.type] || DEVICE_ICONS.unknown;

    return (
        <button className="ros-device" onClick={() => onClick(device)}>
            <div className="ros-device__icon">
                <Icon />
            </div>
            <div className="ros-device__info">
                <div className="ros-device__name">
                    <span className={`ros-device__status ${device.status === 'offline' ? 'offline' : ''}`} />
                    {device.hostname || 'Unknown Device'}
                </div>
                <div className="ros-device__details">
                    <span className="ros-device__ip">{device.ip}</span>
                    <span className="ros-device__vendor">{device.vendor}</span>
                </div>
            </div>
        </button>
    );
}

export default function DeviceInventoryPanel({ devices = [], onSelectDevice }) {
    const [searchQuery, setSearchQuery] = useState('');
    const [filterStatus, setFilterStatus] = useState('all');

    const filteredDevices = useMemo(() => {
        return devices.filter(device => {
            // Status filter
            if (filterStatus !== 'all' && device.status !== filterStatus) {
                return false;
            }

            // Search filter
            if (searchQuery) {
                const query = searchQuery.toLowerCase();
                return (
                    device.hostname?.toLowerCase().includes(query) ||
                    device.ip?.toLowerCase().includes(query) ||
                    device.mac?.toLowerCase().includes(query) ||
                    device.vendor?.toLowerCase().includes(query)
                );
            }

            return true;
        });
    }, [devices, searchQuery, filterStatus]);

    const onlineCount = devices.filter(d => d.status === 'online').length;

    return (
        <div className="ros-panel">
            <div className="ros-panel__header">
                <h3 className="ros-panel__title">
                    <DevicesIcon />
                    Devices
                    <span style={{
                        marginLeft: '8px',
                        fontSize: '12px',
                        color: 'var(--m-text-tertiary)',
                        fontWeight: 'normal'
                    }}>
                        {onlineCount}/{devices.length} online
                    </span>
                </h3>
                <div className="ros-panel__actions">
                    <select
                        value={filterStatus}
                        onChange={(e) => setFilterStatus(e.target.value)}
                        style={{
                            padding: '4px 8px',
                            background: 'rgba(16, 185, 129, 0.05)',
                            border: '1px solid rgba(16, 185, 129, 0.2)',
                            borderRadius: '6px',
                            color: 'var(--m-text-secondary)',
                            fontSize: '12px'
                        }}
                    >
                        <option value="all">All</option>
                        <option value="online">Online</option>
                        <option value="offline">Offline</option>
                    </select>
                </div>
            </div>
            <div className="ros-panel__body">
                <div className="ros-devices__search">
                    <SearchIcon />
                    <input
                        type="text"
                        placeholder="Search devices..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>
                <div className="ros-devices__list">
                    {filteredDevices.length === 0 ? (
                        <div className="ros-alerts__empty">
                            <DevicesIcon />
                            <p>No devices found</p>
                        </div>
                    ) : (
                        filteredDevices.map(device => (
                            <DeviceItem
                                key={device.id}
                                device={device}
                                onClick={onSelectDevice}
                            />
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
