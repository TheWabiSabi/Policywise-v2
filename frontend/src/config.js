// Centralized Application Configuration

const trimTrailingSlash = (value) => value?.replace(/\/$/, '');

const withDefaultApiPath = (value) => {
  if (!value || value.startsWith('/')) return value;
  const trimmed = trimTrailingSlash(value);
  try {
    const url = new URL(trimmed);
    return url.pathname === '/' ? `${trimmed}/api` : trimmed;
  } catch {
    return trimmed;
  }
};

const viteApiBase = import.meta.env.VITE_API_BASE_URL;
const nextPublicApiBase = import.meta.env.NEXT_PUBLIC_API_BASE_URL;

const apiBase = viteApiBase || withDefaultApiPath(nextPublicApiBase) || '/api';

const authServiceUrl =
  import.meta.env.VITE_AUTH_SERVICE_URL ||
  import.meta.env.NEXT_PUBLIC_AUTH_SERVICE_URL ||
  import.meta.env.NEXT_PUBLIC_API_BASE_URL ||
  'http://localhost:3000';

// API Endpoints
export const API_BASE = trimTrailingSlash(apiBase);
export const AUTH_SERVICE_URL = trimTrailingSlash(authServiceUrl);
export const API_BASE_URL = API_BASE;
