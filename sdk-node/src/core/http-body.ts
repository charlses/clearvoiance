/**
 * Shared body buffering + finalization used by HTTP adapters.
 *
 * Flow:
 *   1. CappedBuffer accumulates bytes as they stream past. Cap is either the
 *      blob ceiling (if the sink supports blob upload) or the inline ceiling
 *      (no blob backend → truncate at inline).
 *   2. finalizeBody picks one of three paths at response-finish time:
 *      - size <= inline cap                            → inline bytes
 *      - blob backend available and upload succeeds    → BlobRef
 *      - otherwise                                     → truncate to inline cap
 */

import type { Body as PbBody, BlobRef } from "../generated/clearvoiance/v1/event.js";

export interface BlobUploader {
  uploadBlob(data: Buffer, opts?: { contentType?: string }): Promise<BlobRef>;
}

export class CappedBuffer {
  private readonly cap: number;
  private readonly chunks: Buffer[] = [];
  private _size = 0;
  private _truncated = false;

  constructor(cap: number) {
    this.cap = cap;
  }

  push(buf: Buffer): void {
    if (this._truncated || buf.length === 0) return;
    if (this._size + buf.length <= this.cap) {
      this.chunks.push(buf);
      this._size += buf.length;
      return;
    }
    const take = this.cap - this._size;
    if (take > 0) this.chunks.push(buf.subarray(0, take));
    this._size = this.cap;
    this._truncated = true;
  }

  get size(): number {
    return this._size;
  }

  get truncated(): boolean {
    return this._truncated;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this._size);
  }
}

export interface FinalizeOptions {
  maxBodyInlineBytes: number;
  contentType: string | undefined;
  uploader?: BlobUploader;
  /** Called with the Error when blob upload fails; caller logs it. */
  onBlobUploadError?: (err: unknown) => void;
}

export interface FinalizeResult {
  body: PbBody | undefined;
  redactions: string[];
}

export async function finalizeBody(
  buf: CappedBuffer,
  opts: FinalizeOptions,
): Promise<FinalizeResult> {
  if (buf.size === 0) {
    return { body: undefined, redactions: [] };
  }

  const bytes = buf.toBuffer();
  const encoding = inferEncoding(opts.contentType);
  const contentType = opts.contentType ?? "";
  const sizeBytes = BigInt(bytes.length);
  const truncatedAtBuffer = buf.truncated;

  // Small bodies go inline regardless of whether a blob backend is available.
  if (bytes.length <= opts.maxBodyInlineBytes) {
    return {
      body: { inline: bytes, contentType, sizeBytes, encoding },
      redactions: truncatedAtBuffer ? ["body:truncated"] : [],
    };
  }

  // Over the inline cap → try the blob path.
  if (opts.uploader) {
    try {
      const ref = await opts.uploader.uploadBlob(bytes, { contentType: opts.contentType });
      return {
        body: { blob: ref, contentType, sizeBytes, encoding },
        redactions: truncatedAtBuffer ? ["body:truncated"] : [],
      };
    } catch (err) {
      opts.onBlobUploadError?.(err);
      // fall through to truncate
    }
  }

  // No blob backend (or upload failed): truncate to inline cap.
  return {
    body: {
      inline: bytes.subarray(0, opts.maxBodyInlineBytes),
      contentType,
      sizeBytes: BigInt(opts.maxBodyInlineBytes),
      encoding,
    },
    redactions: ["body:truncated"],
  };
}

export function inferEncoding(contentType: string | undefined): string {
  if (!contentType) return "binary";
  if (
    /charset=utf-8/i.test(contentType) ||
    /^(text\/|application\/(json|xml|javascript))/i.test(contentType)
  ) {
    return "utf-8";
  }
  return "binary";
}
