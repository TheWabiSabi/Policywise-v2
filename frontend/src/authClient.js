/**
 * authClient.js
 * Cognito auth client for PolicyWise — matches real backend API shape.
 * access_token in localStorage, refresh_token in httpOnly cookie.
 */

const AUTH_BASE = import.meta.env.VITE_AUTH_SERVICE_URL || 'http://localhost:3000';

const KEYS = {
  ACCESS: 'pw_access_token',
  USER: 'pw_user',
};

// ── token helpers ─────────────────────────────────────────────────────────
export function getAccessToken() {
  return localStorage.getItem(KEYS.ACCESS);
}

function setAccessToken(token) {
  localStorage.setItem(KEYS.ACCESS, token);
}

export function clearTokens() {
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
}

export function isLoggedIn() {
  return !!getAccessToken();
}

// ── core fetch — always credentials:include for cookie ────────────────────
async function authFetch(path, options = {}) {
  const token = getAccessToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${AUTH_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include', // sends httpOnly refresh_token cookie
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Try auto-refresh on 401 (only once)
    if (res.status === 401 && !options._retry) {
      try {
        await auth.refresh();
        return authFetch(path, { ...options, _retry: true });
      } catch (_) {
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
  async signUp({ email, password, first_name, last_name, phone }) {
    return authFetch('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, first_name, last_name, phone }),
    });
  },

  /** Confirm email with OTP code from signup email */
  async confirmSignUp({ email, code }) {
    return authFetch('/auth/confirm', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    });
  },

  /** Login — stores access_token, refresh_token set as httpOnly cookie by server */
  async signIn({ email, password }) {
    const data = await authFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (data.access_token) setAccessToken(data.access_token);
    return data;
  },

  /** Refresh — no body needed, browser sends cookie automatically */
  async refresh() {
    const data = await fetch(`${AUTH_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    }).then((r) => r.json());
    if (data.access_token) setAccessToken(data.access_token);
    else throw new Error('Refresh failed');
    return data;
  },

  /** Get current user from JWT — calls /auth/profile */
  async getUser() {
    if (!getAccessToken()) return null;
    try {
      return await authFetch('/auth/profile');
    } catch (_) {
      return null;
    }
  },

  /** Sign out — clears local token + server clears cookies + invalidates Cognito session */
  async signOut() {
    try { await authFetch('/auth/logout', { method: 'POST' }); } catch (_) {}
    clearTokens();
  },

  async signInWithGoogle(idToken) {
    const data = await authFetch('/auth/google', {
      method: 'POST',
      body: JSON.stringify({ idToken }),
    });
    if (data.access_token) setAccessToken(data.access_token);
    return data;
  },

  async forgotPassword(email) {
    return authFetch('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },

  async confirmForgotPassword({ email, code, new_password }) {
    return authFetch('/auth/forgot-password/confirm', {
      method: 'POST',
      body: JSON.stringify({ email, code, new_password }),
    });
  },

  // App.jsx compat helpers
  async getSession() {
    const token = getAccessToken();
    return { data: { session: token ? { access_token: token } : null } };
  },

  onAuthStateChange(callback) {
    const fire = () => {
      const token = getAccessToken();
      if (token) callback('SIGNED_IN', { session: { access_token: token } });
      else callback('SIGNED_OUT', null);
    };
    window.addEventListener('storage', fire);
    window.addEventListener('focus', fire);
    return {
      data: {
        subscription: {
          unsubscribe: () => {
            window.removeEventListener('storage', fire);
            window.removeEventListener('focus', fire);
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
    } catch (_) {
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
