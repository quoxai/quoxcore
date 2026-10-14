/**
 * Z2H-3c: what a host tool says when this install has no QuoxBastion (BASTION_URL / BASTION_API_TOKEN unset).
 * One copy, so every path says the same true thing. It used to end "Ask an admin to configure QuoxBastion.",
 * which a model repeated to the install's own owner. Keep the "Bastion not configured" prefix: callers match it.
 */
const BASTION_UNAVAILABLE_MESSAGE = 'Bastion not configured for this installation: host commands cannot reach any machine from here yet. This is how the install is set up, not the user\'s permissions; say so plainly.';

module.exports = { BASTION_UNAVAILABLE_MESSAGE };
