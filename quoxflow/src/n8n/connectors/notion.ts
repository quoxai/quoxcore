/**
 * n8n `n8n-nodes-base.notion` (resource: databasePage) -> Notion API v1
 * https://developers.notion.com/reference/post-page
 * https://developers.notion.com/reference/patch-page
 *
 * Handles "create" (the node's own default when resource is
 * databasePage) and "update" — together the majority of real
 * databasePage usage in the AI Agent Vault sample. Other resources
 * (block, database) are intentionally left unhandled.
 */

import { N8nNode } from '../types.js';
import { Connector } from './types.js';
import { credentialExpr } from './credential.js';

const NOTION_VERSION = '2022-06-28';

interface ResourceLocator {
  value?: unknown;
}

interface PropertyValue {
  key?: string; // "PropertyName|type"
  title?: unknown;
  textContent?: unknown;
  selectValue?: unknown;
  multiSelectValue?: unknown;
  checkboxValue?: unknown;
  urlValue?: unknown;
  date?: unknown;
  relationValue?: unknown;
  numberValue?: unknown;
}

/** Transform n8n's propertiesUi.propertyValues into real Notion property values. */
function buildProperties(params: Record<string, unknown>): Record<string, unknown> {
  const propertiesUi = params.propertiesUi as { propertyValues?: PropertyValue[] } | undefined;
  const entries = propertiesUi?.propertyValues ?? [];
  const properties: Record<string, unknown> = {};

  for (const entry of entries) {
    const [name, type] = (entry.key || '').split('|');
    if (!name) continue;

    switch (type) {
      case 'title':
        properties[name] = { title: [{ text: { content: entry.title ?? '' } }] };
        break;
      case 'rich_text':
        properties[name] = { rich_text: [{ text: { content: entry.textContent ?? '' } }] };
        break;
      case 'select':
        properties[name] = { select: { name: entry.selectValue ?? '' } };
        break;
      case 'multi_select': {
        const values = Array.isArray(entry.multiSelectValue) ? entry.multiSelectValue : [entry.multiSelectValue];
        properties[name] = { multi_select: values.filter(Boolean).map(v => ({ name: v })) };
        break;
      }
      case 'checkbox':
        properties[name] = { checkbox: entry.checkboxValue ?? false };
        break;
      case 'url':
        properties[name] = { url: entry.urlValue ?? null };
        break;
      case 'date':
        properties[name] = { date: { start: entry.date ?? null } };
        break;
      case 'number':
        properties[name] = { number: entry.numberValue ?? null };
        break;
      case 'relation': {
        const ids = Array.isArray(entry.relationValue) ? entry.relationValue : [entry.relationValue];
        properties[name] = { relation: ids.filter(Boolean).map(id => ({ id })) };
        break;
      }
      default:
        // Unknown property type — skip rather than guess a shape.
        break;
    }
  }

  return properties;
}

export const notionConnector: Connector = (n8nNode: N8nNode, params) => {
  const resource = (params.resource as string) || 'databasePage';
  if (resource !== 'databasePage') return null;

  const operation = (params.operation as string) || 'create';
  const headers = {
    'Authorization': `Bearer ${credentialExpr(n8nNode, 'notion_api')}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
  const properties = buildProperties(params);

  if (operation === 'create') {
    const databaseId = params.databaseId as ResourceLocator | undefined;
    return {
      url: 'https://api.notion.com/v1/pages',
      method: 'POST',
      headers,
      body: {
        parent: { database_id: databaseId?.value ?? '' },
        properties,
      },
      timeout: 30000,
    };
  }

  if (operation === 'update') {
    const pageId = params.pageId as ResourceLocator | undefined;
    return {
      url: `https://api.notion.com/v1/pages/${pageId?.value ?? ''}`,
      method: 'PATCH',
      headers,
      body: { properties },
      timeout: 30000,
    };
  }

  return null;
};
