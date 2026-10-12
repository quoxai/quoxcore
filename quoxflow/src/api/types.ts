import { PolicyStore } from '../policy/types.js';
import { ApprovalEngine } from '../approval/index.js';
import { EvidenceStore } from '../evidence/index.js';
import { EnvelopeStore } from '../store/envelope-store.js';

export interface AuthUser {
  user_id: string;
  email?: string;
  org_id?: string;
  role?: string;
  type: 'access' | 'service';
}

export type AppVariables = {
  correlationId: string;
  policyStore: PolicyStore;
  approvalEngine: ApprovalEngine;
  evidenceStore: EvidenceStore;
  envelopeStore: EnvelopeStore;
  validatedQuery: unknown;
  validatedParams: unknown;
  validatedBody: unknown;
  user: AuthUser;
};

export type AppEnv = { Variables: AppVariables };
