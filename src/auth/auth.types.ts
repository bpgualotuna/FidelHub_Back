import { UserRole } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  organizationId: string | null;
}

/** Usuario autenticado adjunto a req.user (JWT validado + usuario en BD) */
export interface AuthUser {
  userId: string;
  email: string;
  role: UserRole;
  organizationId: string | null;
}
