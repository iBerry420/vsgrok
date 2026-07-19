import * as crypto from 'crypto';

export function mintWsToken(secret: string, uid = 1, role = 'admin', ttlSeconds = 3600): string {
  const payload = {
    uid,
    role,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const sig = crypto.createHmac('sha256', secret).update(json).digest('hex');
  return `${b64}.${sig}`;
}

export function generateWsSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}
