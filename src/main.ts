import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';

async function bootstrap() {
  // Sin esto, una excepción no controlada (o el proceso muriendo por OOM) no deja rastro en los
  // logs — solo se ve que el servicio dejó de responder. Loguearlo antes de morir facilita
  // diagnosticar la próxima vez.
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
  });

  const app = await NestFactory.create(AppModule);

  // Prefijo global para todas las rutas
  app.setGlobalPrefix('api');

  // WebSocket con Socket.IO (mismo servidor HTTP)
  app.useWebSocketAdapter(new IoAdapter(app));

  // CORS para el frontend Next.js
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3002',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT || 3001;
  await app.listen(port);
}

bootstrap().catch(console.error);
