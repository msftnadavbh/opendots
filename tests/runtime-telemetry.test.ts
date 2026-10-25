import { afterEach, expect, it, vi } from 'vitest';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  initializeRuntimeTelemetry,
  startAgentTurn,
} from '../src/server/runtime-telemetry.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { createShutdown } from '../src/server/shutdown.js';

afterEach(() => vi.restoreAllMocks());
it('records only manual outcome/channel/duration, never content, identifiers or exceptions', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'opendots-pilot' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  for (const outcome of ['success', 'error', 'timeout', 'cancelled'] as const) {
    const end = startAgentTurn('web', provider.getTracer('opendots'));
    end(outcome);
    end('error');
  }
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(4);
  for (const span of spans) {
    expect(span.name).toBe('agent.turn');
    expect(Object.keys(span.attributes).sort()).toEqual([
      'opendots.channel',
      'opendots.outcome',
    ]);
    expect(span.events).toEqual([]);
    expect(span.links).toEqual([]);
    expect(span.status.message).toBeUndefined();
    expect(span.resource.attributes).toEqual({
      'service.name': 'opendots-pilot',
    });
  }
  await provider.shutdown();
});
it('does not enable an exporter without a connection string', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const shutdown = await initializeRuntimeTelemetry();
  startAgentTurn('web')('success');
  await shutdown();
  expect(fetch).not.toHaveBeenCalled();
});
it('readiness exposes only a boolean while all private APIs still require the owner token', async () => {
  const store = new Store(':memory:');
  const config = {
    mode: 'sample' as const,
    baseUrl: 'https://api.openai.com/v1',
  };
  let ready = true;
  const app = createApp({
    store,
    config,
    runner: new Runner(store, config),
    ownerToken: 'private-owner-token',
    isReady: () => ready,
  });
  try {
    let response = await app.request('/readyz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await app.request('/api/state')).status).toBe(401);
    ready = false;
    response = await app.request('/readyz');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ready: false });
  } finally {
    store.close();
  }
});
it('flushes telemetry after HTTP and agent shutdown, before process exit', async () => {
  const order: string[] = [];
  const shutdown = createShutdown({
    stopRunner: () => {
      order.push('runner');
    },
    stopPlatform: async () => {
      order.push('platform');
    },
    closeServer: async () => {
      order.push('http');
    },
    flushTelemetry: async () => {
      order.push('flush');
    },
    exit: () => {
      order.push('exit');
    },
    report: vi.fn(),
  });
  await shutdown();
  expect(order.slice(-2)).toEqual(['flush', 'exit']);
});
