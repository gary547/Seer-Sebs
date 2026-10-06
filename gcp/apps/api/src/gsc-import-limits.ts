import {
  MAXIMUM_GSC_OBSERVATIONS,
  MAXIMUM_GSC_UPLOAD_BYTES,
} from "../../../packages/contracts/src/gsc-import-limits.js";
import { HttpError } from "../../../packages/runtime/src/http.js";

export function assertGscObservationLimit(count: number, minimum = false): void {
  if (count > MAXIMUM_GSC_OBSERVATIONS) {
    throw new HttpError(
      400,
      "gsc_batch_too_large",
      `This GSC upload contains ${minimum ? "at least " : ""}${count.toLocaleString("en-GB")} query and page observations. The maximum is ${MAXIMUM_GSC_OBSERVATIONS.toLocaleString("en-GB")} per upload. Use a smaller export; no files were imported.`,
    );
  }
}

export function assertGscUploadByteLimit(bytes: number): void {
  if (bytes > MAXIMUM_GSC_UPLOAD_BYTES) {
    throw new HttpError(
      413,
      "gsc_upload_too_large",
      `The selected GSC files total ${(bytes / 1_024 / 1_024).toFixed(2)} MB (${bytes.toLocaleString("en-GB")} bytes). The maximum is 50 MB (${MAXIMUM_GSC_UPLOAD_BYTES.toLocaleString("en-GB")} bytes) per upload. Choose smaller exports; no files were imported.`,
    );
  }
}
