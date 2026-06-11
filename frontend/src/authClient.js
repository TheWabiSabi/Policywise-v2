/**
 * authClient.js
 * Cognito auth client for PolicyWise — matches real backend API shape.
 * access_token in localStorage, refresh_token in httpOnly cookie.
 */

// Empty default lets Vite proxy /auth to the NestJS service during local dev.
const AUTH_BASE = import.meta.env.VITE_AUTH_SERVICE_URL || '';
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

const KEYS = {
  ACCESS: 'pw_access_token',
  USER: 'pw_user',
};

let googleInitialized = false;
let googleSuccessHandler = null;
let googleErrorHandler = null;
let googleExchangePromise = null;

// ── token helpers ─────────────────────────────────────────────────────────
export function getAccessToken() {
  const raw = localStorage.getItem(KEYS.ACCESS);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.join('.');
    if (typeof parsed === 'string') return parsed;
  } catch {
    // Stored value is already a plain JWT string.
  }

  return raw;
}

function setAccessToken(token) {
  if (Array.isArray(token)) {
    localStorage.setItem(KEYS.ACCESS, token.join('.'));
    return;
  }
  if (typeof token === 'string') {
    localStorage.setItem(KEYS.ACCESS, token);
  }
}

function emitAuthChange() {
  window.dispatchEvent(new Event('policywise-auth-change'));
}

function normalizeUser(user = {}) {
  // NestJS/Cognito can return snake_case attributes while the old app expects
  // profile-ish fields. Normalize once so routing/header UI can stay simple.
  const firstName = user.first_name || user.given_name || user.firstName || '';
  const lastName = user.last_name || user.family_name || user.lastName || '';
  const fullName = user.name || user.full_name || `${firstName} ${lastName}`.trim();
  const id = user.sub || user.userId || user.user_id || user.username || user.email || null;

  return {
    ...user,
    id,
    sub: user.sub || user.userId || user.user_id || id,
    email: user.email || '',
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    name: fullName || user.username || user.email || '',
    role: user.role || user['custom:role'] || 'client',
  };
}

function setCachedUser(user) {
  const normalized = normalizeUser(user);
  localStorage.setItem(KEYS.USER, JSON.stringify(normalized));
  return normalized;
}

function decodeJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(Array.from(json, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')));
  } catch {
    return {};
  }
}

