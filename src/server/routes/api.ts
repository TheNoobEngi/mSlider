import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { assertPublicUrl, httpFetch } from '../http.js';
import * as library from '../services/library.js';
import { checkForUpdates, getLastResult, isChecking } from '../services/updater.js';
import { getLoadErrors, getSource, listSources, UnknownSourceError } from '../sources/registry.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Browse results carry raw source URLs; rewrite covers to go through our proxy. */
function withProxiedCovers(results: { sourceId: string; cover?: string }[]) {
  return results.map((result) => ({
    ...result,
    cover: result.cover ? library.proxyUrl(result.sourceId, result.cover) : undefined,
  }));
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const error = new Error(issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request');
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return result.data;
}

export async function registerApi(app: FastifyInstance): Promise<void> {
  // Optional shared-secret gate, so a public deployment is not wide open.
  if (config.authToken) {
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const header = request.headers.authorization;
      const supplied = header?.startsWith('Bearer ') ? header.slice(7) : (request.query as { token?: string })?.token;
      if (supplied !== config.authToken) {
        await reply.code(401).send({ error: 'Unauthorized' });
      }
    });
  }

  app.get('/sources', async () => ({
    sources: listSources().map((source) => source.info()),
    errors: getLoadErrors(),
  }));

  app.get('/search', async (request) => {
    const query = parse(
      z.object({
        source: z.string(),
        q: z.string().min(1),
        page: z.coerce.number().int().positive().default(1),
      }),
      request.query,
    );
    return { results: withProxiedCovers(await getSource(query.source).search(query.q, query.page)) };
  });

  app.get('/latest', async (request) => {
    const query = parse(
      z.object({ source: z.string(), page: z.coerce.number().int().positive().default(1) }),
      request.query,
    );
    return { results: withProxiedCovers(await getSource(query.source).latest(query.page)) };
  });

  app.get('/library', async () => ({ series: library.listLibrary() }));

  app.post('/library', async (request, reply) => {
    const body = parse(z.object({ sourceId: z.string(), url: z.string().url() }), request.body);
    getSource(body.sourceId); // fail fast on an unknown source
    await assertPublicUrl(new URL(body.url));

    const series = library.addSeries(body.sourceId, body.url);
    // First crawl fills in metadata and the backlog without flagging it all as new.
    await library.refreshSeries(series.id, false);
    return reply.code(201).send({ series: library.getSeries(series.id) });
  });

  app.get('/library/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return { series: library.getSeries(id), chapters: library.listChapters(id) };
  });

  app.delete('/library/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    library.removeSeries(id);
    return { ok: true };
  });

  app.patch('/library/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(z.object({ direction: z.enum(['ltr', 'rtl']) }), request.body);
    return { series: library.setDirection(id, body.direction) };
  });

  app.post('/library/:id/refresh', async (request) => {
    const { id } = parse(idParam, request.params);
    const added = await library.refreshSeries(id, true);
    return { added, series: library.getSeries(id), chapters: library.listChapters(id) };
  });

  app.post('/library/:id/read-up-to', async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(z.object({ position: z.number().int().min(0) }), request.body);
    library.markReadUpTo(id, body.position);
    return { chapters: library.listChapters(id) };
  });

  app.get('/chapters/:id/pages', async (request) => {
    const { id } = parse(idParam, request.params);
    const { refresh } = parse(z.object({ refresh: z.coerce.boolean().default(false) }), request.query);
    return library.getChapterPages(id, refresh);
  });

  app.post('/chapters/:id/progress', async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(
      z.object({ page: z.number().int().min(0), completed: z.boolean().default(false) }),
      request.body,
    );
    library.setProgress(id, body.page, body.completed);
    return { ok: true };
  });

  app.post('/chapters/:id/read', async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(z.object({ read: z.boolean() }), request.body);
    library.setChapterRead(id, body.read);
    return { ok: true };
  });

  app.get('/updates', async () => ({
    entries: library.listUpdates(),
    checking: isChecking(),
    last: getLastResult(),
  }));

  app.post('/updates/check', async () => ({ result: await checkForUpdates((msg) => app.log.info(msg)) }));

  app.post('/updates/clear', async () => {
    library.clearUpdates();
    return { ok: true };
  });

  /**
   * Image proxy. The source id in the path decides which hosts are allowed and
   * which headers to send, so a caller cannot use this to fetch arbitrary URLs.
   */
  app.get('/image/:sourceId/:encoded', async (request, reply) => {
    const params = parse(z.object({ sourceId: z.string(), encoded: z.string() }), request.params);
    const source = getSource(params.sourceId);

    let target: URL;
    try {
      target = new URL(Buffer.from(params.encoded, 'base64url').toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'Malformed image URL' });
    }
    if (!source.allowsImageHost(target.hostname)) {
      return reply
        .code(403)
        .send({ error: `Host ${target.hostname} is not allowed for source ${source.id}. Add it to "imageHosts".` });
    }

    const upstream = await httpFetch(target.toString(), { headers: source.imageHeaders(target.toString()) });
    if (!upstream.ok || !upstream.body) {
      return reply.code(upstream.status === 404 ? 404 : 502).send({ error: `Upstream returned ${upstream.status}` });
    }

    const type = upstream.headers.get('content-type') ?? 'image/jpeg';
    if (!type.startsWith('image/')) {
      return reply.code(415).send({ error: `Expected an image, got ${type}` });
    }
    const length = upstream.headers.get('content-length');
    if (length) reply.header('content-length', length);

    return reply
      .header('content-type', type)
      // Pages never change once published; let the browser and any CDN keep them.
      .header('cache-control', 'public, max-age=604800, immutable')
      .send(upstream.body);
  });

  app.setErrorHandler(async (error: Error, _request, reply) => {
    const status =
      (error as { statusCode?: number }).statusCode ??
      (error instanceof UnknownSourceError ? 404 : error instanceof library.NotFoundError ? 404 : 500);
    if (status >= 500) app.log.error({ err: error }, 'request failed');
    return reply.code(status).send({ error: error.message });
  });
}
