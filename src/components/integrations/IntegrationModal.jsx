/**
 * IntegrationModal Component
 *
 * Multi-step modal for adding/editing integration credentials.
 * Step 1: Select integration type
 * Step 2: Configure credentials
 * Step 3: Test & confirm (optional)
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Input, Textarea } from '../ui/Input';
import { csrfFetch } from '../../utils/csrfFetch';
import { VAULT_TEST_CREDENTIALS } from '../../config/apiPaths';
import { INTEGRATION_TYPES, validateCredentials, getIntegrationsByCategory } from '../../config/integrationTypes';
import { useIntegrationTypes } from '../../hooks/useIntegrationTypes';

// Search icon
const SearchIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
);

// Clear icon
const ClearIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
);

// Check icon
const CheckIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="20 6 9 17 4 12" />
    </svg>
);

// Error icon
const ErrorIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
);

// Brand SVG icons for each integration type
export const typeIcons = {
    // AI Services
    openai: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/>
        </svg>
    ),
    anthropic: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M17.304 3H13.43l4.915 18h3.875L17.304 3zm-6.608 0L3 21h3.875l1.488-3.594h6.394l1.488 3.594H20.12L13.429 3h-2.733zm-.464 11.812l2.278-5.5 2.278 5.5H10.232z"/>
        </svg>
    ),
    gemini: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zm0 3.6c4.638 0 8.4 3.762 8.4 8.4s-3.762 8.4-8.4 8.4S3.6 16.638 3.6 12 7.362 3.6 12 3.6z"/>
        </svg>
    ),
    elevenlabs: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M8 4v16h2V4H8zm6 0v16h2V4h-2z"/>
        </svg>
    ),

    // Automation
    n8n: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 2.5l6.9 3.45L12 11.4 5.1 7.95 12 4.5zM4 8.93l7 3.5v7.64l-7-3.5V8.93zm9 11.14V12.43l7-3.5v7.64l-7 3.5z"/>
        </svg>
    ),

    // Messaging
    telegram: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
        </svg>
    ),
    slack: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
        </svg>
    ),

    // Email
    gmail: (
        <svg viewBox="0 0 24 24" style={{ width: 20, height: 20 }}>
            <path fill="#4285F4" d="M22.5 6.75v10.5A2.25 2.25 0 0120.25 19.5h-2.63V10.8l-5.62 4.22-5.62-4.22v8.7H3.75A2.25 2.25 0 011.5 17.25V6.75z"/>
            <path fill="#EA4335" d="M1.5 6.75l10.5 7.88 10.5-7.88a2.25 2.25 0 00-2.25-2.25H3.75A2.25 2.25 0 001.5 6.75z"/>
            <path fill="#34A853" d="M3.75 4.5h1.9l6.35 4.77L18.35 4.5h1.9c.35 0 .68.09.97.25L12 12.5 2.78 4.75c.29-.16.62-.25.97-.25z"/>
        </svg>
    ),
    icloud: (
        <svg viewBox="0 0 24 24" fill="#3D9BE9">
            <path d="M15.85 9.02a5.3 5.3 0 00-5.03-3.65 5.32 5.32 0 00-4.9 3.27A4.1 4.1 0 002.5 12.5a4.12 4.12 0 004.12 4.12h9a3.75 3.75 0 00.23-7.5z"/>
        </svg>
    ),
    outlook: (
        <svg viewBox="0 0 24 24" fill="#0F6CBD">
            <path d="M21.5 4.5h-9.75a.75.75 0 00-.75.75v3.19l5.44 3.4a.9.9 0 00.96 0l5.35-3.35V5.25a.75.75 0 00-.75-.75zm.75 5.78l-5.14 3.22a1.65 1.65 0 01-1.76 0l-5.3-3.31v8.06c0 .41.34.75.75.75H21.5c.41 0 .75-.34.75-.75V10.28zM9 6h-.5A5.75 5.75 0 003 12v0a5.75 5.75 0 005.75 5.75H9V21l-6.5-3.86a2.25 2.25 0 01-1.11-1.94V8.8c0-.8.42-1.53 1.11-1.94L9 3v3z"/>
        </svg>
    ),

    // Developer Tools
    github: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
        </svg>
    ),
    gitlab: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 00-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 00-.867 0L1.386 9.452.044 13.587a.924.924 0 00.331 1.023L12 23.054l11.625-8.443a.92.92 0 00.33-1.024"/>
        </svg>
    ),
    bitbucket: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z"/>
        </svg>
    ),
    circleci: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M8.88 12a3.12 3.12 0 106.24 0 3.12 3.12 0 00-6.24 0zM12 0C6.35 0 1.56 3.97.28 9.27a.73.73 0 00.52.88c.1.03.21.03.31 0a.74.74 0 00.51-.44 10.5 10.5 0 0120.76 0 .74.74 0 00.51.44c.1.03.21.03.31 0a.73.73 0 00.52-.88C22.44 3.97 17.65 0 12 0z"/>
        </svg>
    ),
    jenkins: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M4.875 7.5c0-1.036.84-1.875 1.875-1.875A1.875 1.875 0 018.625 7.5c0 1.036-.84 1.875-1.875 1.875A1.875 1.875 0 014.875 7.5zM12 2.25c5.385 0 9.75 4.365 9.75 9.75s-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12 6.615 2.25 12 2.25zm0 1.5a8.25 8.25 0 100 16.5 8.25 8.25 0 000-16.5zm3.375 5.25c0-1.036.84-1.875 1.875-1.875A1.875 1.875 0 0119.125 9c0 1.036-.84 1.875-1.875 1.875A1.875 1.875 0 0115.375 9zM8.25 15c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125s-.504 1.125-1.125 1.125h-5.25A1.125 1.125 0 018.25 15z"/>
        </svg>
    ),
    docker: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288z"/>
        </svg>
    ),
    vercel: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M24 22.525H0l12-21.05 12 21.05z"/>
        </svg>
    ),
    netlify: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M16.934 8.519a1.044 1.044 0 01.303.23l2.349-1.045-2.192-2.171-.491 2.954zM12.06 6.546a1.305 1.305 0 01.209.574l3.497 1.482a1.044 1.044 0 01.355-.177l.574-3.55-2.13-2.109-2.505 3.78zm-1.04 2.179v-.161a1.33 1.33 0 01-.04-.544l-3.674-1.47-.106.282 3.82 1.893zm-.627-.018L6.72 6.86l-2.9 2.879 3.9-.907c.428 0 .626-.168.842-.418l-.075.293zm-5.072 3.106l3.62-.534-.145.156c0 .168.04.336.121.483l-2.715 1.357-4.476-.906 3.595-.556zm10.108 1.289l2.958-.656-.838-.828-2.12.934v.55zM12.257 0L.72 11.427l.96 2.141 1.262.273 4.186.907 2.7-1.35.07-.07a1.56 1.56 0 001.134-.091l4.15 2.434.554-.09.067-.067 3.014-.668.238-.573-2.49-2.466a1.044 1.044 0 01-.278.038h-.131l-3.27 1.439a1.518 1.518 0 01-.092.168l-4.136-2.423a1.357 1.357 0 01-.109-.722l.096-.096.036-.042 3.56-1.569a1.044 1.044 0 01.04-.353l-3.687-1.564a1.33 1.33 0 01-.794.299h-.094l-3.87-1.918-.103-.103 2.669-4.034L12.257 0zm5.653 13.673l-2.262.502 2.06 2.04 3.163.418-2.961-2.96zm-2.91.658l-3.903.865-1.474.327a1.33 1.33 0 01-.817.36l-.218 1.828 6.669 2.979 2.191-2.152-2.449-4.207zm-5.808 1.33a1.128 1.128 0 01-.436-.321l-3.39.75-.317 3.412 6.99 3.094.196-1.53-2.826-1.264-.217-4.141zm-.911-.282l-3.362.746-.251 2.664 3.613-3.41z"/>
        </svg>
    ),
    railway: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M.113 10.27A12.375 12.375 0 000 12c0 1.151.157 2.266.45 3.324h3.263a32.666 32.666 0 01-.052-5.054H.113zm.457-1.761h3.578a19.29 19.29 0 01.964-3.584A12.046 12.046 0 00.57 8.509zm3.49 12.286a12.045 12.045 0 003.673 2.507c-.46-1.17-.811-2.386-1.047-3.635a26.61 26.61 0 01-2.626 1.128zm.676-5.463a31.054 31.054 0 00.633 4.016c.983-.282 1.936-.627 2.856-1.027a21.944 21.944 0 01-.756-4.51H4.126a31.39 31.39 0 00-.39 1.521zm1.36-5.07h3.672a24.426 24.426 0 01.621 4.01h3.803a24.426 24.426 0 01.621-4.01h3.671c.183.687.33 1.39.436 2.106a11.946 11.946 0 003.404-2.632 12.045 12.045 0 00-3.583-3.584c.46 1.171.81 2.387 1.047 3.636a26.571 26.571 0 012.626-1.129 12.004 12.004 0 00-5.893-3.27C14.11 1.49 13.082.965 12 .965s-2.11.525-3.073 1.324a12.004 12.004 0 00-5.893 3.27c.876.343 1.764.714 2.626 1.129a19.265 19.265 0 011.047-3.636 12.045 12.045 0 00-3.583 3.584c.106-.716.253-1.419.436-2.106zm7.665 11.533c-.4.069-.807.107-1.223.113v.005h-.078l-.078-.005a8.15 8.15 0 01-1.223-.113c-.425.92-.753 1.884-.982 2.879a12.074 12.074 0 004.566 0 15.63 15.63 0 00-.982-2.879z"/>
        </svg>
    ),
    render: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M10.263 24h3.43v-3.43h-3.43V24zm-5.14 0h3.43v-3.43h-3.43V24zm10.28 0h3.43v-3.43h-3.43V24zm5.14 0h3.43v-3.43h-3.43V24zM5.123 18.857h3.43v-3.43h-3.43v3.43zm5.14-5.143h3.43V10.28h-3.43v3.434zm5.14-5.143h3.43V5.143h-3.43v3.428zM.003 24h3.43v-3.43H.003V24zm5.12-10.286h3.43v-3.43h-3.43v3.43zM20.544.003h3.43v3.43h-3.43V.003zM.003 18.857h3.43v-3.43H.003v3.43zm5.12-5.143h3.43V10.28h-3.43v3.434zm0-5.143h3.43V5.143h-3.43v3.428zm0-5.143h3.43V.003h-3.43v3.425z"/>
        </svg>
    ),

    // Cloud Services
    aws: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 01-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 01-.287-.375 6.18 6.18 0 01-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 01-.28.104.488.488 0 01-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 01.224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 011.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 00-.735-.136 6.02 6.02 0 00-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 5.55a1.398 1.398 0 01-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 01.32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 01.311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 01-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 01-.303.08h-.687c-.151 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32l-1.238-5.148-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 01-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.319.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 00.415-.758.777.777 0 00-.215-.559c-.144-.151-.415-.287-.806-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 01-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .359.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 01.24.2.43.43 0 01.071.263v.375c0 .168-.064.256-.184.256a.83.83 0 01-.303-.096 3.652 3.652 0 00-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.159.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926-.144.272-.336.511-.583.703-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167zM21.698 16.207c-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.27-.351 3.384 1.963 7.559 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.439-.2.814.287.385.607zM22.792 14.961c-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151.32-.79 1.03-2.57.695-2.994z"/>
        </svg>
    ),
    gcp: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M12.19 2.38a9.344 9.344 0 00-9.234 6.893c.053-.02-.055.013 0 0-3.875 2.551-3.922 8.11-.247 10.941l.006-.007-.007.03a6.717 6.717 0 004.077 1.356h5.173l.03.03h5.192c6.687.053 9.376-8.605 3.835-12.35a9.365 9.365 0 00-8.825-6.893zm.142 1.576c3.45-.03 6.634 2.308 7.639 5.512l-.04-.03c-2.318-3.068-6.14-3.047-9.104-3.052a95.313 95.313 0 00-1.035.032c-.222-.006-.39.008-.576.025l.04-.04a7.782 7.782 0 013.076-2.447z"/>
        </svg>
    ),
    azure: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M5.483 21.3H24L14.025 4.013l-3.038 8.347 5.836 6.938L5.483 21.3zM13.23 2.7L6.105 8.677 0 19.253h5.505l7.725-16.553z"/>
        </svg>
    ),
    digitalocean: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M12.04 0C5.408-.02.005 5.37.005 11.992h4.638c0-4.923 4.882-8.731 10.064-6.855a6.95 6.95 0 014.147 4.148c1.889 5.177-1.924 10.055-6.84 10.064v-4.61H7.391v4.623h4.61V24c7.86 0 13.967-7.588 11.397-15.83-1.115-3.58-3.985-6.453-7.565-7.569A12.083 12.083 0 0012.039 0zM7.39 19.362H3.828v3.564H7.39zm-3.562 3.564H.936V20.04h2.892z"/>
        </svg>
    ),
    cloudflare: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 01-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0683-.0489 2.2285-.9063 2.6738-1.9746l.5625-1.3584c.0283-.0713.0713-.2388.042-.3232-.8936-4.0693-4.5765-7.1191-8.9867-7.1191-4.9248 0-8.9658 3.7207-9.4102 8.4814-.2032-.1406-.4282-.2247-.6751-.2247-.1709 0-.3421.0283-.499.0986-1.0693.4209-1.8428 1.3652-2.0386 2.4902C.1123 15.5771 0 15.7803 0 16.0059c0 .0566.0069.1132.0142.1699.0279.1972.1972.3584.4087.3584h15.9941c.1128 0 .2119-.0635.2607-.1562l.0703-.1337c.2149-.4277.6045-.792 1.0756-.9092z"/>
        </svg>
    ),

    // Social Media
    twitter: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/>
        </svg>
    ),
    linkedin: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
        </svg>
    ),
    meta: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 00.265.86c.083.263.19.544.319.838.121.278.258.54.412.78.248.39.544.74.876 1.037a3.63 3.63 0 002.442.933c1.478 0 2.648-.986 3.64-2.499.992-1.512 1.856-3.545 2.727-5.815.456-1.193.912-2.43 1.418-3.572a28.08 28.08 0 011.637-3.09c.574-.923 1.203-1.725 1.92-2.288.718-.563 1.512-.9 2.388-.9 1.252 0 2.088.556 2.6 1.312.528.778.768 1.845.768 3.04 0 1.806-.527 3.835-1.42 5.67-.893 1.833-2.162 3.457-3.725 4.473a6.236 6.236 0 01-1.018.565c-.91.41-1.932.628-3.056.628v2.482c1.431 0 2.748-.293 3.927-.84.39-.18.765-.39 1.12-.624 1.959-1.291 3.503-3.261 4.547-5.405 1.043-2.144 1.625-4.472 1.625-6.549 0-1.636-.343-3.103-1.123-4.253-.782-1.153-1.985-1.866-3.533-1.866-1.207 0-2.275.377-3.206 1.1a8.4 8.4 0 00-1.081 1.016c-.418.455-.808.966-1.183 1.519a31.423 31.423 0 00-1.726 3.256c-.502 1.073-.958 2.234-1.404 3.395-.87 2.27-1.655 4.333-2.485 5.66-.83 1.325-1.632 1.87-2.437 1.87a1.15 1.15 0 01-.738-.24c-.168-.147-.33-.387-.476-.73a5.142 5.142 0 01-.358-1.334 9.764 9.764 0 01-.117-1.573c0-2.18.57-4.478 1.534-6.29.965-1.816 2.29-3.093 3.796-3.093.453 0 .835.115 1.152.34l1.438-1.907a3.78 3.78 0 00-2.59-.916z"/>
        </svg>
    ),
    facebook: (
        <svg viewBox="0 0 24 24" fill="#1877F2">
            <path d="M15 4h-2a5 5 0 0 0-5 5v3H6v4h2v8h4v-8h3l1-4h-4V9a1 1 0 0 1 1-1h3z"/>
        </svg>
    ),
    instagram: (
        <svg viewBox="0 0 24 24" fill="none" stroke="#E4405F" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="5"/>
            <circle cx="12" cy="12" r="4"/>
            <circle cx="17.5" cy="6.5" r="1.2" fill="#E4405F" stroke="none"/>
        </svg>
    ),
    tiktok: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>
        </svg>
    ),

    // Documents & E-Signatures
    docusign: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M4.381 0A4.37 4.37 0 000 4.381v15.238A4.37 4.37 0 004.381 24h15.238A4.37 4.37 0 0024 19.619V4.381A4.37 4.37 0 0019.619 0H4.381zM6.34 5.616h6.055c.915 0 1.67.754 1.67 1.67v6.478c0 .915-.754 1.669-1.67 1.669H6.34c-.915 0-1.67-.754-1.67-1.67V7.287c0-.916.755-1.67 1.67-1.67zm.352 1.65a.336.336 0 00-.332.343v5.788c0 .19.149.343.332.343h5.36c.184 0 .333-.153.333-.343V7.61a.336.336 0 00-.332-.343H6.69z"/>
        </svg>
    ),
    adobesign: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M13.966 22.624l-1.69-4.281H8.122l-1.69 4.281H0l5.448-12.79L2.806 2.18h7.49l.658 1.68L13.61 2.18h7.49l-2.641 7.654 5.448 12.79h-6.433l-1.69-4.281h-4.154l-1.69 4.281h-.474zm3.628-9.916l-2.287-5.79-2.287 5.79h4.574z"/>
        </svg>
    ),
    adobepdf: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M23.598 19.811a1.26 1.26 0 01-.803 1.167c-.46.17-.95.22-1.433.145-.836-.082-1.63-.39-2.32-.9-.65-.467-1.22-1.04-1.71-1.67-.53.1-1.04.23-1.56.39-.51.15-1.01.32-1.51.51-.37.94-.81 1.85-1.32 2.71-.3.49-.66.95-1.08 1.34-.35.32-.76.56-1.21.69-.32.1-.66.08-.97-.05-.3-.13-.54-.35-.71-.63-.26-.48-.3-1.06-.09-1.57.2-.5.46-.97.77-1.42.4-.62.86-1.21 1.34-1.76.34-.39.7-.77 1.08-1.13.36-.89.68-1.79.94-2.71.23-.77.43-1.56.6-2.35-.38-.89-.68-1.82-.88-2.78-.14-.6-.21-1.22-.21-1.85 0-.54.08-1.07.25-1.58.15-.43.42-.81.77-1.11.26-.22.6-.33.94-.33.44 0 .86.17 1.18.47.37.38.61.87.68 1.4.12 1.04-.03 2.09-.44 3.06-.24.66-.54 1.29-.88 1.9.18.4.38.78.61 1.15.32.53.7 1.03 1.1 1.5.6-.08 1.21-.13 1.82-.13.61 0 1.23.05 1.83.15.46.09.9.25 1.31.48.35.2.63.5.82.85.2.4.25.86.14 1.29z"/>
        </svg>
    ),
    dropboxsign: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M12 0L4.5 4.5 12 9l7.5-4.5L12 0zM4.5 9L12 13.5 4.5 18V9zm15 0v9L12 13.5 19.5 9zM12 15l-7.5 4.5 7.5 4.5 7.5-4.5L12 15z"/>
        </svg>
    ),
    pandadoc: (
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
            <path d="M19.5 0h-15A4.5 4.5 0 000 4.5v15A4.5 4.5 0 004.5 24h15a4.5 4.5 0 004.5-4.5v-15A4.5 4.5 0 0019.5 0zm-3.188 17.25H7.688a.938.938 0 010-1.875h8.625a.938.938 0 010 1.875zm0-4.125H7.688a.938.938 0 010-1.875h8.625a.938.938 0 010 1.875zm0-4.125H7.688a.938.938 0 010-1.875h8.625a.938.938 0 010 1.875z"/>
        </svg>
    ),

    // Custom fallback
    custom: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
        </svg>
    )
};

/**
 * Repository scope lives in the credential's metadata (quoxai/quox#481).
 *
 * Credential resolution used to be per-ORG: an org holding several GitHub PATs
 * of different repo reach always got the org default, so a gripe about the
 * website was filed with a token that cannot see the website. Naming the repos
 * a credential covers is what lets the vault pick the right one.
 *
 * Tolerant of absent/malformed metadata: a credential that cannot state its
 * scope simply has none, rather than breaking the edit form.
 */
