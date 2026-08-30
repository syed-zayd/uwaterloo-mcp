/**
 * Fetching course files.
 *
 * The file comes back as it exists on Brightspace — same bytes, same name, same type. What to
 * do with it is the caller's decision: save it, unpack it, compile it, read it. Nothing here
 * converts, extracts, or summarises, because every such transformation is lossy and the caller
 * is better placed to decide whether it is wanted.
 *
 * A PDF is the clearest case. Extracting its text throws away layout, tables, figures, and
 * anything scanned; handing over the PDF lets a client that understands PDFs use all of it.
 */

import { D2LClient } from "./client.js";

/** Beyond this the base64 payload would be too large to return in one response. */
const MAX_BYTES = 20 * 1024 * 1024;

export interface CourseFile {
  fileName: string;
  mimeType: string;
  bytes: number;
  /** Raw contents, base64 encoded. Null only when the file exceeded the size limit. */
  blob: string | null;
  note?: string;
}

/** Best-effort MIME type from the file name, for the ones Brightspace will not name. */
const MIME_BY_EXTENSION: Record<string, string> = {
  cc: "text/x-c++src",
  cpp: "text/x-c++src",
  cxx: "text/x-c++src",
  c: "text/x-csrc",
  h: "text/x-chdr",
  hpp: "text/x-c++hdr",
  hh: "text/x-c++hdr",
  py: "text/x-python",
  java: "text/x-java",
  ts: "text/typescript",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
};

export interface FileStream {
  fileName: string;
  mimeType: string;
  /** Content length as D2L reported it, or null when it did not. */
  bytes: number | null;
  /** The still-unread response body, for piping straight to a caller. */
  body: ReadableStream<Uint8Array>;
}

/**
 * Opens a file for streaming, without reading it into memory.
 *
 * Used by the download endpoint, which is a pass-through: bytes arrive from D2L and leave for
 * the client without ever being buffered or stored here. Nothing is written to disk, and a file
 * of any size costs the same memory.
 */
export async function streamTopicFile(
  client: D2LClient,
  courseId: number,
  topicId: number,
): Promise<FileStream> {
  return streamFile(
    client,
    `/d2l/api/le/${D2LClient.pinnedVersions.le}/${courseId}/content/topics/${topicId}/file`,
    `topic-${topicId}`,
  );
}

/** Opens one file from a particular assignment submission without buffering it. */
export async function streamSubmissionFile(
  client: D2LClient,
  courseId: number,
  folderId: number,
  submissionId: number,
  fileId: number,
): Promise<FileStream> {
  return streamFile(
    client,
    submissionFilePath(courseId, folderId, submissionId, fileId),
    `submission-${submissionId}-file-${fileId}`,
  );
}

async function streamFile(
  client: D2LClient,
  path: string,
  fallbackName: string,
): Promise<FileStream> {
  const response = await client.fetchRaw(path);
  const fileName = fileNameFrom(response) ?? fallbackName;
  const length = Number(response.headers.get("content-length"));

  return {
    fileName,
    mimeType: resolveMimeType(response, fileName),
    bytes: Number.isFinite(length) && length > 0 ? length : null,
    body: response.body ?? new ReadableStream({ start: (c) => c.close() }),
  };
}

/** Metadata only, for callers that need the name and type without the contents. */
export async function getTopicFileMetadata(
  client: D2LClient,
  courseId: number,
  topicId: number,
): Promise<{ fileName: string; mimeType: string; bytes: number | null }> {
  const stream = await streamTopicFile(client, courseId, topicId);
  // The body is not needed; cancelling releases the connection rather than leaking it.
  await stream.body.cancel().catch(() => {});
  return { fileName: stream.fileName, mimeType: stream.mimeType, bytes: stream.bytes };
}

export async function getSubmissionFileMetadata(
  client: D2LClient,
  courseId: number,
  folderId: number,
  submissionId: number,
  fileId: number,
): Promise<{ fileName: string; mimeType: string; bytes: number | null }> {
  const stream = await streamSubmissionFile(client, courseId, folderId, submissionId, fileId);
  await stream.body.cancel().catch(() => {});
  return { fileName: stream.fileName, mimeType: stream.mimeType, bytes: stream.bytes };
}

export async function getTopicFile(
  client: D2LClient,
  courseId: number,
  topicId: number,
): Promise<CourseFile> {
  return getFile(
    client,
    `/d2l/api/le/${D2LClient.pinnedVersions.le}/${courseId}/content/topics/${topicId}/file`,
    `topic-${topicId}`,
  );
}

export async function getSubmissionFile(
  client: D2LClient,
  courseId: number,
  folderId: number,
  submissionId: number,
  fileId: number,
): Promise<CourseFile> {
  return getFile(
    client,
    submissionFilePath(courseId, folderId, submissionId, fileId),
    `submission-${submissionId}-file-${fileId}`,
  );
}

async function getFile(
  client: D2LClient,
  path: string,
  fallbackName: string,
): Promise<CourseFile> {
  const response = await client.fetchRaw(path);
  const fileName = fileNameFrom(response) ?? fallbackName;
  const mimeType = resolveMimeType(response, fileName);
  const buffer = new Uint8Array(await response.arrayBuffer());
  const base = { fileName, mimeType, bytes: buffer.byteLength };

  if (buffer.byteLength > MAX_BYTES) {
    return {
      ...base,
      blob: null,
      note:
        `File is ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${MAX_BYTES / 1024 / 1024} MB limit for a single response. Open it in Brightspace instead.`,
    };
  }

  const blob = Buffer.from(buffer).toString("base64");
  return { ...base, blob };
}

function submissionFilePath(
  courseId: number,
  folderId: number,
  submissionId: number,
  fileId: number,
): string {
  return (
    `/d2l/api/le/${D2LClient.pinnedVersions.le}/${courseId}/dropbox/folders/${folderId}` +
    `/submissions/${submissionId}/files/${fileId}`
  );
}

/**
 * Brightspace labels attachments `d2l/unknowntype` or `application/octet-stream`, neither of
 * which tells a client anything. The extension is the better signal when the header is one of
 * those placeholders.
 */
function resolveMimeType(response: Response, fileName: string): string {
  const reported = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  const isPlaceholder =
    !reported || reported === "application/octet-stream" || reported.startsWith("d2l/");
  if (!isPlaceholder) return reported;

  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/**
 * Brightspace sends the filename twice, RFC 5987 and quoted:
 *
 *   attachment; filename*=UTF-8''goose.cc; filename="goose.cc"
 *
 * The quoted form is read first because it is unambiguous — the encoded form runs to the next
 * `;`, which a naive match swallows along with the rest of the header.
 */
function fileNameFrom(response: Response): string | null {
  const disposition = response.headers.get("content-disposition") ?? "";

  // Brightspace percent-encodes the quoted form too, so "Sample%202.pdf" arrives where the
  // file is really named "Sample 2.pdf". Decoding is safe: a literal % in a filename is
  // encoded as %25, and anything that fails to decode is passed through untouched.
  const quoted = /filename="([^"]+)"/i.exec(disposition)?.[1];
  if (quoted) return decodeMaybe(quoted.trim());

  const encoded = /filename\*=UTF-8''([^;,]+)/i.exec(disposition)?.[1];
  if (encoded) return decodeMaybe(encoded.trim());

  const bare = /filename=([^;,]+)/i.exec(disposition)?.[1];
  return bare ? decodeMaybe(bare.trim()) : null;
}

/** Percent-decodes when the result is valid, leaving malformed input alone. */
function decodeMaybe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
