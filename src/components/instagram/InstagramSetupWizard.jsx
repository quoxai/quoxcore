/**
 * InstagramSetupWizard — Guided onboarding for the Instagram plugin. IG-3.
 *
 * Unlike FacebookSetupWizard, this wizard does NOT ask for a second pasted
 * credential. Instagram is its own plugin SKU on the SAME shared Meta
 * foundation as the facebook plugin: one vaulted Page access token powers
 * both. The wizard's job is to DISCOVER the Instagram professional account
 * linked to a Facebook Page and let the user confirm/save it — never to
 * collect a token.
 *
 * Flow:
 *   1. Explain the shared credential (link to Vault if none exists yet).
 *   2. Run discover_account (optionally scoped to one Facebook Page ID) and
 *      show the resolved account for the user to confirm.
 *   3. Save { igUserId, setupComplete: true } via onSave — state-based, no
 *      page reload.
 */

import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { discoverAccount } from '../../services/instagramClient'
import './instagram-setup.css'

function InstagramLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="igs-logo">
      <rect x="3" y="3" width="18" height="18" rx="5" stroke="rgba(228, 64, 95, 0.9)" strokeWidth="1.8"/>
      <circle cx="12" cy="12" r="4" stroke="rgba(228, 64, 95, 0.9)" strokeWidth="1.8"/>
      <circle cx="17.5" cy="6.5" r="1.2" fill="rgba(228, 64, 95, 0.9)"/>
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="igs-icon-check">
      <circle cx="10" cy="10" r="9" stroke="rgba(52, 211, 153, 0.7)" strokeWidth="1.5"/>
      <path d="M6 10l3 3 5-5" stroke="rgba(52, 211, 153, 0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function TipIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="igs-icon-tip">
      <circle cx="8" cy="8" r="7" stroke="rgba(228, 64, 95, 0.6)" strokeWidth="1.2"/>
      <path d="M8 5v3M8 10.5v.5" stroke="rgba(228, 64, 95, 0.8)" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

export default function InstagramSetupWizard({ onSave }) {
  const navigate = useNavigate()
  const { authFetch } = useAuth()
  const [step, setStep] = useState('intro')
  const [pageId, setPageId] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [discovered, setDiscovered] = useState(null)
  const [discoverError, setDiscoverError] = useState(null)

  const handleDiscover = useCallback(async () => {
    setDiscovering(true)
    setDiscoverError(null)
    setDiscovered(null)
    try {
      const account = await discoverAccount(authFetch, pageId.trim() || undefined)
      setDiscovered(account)
    } catch (err) {
      setDiscoverError(err.message)
    } finally {
      setDiscovering(false)
    }
  }, [authFetch, pageId])

  const handleConnect = useCallback(() => {
    if (!discovered?.ig_user_id) return
    onSave({
      igUserId: discovered.ig_user_id,
      username: discovered.username || null,
      linkedPageId: discovered.linked_page?.id || pageId.trim() || null,
      setupComplete: true,
    })
  }, [discovered, pageId, onSave])

  return (
    <div className="igs">
      <div className="igs-header">
        <InstagramLogo />
        <div>
          <h2 className="igs-header__title">Connect Instagram</h2>
          <p className="igs-header__sub">One Meta credential, two plugins</p>
        </div>
      </div>

      <div className="igs-content">
        {step === 'intro' && (
          <div className="igs-content__body">
            <p>
              Instagram is its own plugin here, but it runs on the SAME shared Meta
              credential as the Facebook plugin. If you have already connected Facebook,
              you do not need to paste anything new. Instagram is reached through the
              Instagram professional account linked to your Facebook Page.
            </p>
            <div className="igs-tip">
              <TipIcon />
              <span>
                No Facebook Page token in the vault yet?{' '}
                <button className="igs-link-btn-inline" onClick={() => navigate('/vault/credentials')}>
                  Open Vault Credentials
                </button>{' '}
                and add one first (type: Meta / Facebook).
              </span>
            </div>
            <div className="igs-products">
              <div className="igs-product">
                <CheckIcon />
                <div>
                  <strong>instagram_basic, instagram_content_publish</strong>
                  <span>Read the professional account and publish media</span>
                </div>
              </div>
              <div className="igs-product">
                <CheckIcon />
                <div>
                  <strong>pages_show_list, pages_read_engagement</strong>
                  <span>Resolve the Instagram account linked to your Page</span>
                </div>
              </div>
            </div>
            <button className="igs-nav__finish" onClick={() => setStep('discover')}>
              Continue to Discovery
            </button>
          </div>
        )}

        {step === 'discover' && (
          <div className="igs-content__body">
            <p>
              Discover the Instagram professional account linked to a Facebook Page. Leave
              the Page ID blank to check every Page your token can manage.
            </p>
            <div className="igs-field">
              <label className="igs-field__label">
                Facebook Page ID
                <span className="igs-field__optional">Optional</span>
              </label>
              <input
                className="igs-field__input"
                type="text"
                value={pageId}
                onChange={e => setPageId(e.target.value)}
                placeholder="e.g. 1234567890"
              />
            </div>
            <button className="igs-nav__skip" onClick={handleDiscover} disabled={discovering}>
              {discovering ? 'Discovering...' : 'Discover my Instagram account'}
            </button>

            {discoverError && (
              <div className="igs-result igs-result--error">{discoverError}</div>
            )}

            {discovered && (
              <div className="igs-result igs-result--success">
                <p style={{ margin: '0 0 8px' }}>
                  Found <strong>{discovered.username ? `@${discovered.username}` : discovered.ig_user_id}</strong>
                  {discovered.linked_page?.name ? <> linked to Page <strong>{discovered.linked_page.name}</strong></> : null}.
                </p>
                <button className="igs-nav__finish" onClick={handleConnect}>
                  Connect this account
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
