/**
 * Gripe quoxbastion#17: a host that is connected and heartbeating (in the collector's
 * agents map) can be absent from the Bastion registry, so Bastion answers
 * "404: host not found". Heartbeat enrolment never writes the registry, and registering
 * is a governed Bastion-side action (there is no safe auto-register), so we do not
 * create it here: we say exactly what is wrong and how to fix it.
 * Call ONLY for hosts known to be connected.
 */
function describeHostNotRegistered(error, hostId) {
  if (typeof error !== 'string') return error;
  if (!/Bastion returned 404/i.test(error) || !/host not found/i.test(error)) return error;
  return `Host ${hostId} is connected (its quoxagent is heartbeating) but is not registered in Bastion, ` +
    `so Bastion cannot reach it over SSH. Confirm with \`quox fleet hosts\`. ` +
    `A Bastion admin must add it: POST /api/v1/hosts on the Bastion API ` +
    `with {"id":"${hostId}","ip":"<ip>","group":"fleet","ssh":{"port":22,"user":"<user>"}} ` +
    `(there is no \`quox fleet\` verb to create a host yet; \`quox fleet host-update\` only links credentials). ` +
    `Original error: ${error}`;
}

module.exports = { describeHostNotRegistered };
