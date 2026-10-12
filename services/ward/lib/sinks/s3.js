/**
 * WARD-EXT: S3 Object Lock Sink
 *
 * Uploads signed tip JSON to S3 with Object Lock (WORM — Write Once Read Many).
 * Provides immutable, timestamped evidence in AWS-native infrastructure.
 *
 * sink_ref format: s3://<bucket>/ward/<chainSlug>/<tip_seq>.json
 *
 * Requires: WARD_S3_BUCKET, WARD_S3_REGION
 * Optional: WARD_S3_ACCESS_KEY, WARD_S3_SECRET_KEY (uses default credentials if not set)
 *
 * The bucket MUST have Object Lock enabled at creation time (cannot be added later).
 * Objects are uploaded with GOVERNANCE retention mode for maximum protection.
 */

/**
 * @param {object} tip - Signed WARD tip
 * @param {object} config - { bucket, region, access_key, secret_key, retention_days }
 * @returns {Promise<{success: boolean, sink_ref: string|null, error: string|null}>}
 */
export async function publish(tip, config = {}) {
  const { bucket, region, access_key, secret_key, retention_days } = config;

  if (!bucket) {
    return { success: false, sink_ref: null, error: 'No S3 bucket configured' };
  }

  try {
    // Dynamic require — @aws-sdk/client-s3 is optional dependency
    // Using createRequire to avoid Vite's static import analysis
    let S3Client, PutObjectCommand;
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const s3Module = require('@aws-sdk/client-s3');
      S3Client = s3Module.S3Client;
      PutObjectCommand = s3Module.PutObjectCommand;
    } catch {
      return { success: false, sink_ref: null, error: '@aws-sdk/client-s3 not installed. Run: npm install @aws-sdk/client-s3' };
    }

    const chainSlug = tip.chain_id.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const key = `ward/${chainSlug}/${tip.tip_seq}.json`;

    const body = JSON.stringify({
      tip_id: tip.tip_id,
      chain_id: tip.chain_id,
      tip_seq: tip.tip_seq,
      tip_chain_hash: tip.tip_chain_hash,
      entry_count: tip.entry_count,
      created_at: tip.created_at,
      sig: tip.sig,
      key_id: tip.key_id,
      published_at: new Date().toISOString()
    }, null, 2);

    const clientConfig = { region: region || 'us-east-1' };
    if (access_key && secret_key) {
      clientConfig.credentials = { accessKeyId: access_key, secretAccessKey: secret_key };
    }

    const client = new S3Client(clientConfig);

    const params = {
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
    };

    // Apply Object Lock retention if configured
    if (retention_days) {
      const retainUntil = new Date();
      retainUntil.setDate(retainUntil.getDate() + (retention_days || 365));
      params.ObjectLockMode = 'GOVERNANCE';
      params.ObjectLockRetainUntilDate = retainUntil;
    }

    await client.send(new PutObjectCommand(params));

    const sinkRef = `s3://${bucket}/${key}`;
    return { success: true, sink_ref: sinkRef, error: null };
  } catch (err) {
    return { success: false, sink_ref: null, error: err.message };
  }
}

export function verify(sinkRef) {
  return sinkRef && sinkRef.startsWith('s3://');
}

export const type = 's3';
