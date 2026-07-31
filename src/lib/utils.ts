import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Safely extract a pathname from a URL-like value. Handles relative paths
 * (e.g. "/blog/post"), bare hostnames, full URLs, and null/empty values.
 * Falls back to the raw input if parsing fails.
 */
export function getUrlPath(value: string | null | undefined): string {
  if (!value) return "—";
  const trimmed = value.trim();
  if (!trimmed) return "—";
  // Already a path — display as-is.
  if (trimmed.startsWith("/")) return trimmed;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).pathname || "/";
  } catch {
    return trimmed;
  }
}