export function getCachedUser() {
  try {
    const raw = localStorage.getItem(KEYS.USER);
    return raw ? normalizeUser(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function clearTokens() {
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
  emitAuthChange();
}

export function isLoggedIn() {
  return !!getAccessToken();
}

// ── core fetch — always credentials:include for cookie ────────────────────
async function authFetch(path, options = {}) {
  const { _retry, skipRefresh, ...fetchOptions } = options;
  const token = getAccessToken();
  const headers = { 'Content-Type': 'application/json', ...(fetchOptions.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${AUTH_BASE}${path}`, {
    ...fetchOptions,
    headers,
    credentials: 'include', // sends httpOnly refresh_token cookie
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Try auto-refresh on 401 (only once)
    if (res.status === 401 && !_retry && !skipRefresh) {
      try {
        await auth.refresh();
        return authFetch(path, { ...fetchOptions, _retry: true });
      } catch {
        clearTokens();
        throw Object.assign(new Error('Session expired'), { status: 401 });
      }
    }
    throw Object.assign(new Error(data.message || 'Request failed'), { status: res.status, data });
  }
  return data;
}

// ── auth API ──────────────────────────────────────────────────────────────
export const auth = {
  /** Register — triggers OTP email. Does NOT log in. */
  async signUp({ email, password, first_name, last_name }) {
    return authFetch('/auth/signup', {
      method: 'POST',
      skipRefresh: true,
      body: JSON.stringify({ email, password, first_name, last_name }),
    });
  },

  /** Confirm email with OTP code from signup email */
  async confirmSignUp({ email, code }) {
    return authFetch('/auth/confirm', {
      method: 'POST',
      skipRefresh: true,
      body: JSON.stringify({ email, code }),
    });
  },

  /** Login — stores access_token, refresh_token set as httpOnly cookie by server */
  async signIn({ email, password }) {
    const data = await authFetch('/auth/login', {
      method: 'POST',
      skipRefresh: true,
      body: JSON.stringify({ email, password }),
    });
    if (data.access_token) setAccessToken(data.access_token);
    // Profile hydration is best-effort; routing should proceed once Cognito
    // returns a valid access token even if /auth/profile is unavailable.
    const user = await auth.getUser();
    if (!user) setCachedUser({ email, username: email, role: 'client' });
    emitAuthChange();
    return data;
  },

  /** Refresh — no body needed, browser sends cookie automatically */
  async refresh() {
    const res = await fetch(`${AUTH_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || 'Refresh failed'), { status: res.status });
    if (data.access_token) setAccessToken(data.access_token);
    else throw new Error('Refresh failed');
    emitAuthChange();
    return data;
  },

  /** Get current user from JWT — calls /auth/profile */
  async getUser() {
    if (!getAccessToken()) return null;
    try {
      const user = await authFetch('/auth/profile', { skipRefresh: true });
      return setCachedUser(user);
    } catch {
      // Keep the current route alive when only profile hydration fails.
      return getCachedUser();
    }
  },

  /** Sign out — clears local token + server clears cookies + invalidates Cognito session */
  async signOut() {
    try { await authFetch('/auth/logout', { method: 'POST' }); } catch { /* Logout remains local if the server call fails. */ }
    clearTokens();
    if (window.google?.accounts?.id) {
      window.google.accounts.id.disableAutoSelect();
    }
  },

  async signInWithGoogle(idToken) {
    if (!idToken) {
      throw new Error('Google sign in did not return a credential.');
    }

    if (googleExchangePromise) return googleExchangePromise;

    const claims = decodeJwtPayload(idToken);
    googleExchangePromise = (async () => {
      // Browser gets a Google ID token; NestJS verifies it and returns Cognito tokens.
      const data = await authFetch('/auth/google', {
        method: 'POST',
        skipRefresh: true,
        body: JSON.stringify({ idToken, id_token: idToken }),
      });
      if (data.access_token) setAccessToken(data.access_token);
      // Cache Google profile claims as a fallback so a successful OAuth exchange
      // can advance even before the backend profile endpoint responds.
      const user = await auth.getUser();
      setCachedUser({
        ...user,
        email: user?.email || claims.email,
        name: user?.name || claims.name,
        first_name: user?.first_name || claims.given_name,
        last_name: user?.last_name || claims.family_name,
        username: user?.username || claims.email,
        role: user?.role || 'client',
      });
      emitAuthChange();
      return data;
    })();

    try {
      return await googleExchangePromise;
    } finally {
      googleExchangePromise = null;
    }
  },

  loadGoogleIdentity() {
    // Load Google Identity Services only on the auth screen, keeping index.html clean.
    return new Promise((resolve, reject) => {
      if (!GOOGLE_CLIENT_ID) {
        reject(new Error('Google client ID is not configured.'));
        return;
      }
      if (window.google?.accounts?.id) {
        resolve(window.google);
        return;
      }
      const existing = document.getElementById('google-gsi-script');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.google), { once: true });
        existing.addEventListener('error', () => reject(new Error('Failed to load Google sign-in.')), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.id = 'google-gsi-script';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve(window.google);
      script.onerror = () => reject(new Error('Failed to load Google sign-in.'));
      document.head.appendChild(script);
    });
  },

  async initializeGoogle(onSuccess, onError) {
    googleSuccessHandler = onSuccess;
    googleErrorHandler = onError;

    const google = await auth.loadGoogleIdentity();
    if (googleInitialized) return;

    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async ({ credential }) => {
        try {
          await auth.signInWithGoogle(credential);
          googleSuccessHandler?.();
        } catch (err) {
          googleErrorHandler?.(err);
        }
      },
      auto_select: false,
      cancel_on_tap_outside: true,
      use_fedcm_for_prompt: true,
      itp_support: true,
      ux_mode: 'popup',
    });
    googleInitialized = true;
  },

  promptGoogle() {
    if (!window.google?.accounts?.id) {
      throw new Error('Google sign-in is not ready yet.');
    }
    window.google.accounts.id.prompt();
  },

  async forgotPassword(email) {
    return authFetch('/auth/forgot-password', {
      method: 'POST',
      skipRefresh: true,
      body: JSON.stringify({ email }),
    });
  },

  async confirmForgotPassword({ email, code, new_password }) {
    return authFetch('/auth/forgot-password/confirm', {
      method: 'POST',
      skipRefresh: true,
      body: JSON.stringify({ email, code, new_password }),
    });
  },

  async updatePassword({ new_password }) {
    const body = JSON.stringify({ new_password });
    try {
      return await authFetch('/auth/password', {
        method: 'POST',
        body,
      });
    } catch (err) {
      if (err.status !== 404) throw err;
      return authFetch('/auth/update-password', {
        method: 'POST',
        body,
      });
    }
  },

  // App.jsx compat helpers
  async getSession() {
    const token = getAccessToken();
    const user = getCachedUser();
    return { data: { session: token ? { access_token: token, user } : null } };
  },

  onAuthStateChange(callback) {
    const fire = () => {
      const token = getAccessToken();
      const user = getCachedUser();
      if (token) callback('SIGNED_IN', { access_token: token, user });
      else callback('SIGNED_OUT', null);
    };
    window.addEventListener('storage', fire);
    window.addEventListener('focus', fire);
    window.addEventListener('policywise-auth-change', fire);
    return {
      data: {
        subscription: {
          unsubscribe: () => {
            window.removeEventListener('storage', fire);
            window.removeEventListener('focus', fire);
            window.removeEventListener('policywise-auth-change', fire);
          },
        },
      },
    };
  },
};

// ── API client for FastAPI backend (port 8000) ────────────────────────────
export async function apiFetch(path, options = {}) {
  const token = getAccessToken();
  const apiBase = import.meta.env.VITE_API_BASE_URL || '/api';
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (res.status === 401 && !options._retry) {
    try {
      await auth.refresh();
      return apiFetch(path, { ...options, _retry: true });
    } catch {
      clearTokens();
      throw Object.assign(new Error('Session expired'), { status: 401 });
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.detail || err.message || 'API error'), { status: res.status });
  }
  return res.json();
}
