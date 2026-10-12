function buildInternalServiceHeaders(extraHeaders = {}) {
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  return serviceKey ? { 'X-Service-Key': serviceKey, ...extraHeaders } : { ...extraHeaders };
}

module.exports = {
  buildInternalServiceHeaders,
};
