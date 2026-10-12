-- ============================================================================
-- Marketplace Schema (Stream 2: Developer Portal)
-- ============================================================================

-- Seller profiles (one per org)
CREATE TABLE IF NOT EXISTS sellers (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL UNIQUE REFERENCES orgs(id),
    display_name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    trust_level TEXT NOT NULL DEFAULT 'registered'
        CHECK (trust_level IN ('registered', 'developer', 'verified', 'trusted_partner', 'official')),
    github_username TEXT,
    bio TEXT,
    website TEXT,
    logo_path TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sellers_org ON sellers(org_id);
CREATE INDEX IF NOT EXISTS idx_sellers_slug ON sellers(slug);
CREATE INDEX IF NOT EXISTS idx_sellers_trust ON sellers(trust_level);

-- Marketplace listings
CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    seller_id TEXT NOT NULL REFERENCES sellers(id),
    org_id TEXT NOT NULL REFERENCES orgs(id),
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    product_type TEXT NOT NULL DEFAULT 'plugin'
        CHECK (product_type IN ('plugin', 'workflow', 'agent', 'agent_team', 'community')),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'submitted', 'in_review', 'published', 'suspended', 'delisted')),
    price_cents INTEGER NOT NULL DEFAULT 0,
    price_model TEXT NOT NULL DEFAULT 'free'
        CHECK (price_model IN ('free', 'one_time', 'subscription_monthly', 'subscription_yearly')),
    commission_rate REAL NOT NULL DEFAULT 0.20,
    category TEXT,
    tags_json TEXT DEFAULT '[]',
    icon_path TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    published_at TEXT,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_org ON listings(org_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_slug ON listings(slug);
CREATE INDEX IF NOT EXISTS idx_listings_product_type ON listings(product_type);

-- Listing versions (each submission is a version)
CREATE TABLE IF NOT EXISTS listing_versions (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    version TEXT NOT NULL,
    changelog TEXT,
    package_path TEXT,
    package_hash TEXT,
    package_size_bytes INTEGER,
    review_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (review_status IN ('pending', 'automated_passed', 'automated_failed', 'approved', 'rejected', 'changes_requested', 'yanked')),
    automated_checks_json TEXT DEFAULT '{}',
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_notes TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(listing_id, version)
);

CREATE INDEX IF NOT EXISTS idx_listing_versions_listing ON listing_versions(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_versions_status ON listing_versions(review_status);

-- Listing screenshots
CREATE TABLE IF NOT EXISTS listing_screenshots (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    file_path TEXT NOT NULL,
    caption TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_listing_screenshots_listing ON listing_screenshots(listing_id);

-- Submission reviews (admin review trail)
CREATE TABLE IF NOT EXISTS submission_reviews (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES listing_versions(id),
    reviewer_id TEXT NOT NULL,
    action TEXT NOT NULL
        CHECK (action IN ('approve', 'reject', 'request_changes', 'yank')),
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_submission_reviews_version ON submission_reviews(version_id);
