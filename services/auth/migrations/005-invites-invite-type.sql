-- ET-6B: invites.invite_type for the guest flow
ALTER TABLE invites ADD COLUMN invite_type TEXT NOT NULL DEFAULT 'regular';
