/**
 * Channel Driver Registry
 *
 * Central registry for notification channel drivers.
 * Replaces the flat switch statement in notificationService.js.
 *
 * Driver interface:
 * {
 *   id: string,
 *   name: string,
 *   category: 'messaging'|'email'|'sms'|'incident'|'push'|'webhook',
 *   credentialFields: string[],
 *   capabilities: { send: boolean, receive?: boolean, richContent?: boolean, priority?: boolean },
 *   send({ recipient, title, message, priority, orgId, credentials }): Promise<{success, channel, message?, error?}>,
 *   resolveRecipient(config): string|null,
 *   validateRecipient?(recipient): boolean
 * }
 */

const _drivers = new Map();

/**
 * Register a channel driver.
 * @param {object} driver - Driver implementation
 */
function registerDriver(driver) {
  if (!driver.id || !driver.send) {
    throw new Error(`Invalid driver: must have id and send(). Got: ${JSON.stringify(Object.keys(driver || {}))}`);
  }
  _drivers.set(driver.id, driver);
}

/**
 * Get a driver by channel ID.
 * @param {string} channelId
 * @returns {object|null}
 */
function getDriver(channelId) {
  return _drivers.get(channelId) || null;
}

/**
 * List all registered drivers with capabilities.
 * @returns {object[]}
 */
function listDrivers() {
  return Array.from(_drivers.values()).map(d => ({
    id: d.id,
    name: d.name,
    category: d.category,
    credentialFields: d.credentialFields,
    capabilities: d.capabilities
  }));
}

/**
 * Send a notification through a registered driver.
 * Falls back to error if driver not found.
 *
 * @param {object} input - { channel, recipient, title, message, priority, orgId, credentials }
 * @returns {Promise<object>}
 */
async function sendNotification(input) {
  const { channel, recipient, message } = input;
  const driver = _drivers.get(channel);
  if (!driver) {
    return { success: false, error: `No driver registered for channel: ${channel}. Registered: ${Array.from(_drivers.keys()).join(', ')}` };
  }

  // Validate message is not empty
  if (!message || (typeof message === 'string' && message.trim() === '')) {
    return { success: false, error: 'Message cannot be empty' };
  }

  // Validate recipient if driver provides validation
  if (recipient && driver.validateRecipient && !driver.validateRecipient(recipient)) {
    return { success: false, error: `Invalid recipient for ${channel}: ${recipient}` };
  }

  return driver.send(input);
}

/**
 * Resolve recipient from channel config using the appropriate driver.
 * @param {string} channelType
 * @param {object} config
 * @returns {string|null}
 */
function resolveRecipient(channelType, config) {
  const driver = _drivers.get(channelType);
  if (driver?.resolveRecipient) {
    return driver.resolveRecipient(config);
  }
  return null;
}

module.exports = { registerDriver, getDriver, listDrivers, sendNotification, resolveRecipient };
