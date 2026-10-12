/**
 * MemoryView - Memory System Dashboard
 *
 * Provides access to all memory management features including:
 * - Memory Dashboard overview
 * - Search across all memory types
 * - Visualization and management
 * - Tier status and settings
 */

import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { MemoryDashboard } from '../../components/memory';
import './views.css';
import './memory-view.css';

function MemoryView() {
    const { halState } = useOutletContext() || {};

    return (
        <div className="memory-view view-page">
            <div className="memory-view__content">
                <MemoryDashboard />
            </div>
        </div>
    );
}

export default MemoryView;
