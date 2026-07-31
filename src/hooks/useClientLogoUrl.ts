import { useQuery } from "@tanstack/react-query";
import { getClientLogoDataUrl } from "@/integrations/gcp/tenancy";

function normaliseLogoPath(pathOrUrl: string | null | undefined) {
  if (!pathOrUrl) return null;
  if (!pathOrUrl.startsWith("http")) return pathOrUrl;
  const marker = "/storage/v1/object/public/client-logos/";
  const [, path] = pathOrUrl.split(marker);
  return path ? decodeURIComponent(path) : pathOrUrl;
}

export function validateClientLogoUrl(url: string): Promise<string | null> {
  if (typeof Image === "undefined") return Promise.resolve(url);

  return new Promise((resolve) => {
    const image = new Image();
    const timeout = window.setTimeout(() => resolve(null), 5_000);
    const finish = (value: string | null) => {
      window.clearTimeout(timeout);
      resolve(value);
    };
    image.onload = () => finish(url);
    image.onerror = () => finish(null);
    image.src = url;
  });
}

export function useClientLogoUrl(pathOrUrl: string | null | undefined) {
  const path = normaliseLogoPath(pathOrUrl);

  return useQuery({
    queryKey: ["client-logo-url", path],
    queryFn: async () => {
      if (!path) return null;
      const url = path.startsWith("http")
        ? path
        : await getClientLogoDataUrl(path.split("/", 1)[0]);
      return validateClientLogoUrl(url);
    },
    enabled: Boolean(path),
    staleTime: 50 * 60 * 1000,
  });
}
