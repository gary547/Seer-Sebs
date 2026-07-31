import { toPng } from "html-to-image";
import { createSlideExport } from "@/integrations/gcp/slide-exports";

export interface ExportResult {
  url: string;
  name: string;
}

export async function exportPerformanceTabToSlides(
  node: HTMLElement,
  projectId: string,
): Promise<ExportResult> {
  const dataUrl = await toPng(node, {
    pixelRatio: 2,
    cacheBust: true,
    backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
  });
  const separator = dataUrl.indexOf(",");
  if (
    separator < 0 ||
    !dataUrl.slice(0, separator).toLowerCase().includes("image/png") ||
    !dataUrl.slice(0, separator).toLowerCase().includes(";base64")
  ) {
    throw new Error("The performance capture did not produce a PNG.");
  }
  return createSlideExport(projectId, dataUrl.slice(separator + 1));
}
