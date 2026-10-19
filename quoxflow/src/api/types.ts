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
  /** quoxflow#14: the token is an agent principal (attach lease, resident identity, plugin). Set by the
   * auth middleware from the credential's markers, never self-asserted in a request body. */
  isAgent?: boolean;
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
