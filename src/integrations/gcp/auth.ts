import { getApp, getApps, initializeApp } from "firebase/app";
import {
  EmailAuthProvider,
  confirmPasswordReset,
  getAuth,
  onIdTokenChanged,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updatePassword,
  verifyPasswordResetCode,
  type Auth,
  type User as FirebaseUser,
} from "firebase/auth";

import { seerApiRequest } from "./api";

export interface AppUser {
  email: string | null;
  emailVerified: boolean;
  id: string;
  user_metadata: {
    full_name?: string;
  };
}

export interface AppSession {
  access_token: string;
  expires_at: number | null;
  user: AppUser;
}

export interface AppProfile {
  approvalStatus: "approved" | "pending" | "rejected";
  createdAt: string;
  email: string;
  emailVerified: boolean;
  fullName: string | null;
  id: string;
  notifyUrlMonitor: boolean;
  rejectionReason: string | null;
  role: "super_admin" | "admin" | "user" | "view_only" | null;
  themePreference: "dark" | "light";
}

export interface ProfileUpdate {
  fullName?: string | null;
  notifyUrlMonitor?: boolean;
  themePreference?: "dark" | "light";
}

interface LocalAuthResponse {
  expiresAt: string;
  token: string;
  user: {
    email: string;
    id: string;
  };
}

interface AuthGateway {
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  confirmPasswordReset(code: string, password: string): Promise<void>;
  getSession(): Promise<AppSession | null>;
  onSessionChanged(listener: (session: AppSession | null) => void): () => void;
  sendPasswordReset(email: string): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  signUp(email: string, password: string, fullName: string): Promise<void>;
  verifyPasswordReset(code: string): Promise<string>;
}

const LOCAL_SESSION_KEY = "seer-gcp-local-session";

function localUser(session: LocalAuthResponse): AppUser {
  return {
    email: session.user.email,
    emailVerified: true,
    id: session.user.id,
    user_metadata: {},
  };
}

function localSession(value: LocalAuthResponse): AppSession {
  return {
    access_token: value.token,
    expires_at: Math.floor(new Date(value.expiresAt).getTime() / 1_000),
    user: localUser(value),
  };
}

function readLocalSession(): AppSession | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalAuthResponse;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
      window.localStorage.removeItem(LOCAL_SESSION_KEY);
      return null;
    }
    return localSession(parsed);
  } catch {
    window.localStorage.removeItem(LOCAL_SESSION_KEY);
    return null;
  }
}

class LocalAuthGateway implements AuthGateway {
  async changePassword(): Promise<void> {
    throw new Error("Password changes are only available with Identity Platform.");
  }

  async confirmPasswordReset(): Promise<void> {
    throw new Error("Password reset links are only available with Identity Platform.");
  }

  async getSession(): Promise<AppSession | null> {
    return readLocalSession();
  }

  onSessionChanged(listener: (session: AppSession | null) => void): () => void {
    const onStorage = (event: StorageEvent) => {
      if (event.key === LOCAL_SESSION_KEY) listener(readLocalSession());
    };
    window.addEventListener("storage", onStorage);
    queueMicrotask(() => listener(readLocalSession()));
    return () => window.removeEventListener("storage", onStorage);
  }

  async sendPasswordReset(): Promise<void> {
    throw new Error("Password reset emails are only available with Identity Platform.");
  }

  async signIn(email: string, password: string): Promise<void> {
    const result = await seerApiRequest<LocalAuthResponse>("/v1/local-auth/login", {
      body: JSON.stringify({ email, password }),
      method: "POST",
    });
    window.localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(result));
    window.dispatchEvent(new StorageEvent("storage", { key: LOCAL_SESSION_KEY }));
  }

  async signOut(): Promise<void> {
    window.localStorage.removeItem(LOCAL_SESSION_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: LOCAL_SESSION_KEY }));
  }

  async signUp(email: string, password: string, fullName: string): Promise<void> {
    await seerApiRequest("/v1/auth/register", {
      body: JSON.stringify({ email, fullName, password }),
      method: "POST",
    });
  }

  async verifyPasswordReset(): Promise<string> {
    throw new Error("Password reset links are only available with Identity Platform.");
  }
}

