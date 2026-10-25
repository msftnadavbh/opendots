import { ROOT_CONTEXT, SpanStatusCode, type Tracer } from '@opentelemetry/api';

let tracer: Tracer | undefined;
export type TurnOutcome = 'success' | 'error' | 'timeout' | 'cancelled';

export async function initializeRuntimeTelemetry(connectionString?: string) {
  if (!connectionString) return async () => {};
  // A private provider, not global auto-instrumentation: no HTTP, logs, prompts or SDK content.
  const [
    { AzureMonitorTraceExporter },
    { resourceFromAttributes },
    { BasicTracerProvider, BatchSpanProcessor },
  ] = await Promise.all([
    import('@azure/monitor-opentelemetry-exporter'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/sdk-trace-base'),
  ]);
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'opendots-pilot' }),
    spanProcessors: [
      new BatchSpanProcessor(
        new AzureMonitorTraceExporter({
          connectionString,
          disableOfflineStorage: true,
        }),
        {
          maxQueueSize: 128,
          maxExportBatchSize: 32,
          exportTimeoutMillis: 3000,
        },
      ),
    ],
  });
  tracer = provider.getTracer('opendots');
  return async () => {
    tracer = undefined;
    await provider.shutdown();
  };
}

export function startAgentTurn(channel: 'web' | 'channel', target = tracer) {
  const span = target?.startSpan(
    'agent.turn',
    {
      attributes: { 'opendots.channel': channel },
    },
    ROOT_CONTEXT,
  );
  let ended = false;
  return (outcome: TurnOutcome) => {
    if (ended) return;
    ended = true;
    span?.setAttribute('opendots.outcome', outcome);
    span?.setStatus({
      code: outcome === 'success' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    });
    span?.end();
  };
}
