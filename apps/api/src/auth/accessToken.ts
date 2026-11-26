import { ROLES, type Role } from '@ticketmanager/shared';
import { jwtVerify, SignJWT } from 'jose';

export interface AccessClaims {
  userId: string;
  sessionId: string;
  activeRole: Role;
}

const ISSUER = 'ticketmanager';
const AUDIENCE = 'ticketmanager-api';

export function createAccessTokens(secret: string, minutes: number) {
  const key = new TextEncoder().encode(secret);

  return {
    ttlSeconds: minutes * 60,

    sign(claims: AccessClaims) {
      return new SignJWT({ sid: claims.sessionId, role: claims.activeRole })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${minutes}m`)
        .sign(key);
    },

    /** Returns the claims, or null if the token is missing, invalid or expired. */
    async verify(token: string): Promise<AccessClaims | null> {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: ISSUER,
          audience: AUDIENCE,
          algorithms: ['HS256'],
        });
        const role = payload.role as Role;
        if (!payload.sub || typeof payload.sid !== 'string' || !ROLES.includes(role)) return null;
        return { userId: payload.sub, sessionId: payload.sid, activeRole: role };
      } catch {
        return null;
      }
    },
  };
}

export type AccessTokens = ReturnType<typeof createAccessTokens>;