function firebaseAuth(): Auth {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY?.trim();
  const appId = import.meta.env.VITE_FIREBASE_APP_ID?.trim();
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim();
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim();
  if (!apiKey || !appId || !authDomain || !projectId) {
    throw new Error("Firebase web authentication is not configured.");
  }
  const app =
    getApps().length > 0
      ? getApp()
      : initializeApp({ apiKey, appId, authDomain, projectId });
  return getAuth(app);
}

async function firebaseSession(user: FirebaseUser | null): Promise<AppSession | null> {
  if (!user) return null;
  const token = await user.getIdToken();
  const result = await user.getIdTokenResult();
  return {
    access_token: token,
    expires_at: Math.floor(new Date(result.expirationTime).getTime() / 1_000),
    user: {
      email: user.email,
      emailVerified: user.emailVerified,
      id: user.uid,
      user_metadata: {
        ...(user.displayName ? { full_name: user.displayName } : {}),
      },
    },
  };
}

class IdentityPlatformGateway implements AuthGateway {
  private readonly auth = firebaseAuth();

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const user = this.auth.currentUser;
    if (!user?.email) throw new Error("No signed-in user is available.");
    await reauthenticateWithCredential(
      user,
      EmailAuthProvider.credential(user.email, currentPassword),
    );
    await updatePassword(user, newPassword);
  }

  async confirmPasswordReset(code: string, password: string): Promise<void> {
    await confirmPasswordReset(this.auth, code, password);
  }

  async getSession(): Promise<AppSession | null> {
    return firebaseSession(this.auth.currentUser);
  }

  onSessionChanged(listener: (session: AppSession | null) => void): () => void {
    return onIdTokenChanged(this.auth, (user) => {
      void firebaseSession(user).then(listener).catch(() => listener(null));
    });
  }

  async sendPasswordReset(email: string): Promise<void> {
    await sendPasswordResetEmail(this.auth, email, {
      url: `${window.location.origin}/reset-password`,
    });
  }

  async signIn(email: string, password: string): Promise<void> {
    await signInWithEmailAndPassword(this.auth, email, password);
  }

  async signOut(): Promise<void> {
    await firebaseSignOut(this.auth);
  }

  async signUp(email: string, password: string, fullName: string): Promise<void> {
    await seerApiRequest("/v1/auth/register", {
      body: JSON.stringify({ email, fullName, password }),
      method: "POST",
    });
  }

  async verifyPasswordReset(code: string): Promise<string> {
    return verifyPasswordResetCode(this.auth, code);
  }
}

function targetAuthMode(): "identity-platform" | "local" {
  const configured = import.meta.env.VITE_SEER_AUTH_MODE?.trim();
  if (configured === "identity-platform" || configured === "local") return configured;
  return import.meta.env.VITE_FIREBASE_PROJECT_ID ? "identity-platform" : "local";
}

let gateway: AuthGateway | null = null;

export function authGateway(): AuthGateway {
  gateway ??=
    targetAuthMode() === "identity-platform"
      ? new IdentityPlatformGateway()
      : new LocalAuthGateway();
  return gateway;
}

export async function getAccessToken(): Promise<string | null> {
  return (await authGateway().getSession())?.access_token ?? null;
}

export async function getCurrentProfile(): Promise<AppProfile> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  return seerApiRequest<AppProfile>("/v1/me", {}, token);
}

export async function updateCurrentProfile(
  update: ProfileUpdate,
): Promise<AppProfile> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  return seerApiRequest<AppProfile>(
    "/v1/me",
    {
      body: JSON.stringify(update),
      method: "PATCH",
    },
    token,
  );
}
