/**
 * QCX-1.5 — Pre-built connector gallery.
 *
 * 15 one-click integration templates covering the connectors every SaaS
 * demo expects to see working: payments, CRM, ecommerce, support, dev
 * tools, productivity, calendar, messaging, analytics.
 *
 * Each template emits a connector draft that the user then customises
 * (mostly: vault secret ref) + a starter tool with a sensible input
 * schema and config. The template is a data description, not an
 * executable — execution still goes through the normal executor.
 *
 * Fields per template:
 *   slug              Stable identifier (used in from-template requests).
 *   name              Display name on the gallery tile.
 *   vendor            Vendor brand for grouping.
 *   category          payments | crm | ecommerce | support | dev | productivity | calendar | messaging | analytics
 *   description       One-line customer-facing blurb.
 *   docs_url          Upstream vendor API docs.
 *   connector         Partial widget_connectors row: {name, connector_type, config}.
 *                     config MUST include secret_vault_id: null placeholder for the auth flow.
 *   tool              Partial widget_tools row: {name, description, parameters, config, rate_limit_per_session?}.
 *
 * The connector.config has a `secret_vault_id: null` placeholder that the
 * admin fills in after picking a vault credential. `secret_env_var` is
 * also populated for platform-key fall-through where useful.
 */

const TEMPLATES = [
  // ── Payments ────────────────────────────────────────────────────────────
  {
    slug: 'stripe-charge-lookup',
    name: 'Stripe · Charge / refund status',
    vendor: 'Stripe',
    category: 'payments',
    description: 'Look up a Stripe charge by ID and return status, amount, refunded state.',
    docs_url: 'https://stripe.com/docs/api/charges/retrieve',
    connector: {
      name: 'Stripe API',
      connector_type: 'rest_api',
      config: {
        base_url: 'https://api.stripe.com',
        auth_type: 'bearer',
        secret_vault_id: null,
        secret_env_var: 'STRIPE_API_KEY',
      },
    },
    tool: {
      name: 'get_charge_status',
      description: 'Look up the status of a Stripe charge by its ID.',
      parameters: { type: 'object', properties: { charge_id: { type: 'string', description: 'Stripe charge ID, e.g. ch_1Hxxx' } }, required: ['charge_id'] },
      config: { method: 'GET', path: '/v1/charges/{charge_id}', response_extract: 'status' },
      rate_limit_per_session: 3,
    },
  },

  // ── CRM ─────────────────────────────────────────────────────────────────
  {
    slug: 'hubspot-contact-lookup',
    name: 'HubSpot · Contact lookup',
    vendor: 'HubSpot',
    category: 'crm',
    description: 'Find a HubSpot contact by email and return their name, company, lifecycle stage.',
    docs_url: 'https://developers.hubspot.com/docs/api/crm/contacts',
    connector: {
      name: 'HubSpot API',
      connector_type: 'rest_api',
      config: {
        base_url: 'https://api.hubapi.com',
        auth_type: 'bearer',
        secret_vault_id: null,
        secret_env_var: 'HUBSPOT_API_KEY',
      },
    },
    tool: {
      name: 'find_hubspot_contact',
      description: 'Look up a HubSpot contact by email address.',
      parameters: { type: 'object', properties: { email: { type: 'string', description: 'Contact email' } }, required: ['email'] },
      config: { method: 'GET', path: '/crm/v3/objects/contacts/{email}?idProperty=email', response_extract: 'properties' },
      rate_limit_per_session: 3,
    },
  },

  // ── Ecommerce ───────────────────────────────────────────────────────────
  {
    slug: 'shopify-order-status',
    name: 'Shopify · Order status',
    vendor: 'Shopify',
    category: 'ecommerce',
    description: "Return a Shopify order's fulfilment status and tracking info by order number.",
    docs_url: 'https://shopify.dev/docs/api/admin-rest/2024-10/resources/order',
    connector: {
      name: 'Shopify Admin API',
      connector_type: 'rest_api',
      config: {
        base_url: 'https://{shop}.myshopify.com',
        auth_type: 'api_key',
        api_key_header: 'X-Shopify-Access-Token',
        secret_vault_id: null,
        secret_env_var: 'SHOPIFY_ADMIN_TOKEN',
      },
    },
    tool: {
      name: 'get_order_status',
      description: 'Look up a Shopify order by order number; returns fulfilment + tracking.',
      parameters: { type: 'object', properties: { order_number: { type: 'string' } }, required: ['order_number'] },
      config: { method: 'GET', path: '/admin/api/2024-10/orders.json?name={order_number}' },
      rate_limit_per_session: 5,
    },
  },

  // ── Support ─────────────────────────────────────────────────────────────
  {
    slug: 'zendesk-ticket-create',
    name: 'Zendesk · Ticket create',
    vendor: 'Zendesk',
    category: 'support',
    description: 'Open a new Zendesk support ticket with subject + body from the conversation.',
    docs_url: 'https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/#create-ticket',
    connector: {
      name: 'Zendesk API',
      connector_type: 'rest_api',
      config: {
        base_url: 'https://{subdomain}.zendesk.com',
        auth_type: 'bearer',
        secret_vault_id: null,
        secret_env_var: 'ZENDESK_API_TOKEN',
      },
    },
    tool: {
      name: 'create_zendesk_ticket',
      description: 'Open a Zendesk support ticket for the visitor.',
      parameters: { type: 'object', properties: { subject: { type: 'string' }, description: { type: 'string' }, email: { type: 'string' } }, required: ['subject', 'description'] },
      config: {
        method: 'POST',
        path: '/api/v2/tickets.json',
        body_template: { ticket: { subject: { $input: 'subject' }, comment: { body: { $input: 'description' } }, requester: { email: { $input: 'email' } } } },
      },
      rate_limit_per_session: 2,
    },
  },

  // ── Dev tools ───────────────────────────────────────────────────────────
  {
    slug: 'linear-issue-create',
    name: 'Linear · Issue create',
    vendor: 'Linear',
    category: 'dev',
    description: 'Create a Linear issue from a chat message (subject, description, team).',
    docs_url: 'https://developers.linear.app/docs/graphql/working-with-the-graphql-api',
    connector: {
      name: 'Linear API',
      connector_type: 'rest_api',
      config: {
        base_url: 'https://api.linear.app',
        auth_type: 'api_key',
        api_key_header: 'Authorization',
        secret_vault_id: null,
        secret_env_var: 'LINEAR_API_KEY',
      },
    },
    tool: {
      name: 'create_linear_issue',
      description: 'Create an issue in Linear.',
      parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, team_id: { type: 'string' } }, required: ['title', 'team_id'] },
      config: {
        method: 'POST',
        path: '/graphql',
        body_template: { query: 'mutation($input:IssueCreateInput!){issueCreate(input:$input){issue{id title}}}', variables: { input: { title: { $input: 'title' }, description: { $input: 'description' }, teamId: { $input: 'team_id' } } } },
      },
      rate_limit_per_session: 2,
    },
  },
  {
    slug: 'jira-issue-create',
    name: 'Jira · Issue create',
    vendor: 'Atlassian Jira',
    category: 'dev',
    description: 'Open a new Jira issue with summary, description, issue type.',
    docs_url: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post',
    connector: {
      name: 'Jira Cloud API',
      connector_type: 'rest_api',
      config: {
        base_url: 'https://{domain}.atlassian.net',
        auth_type: 'bearer',
        secret_vault_id: null,
        secret_env_var: 'JIRA_API_TOKEN',
      },
    },
    tool: {
      name: 'create_jira_issue',
      description: 'Create a Jira issue in the configured project.',
      parameters: { type: 'object', properties: { project_key: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' } }, required: ['project_key', 'summary'] },
      config: {
        method: 'POST',
        path: '/rest/api/3/issue',
        body_template: { fields: { project: { key: { $input: 'project_key' } }, summary: { $input: 'summary' }, description: { $input: 'description' }, issuetype: { name: 'Task' } } },
      },
      rate_limit_per_session: 2,
    },
  },
  {
    slug: 'github-issue-create',
    name: 'GitHub · Issue create',
    vendor: 'GitHub',
    category: 'dev',
    description: 'Open a GitHub issue in a specified repo.',
    docs_url: 'https://docs.github.com/en/rest/issues/issues#create-an-issue',
    connector: {
      name: 'GitHub REST API',
      connector_type: 'rest_api',
      config: {
        base_url: 'https://api.github.com',
        auth_type: 'bearer',
        secret_vault_id: null,
        secret_env_var: 'GITHUB_TOKEN',
      },
    },
    tool: {
      name: 'create_github_issue',
      description: 'File a GitHub issue.',
      parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
      config: {
        method: 'POST',
        path: '/repos/{owner}/{repo}/issues',
        body_template: { title: { $input: 'title' }, body: { $input: 'body' } },
      },
      rate_limit_per_session: 2,
    },
  },

  // ── Messaging ───────────────────────────────────────────────────────────
  {
    slug: 'slack-message-post',
    name: 'Slack · Post to channel',
    vendor: 'Slack',
    category: 'messaging',
    description: 'Post a message into a Slack channel via an incoming webhook.',
    docs_url: 'https://api.slack.com/messaging/webhooks',
    connector: {
      name: 'Slack Incoming Webhook',
      connector_type: 'webhook',
      config: {
        url: 'https://hooks.slack.com/services/{workspace}/{channel}/{token}',
        include_metadata: false,
      },
    },
    tool: {
      name: 'post_slack_message',
      description: 'Post a message to a Slack channel.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      config: { body_template: { text: { $input: 'text' } } },
      rate_limit_per_session: 3,
    },
  },
  {
    slug: 'twilio-sms-send',
    name: 'Twilio · Send SMS',
    vendor: 'Twilio',
    category: 'messaging',
    description: 'Send an SMS via Twilio (from a verified sender number).',
    docs_url: 'https://www.twilio.com/docs/sms/api/message-resource#create-a-message-resource',
    connector: {
      name: 'Twilio API',
      connector_type: 'rest_api',
      config: {
        base_url: 'https://api.twilio.com',
        auth_type: 'bearer',
        secret_vault_id: null,
        secret_env_var: 'TWILIO_AUTH_TOKEN',
      },
    },
    tool: {
      name: 'send_sms',
      description: 'Send an SMS to a phone number.',
      parameters: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] },
      config: {
        method: 'POST',
        path: '/2010-04-01/Accounts/{account_sid}/Messages.json',
        body_template: { To: { $input: 'to' }, Body: { $input: 'body' } },
      },
      rate_limit_per_session: 2,
    },
  },
  {
    slug: 'sendgrid-email-send',
    name: 'SendGrid · Send email',
    vendor: 'SendGrid',
    category: 'messaging',
    description: 'Send a transactional email via SendGrid.',
    docs_url: 'https://docs.sendgrid.com/api-reference/mail-send/mail-send',
    connector: {
      name: 'SendGrid API',
      connector_type: 'rest_api',
      config: {
        base_url: 'https://api.sendgrid.com',
        auth_type: 'bearer',
        secret_vault_id: null,
        secret_env_var: 'SENDGRID_API_KEY',
      },
    },
    tool: {
      name: 'send_email',
      description: 'Send a transactional email.',
      parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'subject', 'text'] },
      config: {
        method: 'POST',
        path: '/v3/mail/send',
        body_template: {
          personalizations: [{ to: [{ email: { $input: 'to' } }] }],
          from: { email: 'noreply@example.com' },
          subject: { $input: 'subject' },
          content: [{ type: 'text/plain', value: { $input: 'text' } }],
        },
      },
      rate_limit_per_session: 3,
    },
  },

  // ── Productivity ────────────────────────────────────────────────────────
  {
    slug: 'google-sheets-append',
    name: 'Google Sheets · Append row',
    vendor: 'Google Sheets',
    category: 'productivity',
    description: 'Append a row to a Google Sheet (via a Zapier/Make-style webhook).',
    docs_url: 'https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values/append',
    connector: {
      name: 'Sheets Append Webhook',
      connector_type: 'webhook',
      config: {
        url: 'https://hooks.zapier.com/hooks/catch/{team}/{hook}/',
        include_metadata: true,
      },
    },
    tool: {
      name: 'append_to_sheet',
      description: 'Append a row to the connected Google Sheet.',
      parameters: { type: 'object', properties: { values: { type: 'object', description: 'Object whose keys are column names and values are cell values.' } }, required: ['values'] },
      config: { body_template: { values: { $input: 'values' } } },
      rate_limit_per_session: 10,
    },
  },
  {
    slug: 'notion-db-query',
    name: 'Notion · Database query',
    vendor: 'Notion',
    category: 'productivity',
    description: 'Query a Notion database and return matching pages.',
    docs_url: 'https://developers.notion.com/reference/post-database-query',
    connector: {
      name: 'Notion API',
      connector_type: 'rest_api',
      config: {
        base_url: 'https://api.notion.com',
        auth_type: 'bearer',
        secret_vault_id: null,
        secret_env_var: 'NOTION_API_KEY',
        default_headers: { 'Notion-Version': '2022-06-28' },
      },
    },
    tool: {
      name: 'query_notion_db',
      description: 'Query a Notion database for matching pages.',
      parameters: { type: 'object', properties: { database_id: { type: 'string' }, query: { type: 'string' } }, required: ['database_id'] },
      config: {
        method: 'POST',
        path: '/v1/databases/{database_id}/query',
        body_template: { filter: { property: 'Name', rich_text: { contains: { $input: 'query' } } } },
      },
      rate_limit_per_session: 5,
    },
  },
  {
    slug: 'airtable-record-create',
    name: 'Airtable · Create record',
    vendor: 'Airtable',
    category: 'productivity',
    description: 'Create a record in an Airtable table.',
    docs_url: 'https://airtable.com/developers/web/api/create-records',
    connector: {
      name: 'Airtable API',
      connector_type: 'rest_api',
      config: {
        base_url: 'https://api.airtable.com',
        auth_type: 'bearer',
        secret_vault_id: null,
        secret_env_var: 'AIRTABLE_API_KEY',
      },
    },
    tool: {
      name: 'create_airtable_record',
      description: 'Create a record in the configured Airtable table.',
      parameters: { type: 'object', properties: { base_id: { type: 'string' }, table_id: { type: 'string' }, fields: { type: 'object' } }, required: ['base_id', 'table_id', 'fields'] },
      config: {
        method: 'POST',
        path: '/v0/{base_id}/{table_id}',
        body_template: { records: [{ fields: { $input: 'fields' } }] },
      },
      rate_limit_per_session: 5,
    },
  },

  // ── Calendar ────────────────────────────────────────────────────────────
  {
    slug: 'calendly-link-lookup',
    name: 'Calendly · Scheduling link lookup',
    vendor: 'Calendly',
    category: 'calendar',
    description: 'Return a user\'s scheduling link + next available slots.',
    docs_url: 'https://developer.calendly.com/api-docs/005832abe6d75-calendly-developer',
    connector: {
      name: 'Calendly API',
      connector_type: 'rest_api',
      config: {
        base_url: 'https://api.calendly.com',
        auth_type: 'bearer',
        secret_vault_id: null,
        secret_env_var: 'CALENDLY_API_KEY',
      },
    },
    tool: {
      name: 'get_scheduling_link',
      description: 'Fetch a Calendly scheduling link for a user.',
      parameters: { type: 'object', properties: { user_uri: { type: 'string', description: 'Calendly user URI' } }, required: ['user_uri'] },
      config: { method: 'GET', path: '/scheduled_events?user={user_uri}&count=1' },
      rate_limit_per_session: 3,
    },
  },

  // ── Analytics ───────────────────────────────────────────────────────────
  {
    slug: 'segment-track-event',
    name: 'Segment · Track event',
    vendor: 'Segment',
    category: 'analytics',
    description: 'Fire a Segment track event from the conversation.',
    docs_url: 'https://segment.com/docs/connections/sources/catalog/libraries/server/http-api/#track',
    connector: {
      name: 'Segment Track API',
      connector_type: 'rest_api',
      config: {
        base_url: 'https://api.segment.io',
        auth_type: 'bearer',
        secret_vault_id: null,
        secret_env_var: 'SEGMENT_WRITE_KEY',
      },
    },
    tool: {
      name: 'track_segment_event',
      description: 'Fire a Segment track event.',
      parameters: { type: 'object', properties: { user_id: { type: 'string' }, event: { type: 'string' }, properties: { type: 'object' } }, required: ['event'] },
      config: {
        method: 'POST',
        path: '/v1/track',
        body_template: { userId: { $input: 'user_id' }, event: { $input: 'event' }, properties: { $input: 'properties' } },
      },
      rate_limit_per_session: 10,
    },
  },
];

const BY_SLUG = new Map(TEMPLATES.map(t => [t.slug, t]));

export function listTemplates() { return TEMPLATES; }
export function getTemplate(slug) { return BY_SLUG.get(slug) || null; }
export { TEMPLATES };
