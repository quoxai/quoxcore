/**
 * Channel Drivers Index — Auto-registers all drivers on import.
 *
 * Usage:
 *   const channels = require('./channels');
 *   channels.sendNotification({ channel: 'slack', ... });
 *   channels.listDrivers(); // all registered drivers
 */

const registry = require('./registry');

// Register all built-in drivers
const drivers = [
  require('./drivers/slack'),
  require('./drivers/telegram'),
  require('./drivers/email'),
  require('./drivers/discord'),
  require('./drivers/webhook'),
  require('./drivers/msteams'),
  require('./drivers/twilio-sms'),
  require('./drivers/pagerduty'),
  require('./drivers/opsgenie'),
  require('./drivers/mattermost'),
  require('./drivers/ntfy'),
  require('./drivers/pushover'),
  require('./drivers/google-chat'),
  require('./drivers/gotify'),
  require('./drivers/rocketchat'),
  require('./drivers/line'),
];

for (const driver of drivers) {
  registry.registerDriver(driver);
}

module.exports = registry;
