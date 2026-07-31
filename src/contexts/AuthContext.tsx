import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import {
  authGateway,
  getCurrentProfile,
  updateCurrentProfile,
  type AppProfile,
  type AppSession,
  type AppUser,
  type ProfileUpdate,
} from "@/integrations/gcp/auth";

export type AppRole = "super_admin" | "admin" | "user" | "view_only";
export type ApprovalStatus = "pending" | "approved" | "rejected";

interface AuthContextType {
  approvalStatus: ApprovalStatus | null;
  canDelete: boolean;
  canEdit: boolean;
  canManageUsers: boolean;
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ error: Error | null }>;
  isApproved: boolean;
  loading: boolean;
  profile: AppProfile | null;
  refreshApproval: () => Promise<void>;
  role: AppRole | null;
  sendPasswordReset: (email: string) => Promise<{ error: Error | null }>;
  session: AppSession | null;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: Error | null }>;
  updateProfile: (update: ProfileUpdate) => Promise<{ error: Error | null; profile: AppProfile | null }>;
  user: AppUser | null;
  rejectionReason: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The request could not be completed.");
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AppSession | null>(null);
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshProfile = useCallback(async (): Promise<AppProfile | null> => {
    const current = await authGateway().getSession();
    if (!current) {
      setProfile(null);
      return null;
    }
    const next = await getCurrentProfile();
    setProfile(next);
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    let sequence = 0;
    const unsubscribe = authGateway().onSessionChanged((nextSession) => {
      const currentSequence = ++sequence;
      setSession(nextSession);
      if (!nextSession) {
        setProfile(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      void getCurrentProfile()
        .then((nextProfile) => {
          if (active && currentSequence === sequence) setProfile(nextProfile);
        })
        .catch(() => {
          if (active && currentSequence === sequence) setProfile(null);
        })
        .finally(() => {
          if (active && currentSequence === sequence) setLoading(false);
        });
    });

    const fallbackTimer = window.setTimeout(() => {
      if (active) setLoading(false);
    }, 8_000);

    return () => {
      active = false;
      window.clearTimeout(fallbackTimer);
      unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    try {
      await authGateway().signIn(email, password);
      return { error: null };
    } catch (error) {
      return { error: asError(error) };
    }
  };

  const signUp = async (email: string, password: string, fullName: string) => {
    try {
      await authGateway().signUp(email, password, fullName);
      return { error: null };
    } catch (error) {
      return { error: asError(error) };
    }
  };

  const signOut = async () => {
    await authGateway().signOut();
    setSession(null);
    setProfile(null);
  };

  const refreshApproval = async () => {
    await refreshProfile().catch(() => null);
  };

  const updateProfile = async (update: ProfileUpdate) => {
    try {
      const next = await updateCurrentProfile(update);
      setProfile(next);
      return { error: null, profile: next };
    } catch (error) {
      return { error: asError(error), profile: null };
    }
  };

  const changePassword = async (currentPassword: string, newPassword: string) => {
    try {
      await authGateway().changePassword(currentPassword, newPassword);
      return { error: null };
    } catch (error) {
      return { error: asError(error) };
    }
  };

  const sendPasswordReset = async (email: string) => {
    try {
      await authGateway().sendPasswordReset(email);
      return { error: null };
    } catch (error) {
      return { error: asError(error) };
    }
  };

  const role = profile?.role ?? null;
  const approvalStatus = profile?.approvalStatus ?? null;
  const rejectionReason = profile?.rejectionReason ?? null;
  const isApproved = approvalStatus === "approved";
  const canEdit = isApproved && role !== null && role !== "view_only";
  const canDelete = isApproved && (role === "super_admin" || role === "admin");
  const canManageUsers = isApproved && (role === "super_admin" || role === "admin");

  return (
    <AuthContext.Provider
      value={{
        approvalStatus,
        canDelete,
        canEdit,
        canManageUsers,
        changePassword,
        isApproved,
        loading,
        profile,
        refreshApproval,
        rejectionReason,
        role,
        sendPasswordReset,
        session,
        signIn,
        signOut,
        signUp,
        updateProfile,
        user: session?.user ?? null,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