export function readRepos(integration) {
    if (!integration) return [];
    const raw = integration.metadata_json ?? integration.metadata;
    if (!raw) return [];
    let meta;
    try {
        meta = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_err) {
        return [];
    }
    return Array.isArray(meta?.repos) ? meta.repos.filter((r) => typeof r === 'string' && r.trim()) : [];
}

/**
 * Credential types whose secrets address repositories. Everything else (an LLM
 * key, an SMTP login) has no repo to scope to, so the field would be noise.
 */
export const REPO_SCOPED_TYPES = ['github', 'gitlab', 'bitbucket'];

/** Same grammar the CLI enforces: owner/name, owner/*, or * for everything. */
export function isValidRepoPattern(pattern) {
    if (pattern === '*' || pattern === '*/*') return true;
    return /^[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+|\*)$/.test(pattern);
}

export default function IntegrationModal({
    isOpen,
    onClose,
    onSave,
    editingIntegration,
    // Optional: pre-select a credential type and skip the type-picker step, so
    // a type-specific caller (e.g. InboxQ's mailbox connect) lands straight on
    // the credential fields. Defaults to null = the normal type-picker flow.
    presetType = null
}) {
    const isEditing = !!editingIntegration;

    // Integration types from registry (with API fetch + static fallback)
    const { types: integrationTypes, getType } = useIntegrationTypes();

    // State
    const [step, setStep] = useState(isEditing ? 2 : 1);
    const [selectedType, setSelectedType] = useState(editingIntegration?.integration_type || null);
    const [formData, setFormData] = useState({
        label: editingIntegration?.label || '',
        description: editingIntegration?.description || '',
        is_default: editingIntegration?.is_default || false,
        visibility: editingIntegration?.visibility || 'org',
        folder_id: editingIntegration?.folder_id || '',
        lease_required: editingIntegration?.lease_required || false,
        lease_max_duration_minutes: editingIntegration?.lease_max_duration_minutes || 120,
        lease_max_uses: editingIntegration?.lease_max_uses || '',
        repos: readRepos(editingIntegration).join(', '),
        credentials: {}
    });
    const [errors, setErrors] = useState({});
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);
    const [saveError, setSaveError] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');
    const searchInputRef = useRef(null);

    // Reset when modal opens/closes
    useEffect(() => {
        if (isOpen) {
            if (editingIntegration) {
                setStep(2);
                setSelectedType(editingIntegration.integration_type);
                setFormData({
                    label: editingIntegration.label || '',
                    description: editingIntegration.description || '',
                    is_default: editingIntegration.is_default || false,
                    visibility: editingIntegration.visibility || 'org',
                    folder_id: editingIntegration.folder_id || '',
                    lease_required: editingIntegration.lease_required || false,
                    lease_max_duration_minutes: editingIntegration.lease_max_duration_minutes || 120,
                    lease_max_uses: editingIntegration.lease_max_uses || '',
                    repos: readRepos(editingIntegration).join(', '),
                    credentials: {} // Always empty - must re-enter
                });
            } else {
                setStep(presetType ? 2 : 1);
                setSelectedType(presetType || null);
                setFormData({
                    label: '',
                    description: '',
                    is_default: false,
                    visibility: 'org',
                    folder_id: '',
                    lease_required: false,
                    lease_max_duration_minutes: 120,
                    lease_max_uses: '',
                    repos: '',
                    credentials: {}
                });
            }
            setErrors({});
            setTestResult(null);
            setSearchQuery('');
        }
    }, [isOpen, editingIntegration, presetType]);

    // Get selected type config
    const typeConfig = selectedType ? integrationTypes[selectedType] : null;

    // Handle type selection
    const handleTypeSelect = useCallback((typeId, autoAdvance = false) => {
        setSelectedType(typeId);
        const config = integrationTypes[typeId];

        // Pre-fill default values
        const credentials = {};
        if (config) {
            for (const field of config.fields) {
                if (field.default) {
                    credentials[field.key] = field.default;
                }
            }
        }

        setFormData(prev => ({
            ...prev,
            credentials,
            label: '' // Reset label when changing type
        }));
        setErrors({});

        if (autoAdvance) {
            setStep(2);
        }
    }, []);

    // Handle credential field change
    const handleFieldChange = useCallback((key, value) => {
        setFormData(prev => ({
            ...prev,
            credentials: {
                ...prev.credentials,
                [key]: value
            }
        }));

        // Clear error for this field
        setErrors(prev => {
            const newErrors = { ...prev };
            delete newErrors[key];
            return newErrors;
        });

        // Clear test result and save error when credentials change
        setTestResult(null);
        setSaveError(null);
    }, []);

    // Handle form field change
    const handleFormChange = useCallback((key, value) => {
        setFormData(prev => ({
            ...prev,
            [key]: value
        }));

        setErrors(prev => {
            const newErrors = { ...prev };
            delete newErrors[key];
            return newErrors;
        });
    }, []);

    // Validate step 2
    const validateStep2 = useCallback(() => {
        const newErrors = {};

        // Validate label
        if (!formData.label?.trim()) {
            newErrors.label = 'Label is required';
        } else if (formData.label.trim().length < 2) {
            newErrors.label = 'Label must be at least 2 characters';
        }

        // #481: reject a malformed repo pattern here, while the human can still
        // see what they typed. A typo'd pattern matches nothing and degrades
        // silently to the org default, which is the original wrong-token bug
        // wearing a config field.
        if (formData.repos?.trim()) {
            const bad = formData.repos.split(',').map((r) => r.trim()).filter(Boolean)
                .filter((r) => !isValidRepoPattern(r));
            if (bad.length > 0) {
                newErrors.repos = `Not a repository pattern: ${bad.join(', ')}. Use owner/name, owner/*, or *.`;
            }
        }

        // Validate credentials
        if (typeConfig) {
            const credValidation = validateCredentials(selectedType, formData.credentials);
            if (!credValidation.valid) {
                Object.assign(newErrors, credValidation.errors);
            }
        }

        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    }, [formData, selectedType, typeConfig]);

    // Handle next step
    const handleNext = useCallback(() => {
        if (step === 1 && selectedType) {
            setStep(2);
        } else if (step === 2) {
            if (validateStep2()) {
                handleSave();
            }
        }
    }, [step, selectedType, validateStep2]);

    // Handle back
    const handleBack = useCallback(() => {
        if (step === 2 && !isEditing) {
            setStep(1);
        }
    }, [step, isEditing]);

    // Handle test
    const handleTest = useCallback(async () => {
        if (!validateStep2()) return;

        setTesting(true);
        setTestResult(null);

        try {
            // For new integrations, we need to test via a temporary endpoint
            // For existing, we use the saved credential
            const orgId = localStorage.getItem('current_org_id');
            if (!orgId) {
                setTestResult({ success: false, message: 'No organization selected' });
                return;
            }
            const response = await csrfFetch(VAULT_TEST_CREDENTIALS(orgId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    integration_type: selectedType,
                    credentials: formData.credentials,
                    endpoint_url: formData.credentials.base_url
                })
            });

            const data = await response.json();
            // VAULT-INTEG P8: pass through the backend's real result_kind +
            // message instead of hardcoding "Connection successful" for
            // every success — a format-only pass (result_kind:
            // 'format_check', message already reads "... format check
            // only)") must never render identically to a real live probe.
            setTestResult({
                success: data.success,
                resultKind: data.result_kind,
                message: data.success
                    ? (data.message || 'Connection successful')
                    : (data.message || 'Connection failed')
            });
        } catch (err) {
            setTestResult({
                success: false,
                message: 'Failed to test connection'
            });
        } finally {
            setTesting(false);
        }
    }, [selectedType, formData, validateStep2]);

    // Handle save
    const handleSave = useCallback(async () => {
        if (!validateStep2()) return;

        setSaving(true);
        setSaveError(null);
        try {
            // #481: metadata is MERGED with whatever the credential already
            // carries. Other keys are load-bearing (a bootstrap SSH credential
            // is tagged {"purpose":"bootstrap"} and the collector's auto-revoke
            // path reads it), so a replacing write would silently disarm them.
            const existingMeta = (() => {
                const raw = editingIntegration?.metadata_json ?? editingIntegration?.metadata;
                if (!raw) return {};
                try {
                    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : {};
                } catch (_err) { return {}; }
            })();
            const repoList = (formData.repos || '').split(',').map((r) => r.trim()).filter(Boolean);
            if (repoList.length > 0) existingMeta.repos = repoList;
            else delete existingMeta.repos;

            await onSave({
                integration_type: selectedType,
                label: formData.label.trim(),
                metadata: existingMeta,
                description: formData.description?.trim() || null,
                credentials: formData.credentials,
                endpoint_url: formData.credentials.base_url || null,
                is_default: formData.is_default,
                visibility: formData.visibility,
                folder_id: formData.folder_id || null,
                lease_required: formData.lease_required ? 1 : 0,
                lease_max_duration_minutes: formData.lease_required ? (parseInt(formData.lease_max_duration_minutes, 10) || 120) : null,
                lease_max_uses: formData.lease_required && formData.lease_max_uses ? parseInt(formData.lease_max_uses, 10) : null
            });
        } catch (err) {
            setSaveError(err.message || 'Failed to save credential');
        } finally {
            setSaving(false);
        }
    }, [selectedType, formData, validateStep2, onSave]);

    // Get grouped types for step 1
    const groupedTypes = useMemo(() => getIntegrationsByCategory(), []);

    // Filter integrations based on search query
    const filteredGroupedTypes = useMemo(() => {
        if (!searchQuery.trim()) {
            return groupedTypes;
        }

        const query = searchQuery.toLowerCase().trim();
        const filtered = {};

        for (const [categoryId, category] of Object.entries(groupedTypes)) {
            if (categoryId === 'custom') continue; // Custom is always shown separately

            // Check if category name matches (guarded: a category id without
            // metadata produced a nameless bucket and crashed this useMemo on
            // the first keystroke, 2026-09-10; the generator now completes the
            // map, this guard makes the crash structurally impossible anyway)
            const categoryMatches = (category.name || categoryId).toLowerCase().includes(query);

            // Filter integrations within category
            const matchingIntegrations = category.integrations.filter(type => {
                if (type.id === 'custom') return false;

                // Match by name
                if ((type.name || type.id || '').toLowerCase().includes(query)) return true;

                // Match by description
                if (type.description?.toLowerCase().includes(query)) return true;

                // Match by category name
                if (categoryMatches) return true;

                return false;
            });

            if (matchingIntegrations.length > 0) {
                filtered[categoryId] = {
                    ...category,
                    integrations: matchingIntegrations
                };
            }
        }

        return filtered;
    }, [groupedTypes, searchQuery]);

    // Check if custom integration matches search
    const showCustomIntegration = useMemo(() => {
        if (!searchQuery.trim()) return true;
        const query = searchQuery.toLowerCase().trim();
        return 'custom'.includes(query) ||
               'custom integration'.includes(query) ||
               'connect any api with custom endpoint and authentication'.includes(query);
    }, [searchQuery]);

    // Check if there are any results
    const hasResults = useMemo(() => {
        return showCustomIntegration || Object.keys(filteredGroupedTypes).length > 0;
    }, [showCustomIntegration, filteredGroupedTypes]);

    // Handle search input change
    const handleSearchChange = useCallback((e) => {
        setSearchQuery(e.target.value);
    }, []);

    // Clear search
    const handleClearSearch = useCallback(() => {
        setSearchQuery('');
        searchInputRef.current?.focus();
    }, []);

    // Render the appropriate input widget for a credential field based on its declared type
    const renderFieldInput = useCallback((field) => {
        const value = formData.credentials[field.key] || '';
        const hasError = !!errors[field.key];

        switch (field.type) {
            case 'password':
                return (
                    <Input
                        type="password"
                        value={value}
                        onChange={(e) => handleFieldChange(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        error={hasError}
                    />
                );

            case 'url':
            case 'email':
            case 'number':
                return (
                    <Input
                        type={field.type}
                        value={value}
                        onChange={(e) => handleFieldChange(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        error={hasError}
                    />
                );

            case 'textarea':
                return (
                    <Textarea
                        value={value}
                        onChange={(e) => handleFieldChange(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        error={hasError}
                        rows={4}
                    />
                );

            // SSH private keys / TLS certs — PEM blobs, rendered monospace
            case 'pem':
            case 'key':
                return (
                    <Textarea
                        mono
                        value={value}
                        onChange={(e) => handleFieldChange(field.key, e.target.value)}
                        placeholder={field.placeholder || '-----BEGIN ...-----'}
                        error={hasError}
                        rows={6}
                    />
                );

            case 'select': {
                const options = Array.isArray(field.options) ? field.options : [];
                if (options.length === 0) {
                    // No options declared on the registry entry — fall back to text
                    return (
                        <Input
                            value={value}
                            onChange={(e) => handleFieldChange(field.key, e.target.value)}
                            placeholder={field.placeholder}
                            error={hasError}
                        />
                    );
                }
                return (
                    <select
                        value={value}
                        onChange={(e) => handleFieldChange(field.key, e.target.value)}
                        className="integration-modal__select"
                    >
                        <option value="">{field.placeholder || 'Select...'}</option>
                        {options.map(opt => {
                            const optValue = typeof opt === 'string' ? opt : opt.value;
                            const optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value);
                            return (
                                <option key={optValue} value={optValue}>{optLabel}</option>
                            );
                        })}
                    </select>
                );
            }

            // File upload for .pem/.key/.crt — read as text and store contents
            case 'file':
                return (
                    <input
                        type="file"
                        className="ui-input"
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = () => {
                                handleFieldChange(field.key, reader.result);
                            };
                            reader.readAsText(file);
                        }}
                    />
                );

            case 'text':
            default:
                return (
                    <Input
                        type="text"
                        value={value}
                        onChange={(e) => handleFieldChange(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        error={hasError}
                    />
                );
        }
    }, [formData.credentials, errors, handleFieldChange]);

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            size="lg"
        >
            <Modal.Header
                title={isEditing ? 'Edit Integration' : 'Add Integration'}
            />

            <Modal.Body>
                {/* Steps indicator */}
                <div className="integration-modal__steps">
                    <div className={`integration-modal__step ${step >= 1 ? 'integration-modal__step--completed' : ''} ${step === 1 ? 'integration-modal__step--active' : ''}`}>
                        <span className="integration-modal__step-number">1</span>
                        <span>Select Type</span>
                    </div>
                    <div className="integration-modal__step-divider" />
                    <div className={`integration-modal__step ${step >= 2 ? 'integration-modal__step--active' : ''}`}>
                        <span className="integration-modal__step-number">2</span>
                        <span>Configure</span>
                    </div>
                </div>

                {/* Step 1: Select Type */}
                {step === 1 && (
                    <div className="integration-modal__type-selection">
                        {/* Search Input */}
                        <div className="integration-modal__search">
                            <div className="integration-modal__search-icon">
                                <SearchIcon />
                            </div>
                            <input
                                ref={searchInputRef}
                                type="text"
                                className="integration-modal__search-input"
                                placeholder="Search 196+ integrations..."
                                value={searchQuery}
                                onChange={handleSearchChange}
                                autoFocus
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    className="integration-modal__search-clear"
                                    onClick={handleClearSearch}
                                    aria-label="Clear search"
                                >
                                    <ClearIcon />
                                </button>
                            )}
                        </div>

                        {/* Custom Integration - Sticky at top, outside scroll area */}
                        {showCustomIntegration && (
                            <button
                                type="button"
                                className={`integration-modal__custom-btn ${
                                    selectedType === 'custom' ? 'integration-modal__custom-btn--selected' : ''
                                }`}
                                onClick={() => handleTypeSelect('custom', true)}
                            >
                                <div className="integration-modal__custom-icon">
                                    {typeIcons.custom}
                                </div>
                                <div className="integration-modal__custom-info">
                                    <div className="integration-modal__custom-title">Custom Integration</div>
                                    <div className="integration-modal__custom-desc">
                                        Connect any API with custom endpoint and authentication
                                    </div>
                                </div>
                                <div className="integration-modal__custom-arrow">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <polyline points="9 18 15 12 9 6" />
                                    </svg>
                                </div>
                            </button>
                        )}

                        {/* No results message */}
                        {!hasResults && (
                            <div className="integration-modal__no-results">
                                <div className="integration-modal__no-results-icon">
                                    <SearchIcon />
                                </div>
                                <div className="integration-modal__no-results-text">
                                    No integrations found for "{searchQuery}"
                                </div>
                                <div className="integration-modal__no-results-hint">
                                    Try a different search term or use Custom Integration
                                </div>
                            </div>
                        )}

                        {/* Scrollable list container */}
                        {hasResults && Object.keys(filteredGroupedTypes).length > 0 && (
                            <div className="integration-modal__type-list">
                                {!searchQuery && (
                                    <div className="integration-modal__divider">
                                        <span>or choose a service</span>
                                    </div>
                                )}

                                {/* Categorized integrations */}
                                {Object.entries(filteredGroupedTypes)
                                    .filter(([categoryId]) => categoryId !== 'custom')
                                    .map(([categoryId, category]) => (
                                    <div key={categoryId} className="integration-modal__category">
                                        <div className="integration-modal__category-header">
                                            {category.name}
                                        </div>
                                        <div className="integration-modal__category-items">
                                            {category.integrations
                                                .filter(type => type.id !== 'custom')
                                                .map(type => (
                                                <button
                                                    key={type.id}
                                                    type="button"
                                                    className={`integration-modal__type-item ${
                                                        selectedType === type.id ? 'integration-modal__type-item--selected' : ''
                                                    }`}
                                                    onClick={() => handleTypeSelect(type.id)}
                                                >
                                                    <div className="integration-modal__type-radio">
                                                        {selectedType === type.id && (
                                                            <div className="integration-modal__type-radio-dot" />
                                                        )}
                                                    </div>
                                                    <div
                                                        className="integration-modal__type-icon"
                                                        style={{ color: type.color }}
                                                    >
                                                        {typeIcons[type.id] || typeIcons.custom}
                                                    </div>
                                                    <div className="integration-modal__type-info">
                                                        <div className="integration-modal__type-name">{type.name}</div>
                                                        <div className="integration-modal__type-desc">{type.description}</div>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Step 2: Configure */}
                {step === 2 && typeConfig && (
                    <div className="integration-modal__form">
                        {/* Label */}
                        <div className="integration-modal__field">
                            <label className="integration-modal__field-label integration-modal__field-label--required">
                                Label
                            </label>
                            <Input
                                value={formData.label}
                                onChange={(e) => handleFormChange('label', e.target.value)}
                                placeholder={`e.g., Production ${typeConfig.name}`}
                                error={!!errors.label}
                            />
                            {errors.label && (
                                <span className="integration-modal__field-error">{errors.label}</span>
                            )}
                            <span className="integration-modal__field-help">
                                A unique name to identify this integration
                            </span>
                        </div>

                        {/* Repository scope — #481. Only meaningful for credentials
                            that address repositories, so it is shown for those types
                            rather than on every credential in the vault. */}
                        {REPO_SCOPED_TYPES.includes(selectedType) && (
                            <div className="integration-modal__field">
                                <label className="integration-modal__field-label">Repositories</label>
                                <Input
                                    value={formData.repos}
                                    onChange={(e) => handleFormChange('repos', e.target.value)}
                                    placeholder="quoxai/quox, quoxai/quoxflow, or quoxai/*"
                                    error={!!errors.repos}
                                />
                                {errors.repos && (
                                    <span className="integration-modal__field-error">{errors.repos}</span>
                                )}
                                <span className="integration-modal__field-help">
                                    Which repositories this token covers, comma separated. Use
                                    {' '}<code>owner/*</code> for everything under an owner. Leave empty and this
                                    credential is only reached as the org default, which means one token
                                    serves every repository.
                                </span>
                            </div>
                        )}

                        {/* Visibility + Folder row */}
                        <div style={{ display: 'flex', gap: '12px' }}>
                            <div className="integration-modal__field" style={{ flex: 1 }}>
                                <label className="integration-modal__field-label">Visibility</label>
                                <select
                                    value={formData.visibility}
                                    onChange={(e) => handleFormChange('visibility', e.target.value)}
                                    className="integration-modal__select"
                                >
                                    <option value="org">Organization (all members)</option>
                                    <option value="team">Team only</option>
                                    <option value="personal">Personal (only me)</option>
                                </select>
                                <span className="integration-modal__field-help">
                                    Who can see and use this credential
                                </span>
                            </div>
                            <div className="integration-modal__field" style={{ flex: 1 }}>
                                <label className="integration-modal__field-label">Folder</label>
                                <select
                                    value={formData.folder_id}
                                    onChange={(e) => handleFormChange('folder_id', e.target.value)}
                                    className="integration-modal__select"
                                >
                                    <option value="">No folder</option>
                                </select>
                                <span className="integration-modal__field-help">
                                    Organize into a folder (manage in Folders view)
                                </span>
                            </div>
                        </div>

                        {/* Credential fields */}
                        {typeConfig.fields.map(field => (
                            <div key={field.key} className="integration-modal__field">
                                <label className={`integration-modal__field-label ${field.required ? 'integration-modal__field-label--required' : ''}`}>
                                    {field.label}
                                </label>
                                {renderFieldInput(field)}
                                {errors[field.key] && (
                                    <span className="integration-modal__field-error">{errors[field.key]}</span>
                                )}
                                {field.helpText && (
                                    <span className="integration-modal__field-help">{field.helpText}</span>
                                )}
                            </div>
                        ))}

                        {/* Description (optional) */}
                        <div className="integration-modal__field">
                            <label className="integration-modal__field-label">
                                Description (optional)
                            </label>
                            <Input
                                value={formData.description}
                                onChange={(e) => handleFormChange('description', e.target.value)}
                                placeholder="Notes about this integration"
                            />
                        </div>

                        {/* Set as default checkbox */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                                type="checkbox"
                                id="is_default"
                                checked={formData.is_default}
                                onChange={(e) => handleFormChange('is_default', e.target.checked)}
                                style={{ width: '16px', height: '16px' }}
                            />
                            <label htmlFor="is_default" style={{ fontSize: '14px', color: 'var(--ui-text-secondary)' }}>
                                Set as default for {typeConfig.name}
                            </label>
                        </div>

                        {/* Lease required toggle */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                                type="checkbox"
                                id="lease_required"
                                checked={formData.lease_required}
                                onChange={(e) => handleFormChange('lease_required', e.target.checked)}
                                style={{ width: '16px', height: '16px' }}
                            />
                            <label htmlFor="lease_required" style={{ fontSize: '14px', color: 'var(--ui-text-secondary)' }}>
                                Require agent lease (JIT access with human approval)
                            </label>
                        </div>

                        {/* Lease settings (shown when lease_required is enabled) */}
                        {formData.lease_required && (
                            <div style={{ display: 'flex', gap: '12px', paddingLeft: '24px', borderLeft: '2px solid var(--ui-border)', marginLeft: '0' }}>
                                <div className="integration-modal__field" style={{ flex: 1 }}>
                                    <label className="integration-modal__field-label">Max duration (minutes)</label>
                                    <Input
                                        type="number"
                                        value={formData.lease_max_duration_minutes}
                                        onChange={(e) => handleFormChange('lease_max_duration_minutes', e.target.value)}
                                        placeholder="120"
                                        min="1"
                                    />
                                    <span className="integration-modal__field-help">
                                        Maximum lease duration an approver can grant
                                    </span>
                                </div>
                                <div className="integration-modal__field" style={{ flex: 1 }}>
                                    <label className="integration-modal__field-label">Max uses per lease</label>
                                    <Input
                                        type="number"
                                        value={formData.lease_max_uses}
                                        onChange={(e) => handleFormChange('lease_max_uses', e.target.value)}
                                        placeholder="Unlimited"
                                        min="1"
                                    />
                                    <span className="integration-modal__field-help">
                                        Leave empty for unlimited uses within TTL
                                    </span>
                                </div>
                            </div>
                        )}

                        {/* Test result */}
                        {testResult && (
                            <div className={`integration-modal__test-result integration-modal__test-result--${testResult.success ? 'success' : 'error'}${testResult.success && testResult.resultKind === 'format_check' ? ' integration-modal__test-result--format-only' : ''}`}>
                                <span className="integration-modal__test-result__icon">
                                    {testResult.success ? <CheckIcon /> : <ErrorIcon />}
                                </span>
                                {testResult.message}
                                {testResult.success && testResult.resultKind === 'format_check' && (
                                    <span className="integration-modal__test-result__badge" title="Format check only, no live connection made">
                                        format check only
                                    </span>
                                )}
                            </div>
                        )}

                        {/* Security notice */}
                        {isEditing && (
                            <div style={{
                                padding: '12px',
                                background: 'rgba(255, 176, 48, 0.1)',
                                border: '1px solid rgba(255, 176, 48, 0.2)',
                                borderRadius: '8px',
                                fontSize: '13px',
                                color: 'var(--ui-amber)'
                            }}>
                                <strong>Security:</strong> You must re-enter your credentials when editing.
                                Stored keys cannot be viewed or copied.
                            </div>
                        )}
                    </div>
                )}

                {saveError && (
                    <div style={{
                        marginTop: '16px',
                        padding: '12px',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        borderRadius: '8px',
                        fontSize: '13px',
                        color: '#ef4444',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px'
                    }}>
                        <ErrorIcon />
                        <span>{saveError}</span>
                    </div>
                )}
            </Modal.Body>

            <Modal.Footer>
                {step === 1 && (
                    <>
                        <Button variant="secondary" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleNext}
                            disabled={!selectedType}
                        >
                            Continue
                        </Button>
                    </>
                )}

                {step === 2 && (
                    <>
                        {!isEditing && (
                            <Button variant="ghost" onClick={handleBack}>
                                Back
                            </Button>
                        )}
                        <Button variant="secondary" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            variant="secondary"
                            onClick={handleTest}
                            disabled={testing || saving}
                        >
                            {testing ? 'Testing...' : 'Test Connection'}
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleSave}
                            disabled={saving}
                        >
                            {saving ? 'Saving...' : (isEditing ? 'Save Changes' : 'Add Integration')}
                        </Button>
                    </>
                )}
            </Modal.Footer>
        </Modal>
    );
}
