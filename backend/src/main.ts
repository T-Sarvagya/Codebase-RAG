/**
 * main.ts  —  application entry point ("bootstrap").
 *
 * Creates the Nest app, applies app-wide settings, and starts the HTTP server.
 */
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Allow the Vite dev server (and any frontend origin) to call this API from
  // the browser. For a real deployment you'd lock this down to your frontend URL.
  app.enableCors();

  // Global validation: every request body is checked against its DTO.
  //   whitelist            -> strip properties not declared on the DTO
  //   forbidNonWhitelisted -> 400 if the client sends unexpected properties
  //   transform            -> auto-convert payloads into DTO class instances
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`🚀 Backend listening on http://localhost:${port}`);
}
bootstrap();
