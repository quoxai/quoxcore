/**
 * Email provider onboarding presets.
 *
 * Single source of truth for the pre-filled IMAP/SMTP host and port values,
 * app-password help links, and the plain-language steps shown when a user
 * picks Gmail, iCloud or Outlook while connecting a mailbox. Kept in sync
 * by hand with the matching integration type definitions in
 * services/auth/config/integrationTypeRegistry.js (gmail/icloud/outlook).
 *
 * cli/lib/commands/mail.js keeps its own small copy of these values
 * (PROVIDER_PRESETS) since the CLI package cannot import from src/.
 */

export const EMAIL_PROVIDERS = {
    gmail: {
        id: 'gmail',
        label: 'Gmail',
        imapHost: 'imap.gmail.com',
        imapPort: 993,
        smtpHost: 'smtp.gmail.com',
        smtpPort: 465,
        smtpSecure: true,
        appPasswordUrl: 'https://myaccount.google.com/apppasswords',
        requires2fa: true,
        steps: [
            'Turn on 2-Step Verification for your Google account at myaccount.google.com/security.',
            'Go to myaccount.google.com/apppasswords and create a new app password.',
            'Paste the 16-character app password below. Do not use your normal Google password.'
        ]
    },
    icloud: {
        id: 'icloud',
        label: 'iCloud Mail',
        imapHost: 'imap.mail.me.com',
        imapPort: 993,
        smtpHost: 'smtp.mail.me.com',
        smtpPort: 587,
        smtpSecure: true,
        appPasswordUrl: 'https://appleid.apple.com',
        requires2fa: true,
        steps: [
            'Make sure two-factor authentication is enabled on your Apple ID.',
            'Sign in at appleid.apple.com, then go to Sign-In and Security, then App-Specific Passwords.',
            'Generate a new app-specific password and paste it below.'
        ]
    },
    outlook: {
        id: 'outlook',
        label: 'Outlook / Microsoft 365',
        imapHost: 'outlook.office365.com',
        imapPort: 993,
        smtpHost: 'smtp.office365.com',
        smtpPort: 587,
        smtpSecure: true,
        appPasswordUrl: 'https://account.microsoft.com/security',
        requires2fa: true,
        steps: [
            'Make sure two-step verification is enabled on your Microsoft account.',
            'Go to account.microsoft.com/security and create a new app password.',
            'Paste the app password below. Do not use your normal Microsoft password.'
        ]
    }
};

const DOMAIN_TO_PROVIDER = {
    'gmail.com': 'gmail',
    'googlemail.com': 'gmail',
    'icloud.com': 'icloud',
    'me.com': 'icloud',
    'mac.com': 'icloud',
    'outlook.com': 'outlook',
    'hotmail.com': 'outlook',
    'live.com': 'outlook',
    'msn.com': 'outlook'
};

/**
 * Return the matching EMAIL_PROVIDERS entry for an email address's domain,
 * or null if it isn't one of the known providers.
 */
export function providerForEmail(addr) {
    if (typeof addr !== 'string') return null;
    const at = addr.lastIndexOf('@');
    if (at === -1) return null;
    const domain = addr.slice(at + 1).trim().toLowerCase();
    const providerId = DOMAIN_TO_PROVIDER[domain];
    return providerId ? EMAIL_PROVIDERS[providerId] : null;
}

export default EMAIL_PROVIDERS;
