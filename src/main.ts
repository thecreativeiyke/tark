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

  // 2. Enable CORS for mobile apps, web dashboards, and local development
  app.enableCors({
    origin: true,
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
