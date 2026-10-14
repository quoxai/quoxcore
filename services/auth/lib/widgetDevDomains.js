/** Domains that count as development-only for the go-live gate. */
const DEV_DOMAIN_PATTERNS = [
  /^localhost(:\d+)?$/i,
  /\.localhost$/i,
  /\.ngrok-free\.app$/i,
  /\.local$/i,
  /^127\.0\.0\.1(:\d+)?$/,
  /^192\.168\./, // LAN
];

export function isDevOnlyDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  return DEV_DOMAIN_PATTERNS.some(re => re.test(domain.toLowerCase()));
}
