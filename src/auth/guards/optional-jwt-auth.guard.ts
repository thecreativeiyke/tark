import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * OptionalJwtAuthGuard:
 * Allows unauthenticated/anonymous requests through with req.user = undefined.
 * If a valid JWT Authorization header is present, it validates and populates req.user.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = any>(err: any, user: any): TUser {
    // If token is missing, expired, or invalid, do not throw 401; treat as guest
    if (err || !user) {
      return undefined as any;
    }
    return user;
  }
}
