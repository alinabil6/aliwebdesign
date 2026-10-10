import crypto from 'crypto';

const DEV_SCOPES = ['ai.generate:run', 'ai.styles:analyze', 'ai.listing:generate'];

function base64UrlDecode(input) {
  const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isLocalRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
}

function parseToken(token, secret) {
  const [encodedHeader, encodedPayload, signature] = String(token || '').split('.');
  if (!encodedHeader || !encodedPayload || !signature) {
    throw Object.assign(new Error('Malformed token'), { status: 401 });
  }

  const header = JSON.parse(base64UrlDecode(encodedHeader));
  const payload = JSON.parse(base64UrlDecode(encodedPayload));
  if (header.alg !== 'HS256') {
    throw Object.assign(new Error('Unsupported JWT algorithm'), { status: 401 });
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');

  if (!timingSafeEqual(signature, expected)) {
    throw Object.assign(new Error('Invalid token signature'), { status: 401 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.nbf && Number(payload.nbf) > now) {
    throw Object.assign(new Error('Token not active yet'), { status: 401 });
  }
  if (payload.exp && Number(payload.exp) <= now) {
    throw Object.assign(new Error('Token expired'), { status: 401 });
  }

  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes
    : typeof payload.scope === 'string'
      ? payload.scope.split(/\s+/).filter(Boolean)
      : Array.isArray(payload.scp)
        ? payload.scp
        : [];
  const roles = Array.isArray(payload.roles)
    ? payload.roles
    : Array.isArray(payload.realm_access?.roles)
      ? payload.realm_access.roles
      : [];

  return {
    token,
    subject: payload.sub || payload.userId || payload.uid || 'unknown',
    scopes,
    roles,
    payload,
  };
}

function attachContext(req, auth) {
  req.auth = auth;
  req.userContext = {
    userId: auth.subject,
    roles: auth.roles,
    scopes: auth.scopes,
  };
  req.headers['x-user-id'] = auth.subject;
  req.headers['x-user-roles'] = auth.roles.join(',');
  req.headers['x-scopes'] = auth.scopes.join(' ');
}

export function authenticateRequest({ anyOfScopes = [] } = {}) {
  return (req, res, next) => {
    const authHeader = req.get('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const secret = process.env.AUTH_JWT_SECRET || '';
    const devBypassAllowed = process.env.NODE_ENV !== 'production' && process.env.ALLOW_LOCAL_DEV_AUTH_BYPASS !== '0';

    if (!bearer) {
      if (devBypassAllowed && isLocalRequest(req)) {
        attachContext(req, {
          token: null,
          subject: 'local-dev',
          roles: ['ROLE_ADMIN'],
          scopes: DEV_SCOPES,
          payload: { devBypass: true },
        });
      } else {
        return res.status(401).json({ error: 'Authentication required' });
      }
    } else {
      if (!secret) {
        return res.status(503).json({ error: 'AUTH_JWT_SECRET is not configured' });
      }
      try {
        attachContext(req, parseToken(bearer, secret));
      } catch (error) {
        return res.status(error.status || 401).json({ error: error.message || 'Authentication failed' });
      }
    }

    if (anyOfScopes.length > 0) {
      const granted = new Set(req.auth?.scopes || []);
      const ok = anyOfScopes.some((scope) => granted.has(scope));
      if (!ok) {
        return res.status(403).json({ error: 'Forbidden', requiredScopes: anyOfScopes });
      }
    }

    next();
  };
}
