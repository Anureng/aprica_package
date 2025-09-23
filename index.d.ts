export interface ExporterOptions {
  orgId: string;
  apiKey: string;
  endpoint?: string;
  alertEndpoint?: string;
  service?: string;
  environment?: string;
}

export interface MiddlewareOptions {
  normalizeRoute?: (req: any) => string;
  failureTag?: (req: any, res: any) => string | null;
}

export function apricaMiddleware(opts?: MiddlewareOptions): any;
export function startApricaExporter(opts: ExporterOptions): { flush: () => Promise<void>; stop: () => void; };
export function requestId(): string;
