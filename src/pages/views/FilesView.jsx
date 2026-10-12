/**
 * FilesView - File Management View
 *
 * Provides file management capabilities including:
 * - File upload and storage
 * - Image and document preview
 * - Search and filtering
 * - Storage usage tracking
 */

import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
// LICENSE-LAUNCH LL-7 increment 3h: import FileManager DIRECTLY, not through the
// components/files barrel. FileManager is a coreModule of the stripped files
// bundle; routing the import through the barrel would make the barrel import a
// coreModule and trip the ESLint strip boundary. FilesView is the only consumer
// of FileManager, so the direct edge is the whole story.
import { FileManager } from '../../components/files/FileManager';
import './views.css';
import './files-view.css';

function FilesView() {
    const { halState } = useOutletContext() || {};

    return (
        <div className="files-view view-page">
            <div className="files-view__content">
                <FileManager />
            </div>
        </div>
    );
}

export default FilesView;
