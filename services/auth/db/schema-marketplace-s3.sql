-- ============================================================================
-- Marketplace Schema — Stream 3 (Install Tracking + User Reviews)
-- ============================================================================

-- Plugin installs (tracks who installed what)
CREATE TABLE IF NOT EXISTS marketplace_installs (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    listing_version_id TEXT NOT NULL REFERENCES listing_versions(id),
    org_id TEXT NOT NULL REFERENCES orgs(id),
    installed_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'uninstalled')),
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    uninstalled_at TEXT,
    UNIQUE(listing_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_mp_installs_listing ON marketplace_installs(listing_id);
CREATE INDEX IF NOT EXISTS idx_mp_installs_org ON marketplace_installs(org_id);
CREATE INDEX IF NOT EXISTS idx_mp_installs_status ON marketplace_installs(status);

-- User reviews / ratings
CREATE TABLE IF NOT EXISTS marketplace_reviews (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    user_id TEXT NOT NULL,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    title TEXT,
    body TEXT,
    status TEXT NOT NULL DEFAULT 'published'
        CHECK (status IN ('published', 'hidden', 'flagged')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(listing_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_mp_reviews_listing ON marketplace_reviews(listing_id);
CREATE INDEX IF NOT EXISTS idx_mp_reviews_user ON marketplace_reviews(user_id);

-- Listing stats (denormalized for fast browse queries)
CREATE TABLE IF NOT EXISTS listing_stats (
    listing_id TEXT PRIMARY KEY REFERENCES listings(id),
    install_count INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    average_rating REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
