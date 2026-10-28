import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

interface RateBucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class CrmIntegrationRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly maxRequests = 60;
  private readonly windowMs = 60_000;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; ip?: string }>();
    const apiKey = req.headers['x-api-key'] || 'anonymous';
    const key = `${req.ip || 'unknown'}:${apiKey}`;
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (bucket.count >= this.maxRequests) {
      throw new HttpException('Rate limit exceeded for CRM integration', HttpStatus.TOO_MANY_REQUESTS);
    }

    bucket.count += 1;
    return true;
  }
}
