import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { registerApi } from './routes/api.js';
import { loadSources } from './sources/registry.js';

export interface BuildOptions {
  /** Serve the built client. Off in tests, where only the API matters. */
  serveClient?: boolean;
  logLevel?: string;
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.logLevel ?? process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 1_048_576,
  });

  const { loaded, errors } = loadSources();
  app.log.info(`Loaded ${loaded.length} source(s): ${loaded.map((s) => s.id).join(', ') || '(none)'}`);
  for (const error of errors) app.log.warn(`Source "${error.file}" was skipped: ${error.message}`);
  if (loaded.length === 0) {
    app.log.warn(`No sources loaded. Drop a JSON config into ${config.sourcesDir} — see sources/README.md.`);
  }

  await app.register(registerApi, { prefix: '/api' });

  if (options.serveClient !== false) {
    if (fs.existsSync(path.join(config.clientDir, 'index.html'))) {
      await app.register(fastifyStatic, { root: config.clientDir });
      // Client-side routing: anything that is not an API call falls through to the SPA.
      app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
        return reply.sendFile('index.html');
      });
    } else {
      app.log.warn('No client build found — run "npm run build:client", or "npm run dev" for the Vite dev server.');
    }
  }

  return app;
}
