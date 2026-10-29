import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, { Express, Request, Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';

let cachedServer: Express | null = null;

export async function bootstrapServer(): Promise<Express> {
  if (cachedServer) {
    return cachedServer;
  }

  const expressApp = express();
  const app = await NestFactory.create(AppModule, new ExpressAdapter(expressApp));

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cookieParser());
  app.enableCors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  });
  app.setGlobalPrefix('api');

  await app.init();
  cachedServer = expressApp;
  return cachedServer;
}

export default async function handler(req: Request, res: Response) {
  const server = await bootstrapServer();
  return server(req, res);
}
