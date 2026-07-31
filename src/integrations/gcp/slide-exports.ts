import { seerApiRequest } from "./api";
import { getAccessToken } from "./auth";

export interface SlideExportResult {
  id: string;
  name: string;
  url: string;
}

export async function createSlideExport(
  projectId: string,
  contentBase64: string,
): Promise<SlideExportResult> {
  return seerApiRequest<SlideExportResult>(
    `/v1/projects/${projectId}/slide-export`,
    {
      body: JSON.stringify({ contentBase64 }),
      method: "POST",
    },
    await getAccessToken(),
  );
}
