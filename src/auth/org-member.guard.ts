import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthUser } from './auth.types';

/** Solo usuarios con empresa asignada (admin o agente). Bloquea SUPER_ADMIN en rutas de chat. */
@Injectable()
export class OrgMemberGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user: AuthUser }>();
    const user = req.user;
    if (!user?.organizationId) {
      throw new ForbiddenException('Esta área es solo para usuarios de una empresa');
    }
    return true;
  }
}
