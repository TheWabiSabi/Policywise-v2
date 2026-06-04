/**
 * authClient.js
 * Cognito auth client for PolicyWise — matches real backend API shape.
 * access_token in localStorage, refresh_token in httpOnly cookie.
 */

import { API_BASE, AUTH_SERVICE_URL } from './config';

const AUTH_BASE = AUTH_SERVICE_URL;

const KEYS = {
  ACCESS: 'pw_access_token',
  USER: 'pw_user',
  OAUTH_STATE: 'pw_oauth_state',
};

function normalizeAuthBase() {
  return AUTH_BASE.replace(/\/$/, '');
}

function getRedirectUri() {
  return import.meta.env.VITE_AUTH_REDIRECT_URI || `${window.location.origin}/login`;
}

// ── token helpers ─────────────────────────────────────────────────────────
export function getAccessToken() {
  return localStorage.getItem(KEYS.ACCESS);
}

function setAccessToken(token) {
  localStorage.setItem(KEYS.ACCESS, token);
}

function setStoredUser(user) {
  if (user) localStorage.setItem(KEYS.USER, JSON.stringify(user));
}

export function getStoredUser() {
  const raw = localStorage.getItem(KEYS.USER);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    localStorage.removeItem(KEYS.USER);
    return null;
  }
}

function normalizeUser(user = {}) {
  const id = user.id || user.sub || user.user_id || user.username || user.email || null;
  const email = user.email || user.mail || null;
  const name = user.name || user.full_name || [user.first_name, user.last_name].filter(Boolean).join(' ') || '';

  return {
    ...user,
    id,
    email,
    name,
    user_metadata: {
      ...(user.user_metadata || {}),
      full_name: user.full_name || name,
      username: user.username || email,
    },
  };
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

  const res = await fetch(`${normalizeAuthBase()}${path}`, {
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
      body: JSON.stringify({ email, password, first_name, last_name }),
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
    if (data.user) setStoredUser(normalizeUser(data.user));
    return data;
  },

  /** Refresh — no body needed, browser sends cookie automatically */
  async refresh() {
    const res = await fetch(`${normalizeAuthBase()}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Refresh failed');
    if (data.access_token) setAccessToken(data.access_token);
    if (data.user) setStoredUser(normalizeUser(data.user));
    else throw new Error('Refresh failed');
    return data;
  },

  /** Get current user from JWT — calls /auth/profile */
  async getUser() {
    if (!getAccessToken()) return null;
    try {
      const user = normalizeUser(await authFetch('/auth/profile'));
      setStoredUser(user);
      return user;
    } catch {
      return null;
    }
  },

  /** Sign out — clears local token + server clears cookies + invalidates Cognito session */
  async signOut() {
    try {
      await authFetch('/auth/logout', { method: 'POST' });
    } catch {
      // Local cleanup should still happen if the remote session is already gone.
    }
    clearTokens();
  },

  /** Redirect to the Cognito hosted service Google entrypoint. */
  signInWithGoogle() {
    const state = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    localStorage.setItem(KEYS.OAUTH_STATE, state);

    const params = new URLSearchParams({
      provider: 'Google',
      redirect_uri: getRedirectUri(),
      state,
    });
    const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || import.meta.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (googleClientId) params.set('client_id', googleClientId);

    const googlePath = import.meta.env.VITE_AUTH_GOOGLE_PATH || '/auth/google';
    window.location.assign(`${normalizeAuthBase()}${googlePath}?${params.toString()}`);
  },

  /** Complete hosted OAuth when the auth service redirects back to /login. */
  async completeHostedAuthFromUrl(url = window.location.href) {
    const parsedUrl = new URL(url);
    const hashParams = new URLSearchParams(parsedUrl.hash.replace(/^#/, ''));
    const params = new URLSearchParams(parsedUrl.search);
    const read = (key) => params.get(key) || hashParams.get(key);

    const error = read('error') || read('error_description');
    if (error) throw new Error(error);

    const accessToken = read('access_token') || read('token');
    if (accessToken) {
      setAccessToken(accessToken);
      const userParam = read('user');
      if (userParam) {
        try {
          setStoredUser(normalizeUser(JSON.parse(decodeURIComponent(userParam))));
        } catch {
          // Some auth services return only tokens on callback.
        }
      }
      window.history.replaceState({}, document.title, parsedUrl.pathname);
      return { access_token: accessToken };
    }

    const code = read('code');
    if (!code) return null;

    const returnedState = read('state');
    const storedState = localStorage.getItem(KEYS.OAUTH_STATE);
    if (storedState && returnedState && storedState !== returnedState) {
      throw new Error('Invalid sign-in state. Please try again.');
    }

    const callbackBody = JSON.stringify({
      code,
      redirect_uri: getRedirectUri(),
      state: returnedState,
    });

    let data;
    try {
      data = await authFetch('/auth/callback', {
        method: 'POST',
        body: callbackBody,
      });
    } catch (err) {
      if (err.status !== 404) throw err;
      data = await authFetch('/auth/oauth/callback', {
        method: 'POST',
        body: callbackBody,
      });
    }

    if (data.access_token) setAccessToken(data.access_token);
    if (data.user) setStoredUser(normalizeUser(data.user));
    localStorage.removeItem(KEYS.OAUTH_STATE);
    window.history.replaceState({}, document.title, parsedUrl.pathname);
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
    return {
      data: {
        session: token ? { access_token: token, user: getStoredUser() } : null,
      },
    };
  },

  onAuthStateChange(callback) {
    const fire = () => {
      const token = getAccessToken();
      if (token) callback('SIGNED_IN', { session: { access_token: token, user: getStoredUser() } });
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
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
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
