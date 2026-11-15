import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // 0. Trust the reverse proxy (Render, Cloudflare, etc.) so rate limiting sees the
  // real client IP instead of the proxy's. Set TRUST_PROXY_HOPS to the number of
  // proxies in front of the app (e.g. 1). Leave unset on localhost.
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS);
  if (Number.isInteger(trustProxyHops) && trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }

  // 1. Apply OWASP security headers (X-Frame-Options, XSS Filter, MIME-Sniffing, etc.)
  app.use(helmet());

  // 2. Enable CORS with explicit origin whitelist
  const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [
        'https://tark.ng',
        'https://www.tark.ng',
        'https://admin.tark.ng',
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:5173',
      ];

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.includes(origin) ||
        (process.env.NODE_ENV !== 'production' && origin.startsWith('http://localhost:'))
      ) {
        return callback(null, true);
      }
      return callback(new Error('Blocked by CORS policy'), false);
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // 3. Strict DTO input validation & stripping
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}
void bootstrap();
