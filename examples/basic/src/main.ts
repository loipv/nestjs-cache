import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createAppModule } from './app.module.js';

const app = await NestFactory.create(createAppModule(process.env));
app.enableShutdownHooks();
const port = Number(process.env['PORT'] ?? 3000);
await app.listen(port);
console.log(`listening on http://localhost:${String(port)}`);
