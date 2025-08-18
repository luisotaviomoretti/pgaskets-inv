/* Central HTTP client using fetch with baseURL, timeout, and JSON defaults */
export interface HttpClientOptions {
  baseURL?: string;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 15000;

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export class HttpClient {
  private baseURL: string;
  private timeoutMs: number;
  private defaultHeaders: Record<string, string>;

  constructor(opts: HttpClientOptions = {}) {
    this.baseURL = (opts.baseURL ?? (typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_API_BASE_URL : '')) || '';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.defaultHeaders ?? {}),
    };
  }

  private buildUrl(path: string): string {
    // Absolute URL passed
    if (/^https?:\/\//i.test(path)) return path;

    // If we have a baseURL, join without losing base path segments
    if (this.baseURL) {
      const base = this.baseURL.replace(/\/+$/g, '');
      const rel = path.replace(/^\/+/, '');
      return `${base}/${rel}`;
    }

    // Fallback to relative path
    return path;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: any;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HttpError('Request timeout', 408)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = this.buildUrl(path);
    const controller = new AbortController();
    const signal = controller.signal;

    const req = fetch(url, {
      ...init,
      headers: { ...this.defaultHeaders, ...(init.headers as any) },
      signal,
    }).then(async (res) => {
      const text = await res.text();
      const data = text ? JSON.parse(text) : undefined;
      if (!res.ok) {
        const message = (data && (data.message || data.error)) || `HTTP ${res.status}`;
        throw new HttpError(message, res.status, data);
      }
      return data as T;
    });

    return this.withTimeout(req, this.timeoutMs);
  }

  get<T>(path: string, init: RequestInit = {}) {
    return this.request<T>(path, { ...init, method: 'GET' });
  }
  post<T>(path: string, body?: any, init: RequestInit = {}) {
    return this.request<T>(path, { ...init, method: 'POST', body: body != null ? JSON.stringify(body) : undefined });
  }
  put<T>(path: string, body?: any, init: RequestInit = {}) {
    return this.request<T>(path, { ...init, method: 'PUT', body: body != null ? JSON.stringify(body) : undefined });
  }
  delete<T>(path: string, init: RequestInit = {}) {
    return this.request<T>(path, { ...init, method: 'DELETE' });
  }
}

export const httpClient = new HttpClient();
