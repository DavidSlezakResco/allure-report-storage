import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { type ContainerClient, isRestError } from "@azure/storage-blob";

import type { StaticFileData, StaticFileStore, StaticFileWriteOptions } from "../model.js";
import { historyFileName } from "../utils/path.js";
import { StorageOperationError, type StorageHttpStatus } from "./errors.js";

export type AzureContainerClient = Pick<ContainerClient, "getBlobClient" | "getBlockBlobClient" | "listBlobsFlat">;

export interface AzureStoreOptions {
  client: AzureContainerClient;
  prefix?: string;
  reportsPrefix?: string;
  assetsPrefix?: string;
  historyPrefix?: string;
}

const isWebReadableStream = (data: StaticFileData): data is ReadableStream<Uint8Array> =>
  typeof data === "object" &&
  data !== null &&
  "getReader" in data &&
  typeof (data as { getReader?: unknown }).getReader === "function";

const isNodeReadableStream = (data: StaticFileData): data is NodeJS.ReadableStream =>
  typeof data === "object" &&
  data !== null &&
  "pipe" in data &&
  typeof (data as { pipe?: unknown }).pipe === "function";

const toReadable = (data: StaticFileData): Readable | undefined => {
  if (data instanceof Blob) {
    return Readable.fromWeb(data.stream() as unknown as NodeReadableStream<Uint8Array>);
  }

  if (isWebReadableStream(data)) {
    return Readable.fromWeb(data as unknown as NodeReadableStream<Uint8Array>);
  }

  if (isNodeReadableStream(data)) {
    return data as Readable;
  }

  return undefined;
};

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, "");

const joinKey = (...segments: Array<string | undefined>): string =>
  segments
    .map((segment) => (segment === undefined ? "" : trimSlashes(segment)))
    .filter(Boolean)
    .join("/");

const isNotFoundError = (error: unknown): boolean => isRestError(error) && error.statusCode === 404;

const toStorageHttpStatus = (status: number | undefined): StorageHttpStatus | undefined =>
  status === 429 || status === 500 || status === 503 ? status : undefined;

/**
 * Maps transient Azure Blob Storage failures to stable HTTP-facing errors.
 *
 * Unknown failures remain unchanged so the application's normal error handling applies.
 */
const mapAzureError = (error: unknown): unknown => {
  if (!isRestError(error)) {
    return error;
  }

  const status = toStorageHttpStatus(error.statusCode);

  if (status === undefined) {
    return error;
  }

  const retryAfter = status === 500 ? undefined : 1;

  return new StorageOperationError("storage service is temporarily unavailable", status, retryAfter, { cause: error });
};

const runAzureOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    throw mapAzureError(error);
  }
};

export class AzureStore implements StaticFileStore {
  private readonly client: AzureContainerClient;
  private readonly prefix?: string;
  private readonly reportsPrefix: string;
  private readonly assetsPrefix: string;
  private readonly historyPrefix: string;

  constructor(options: AzureStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix;
    this.reportsPrefix = options.reportsPrefix ?? "files";
    this.assetsPrefix = options.assetsPrefix ?? "assets";
    this.historyPrefix = options.historyPrefix ?? "history";
  }

  async put(
    reportId: string,
    relativePath: string,
    data: StaticFileData,
    options?: StaticFileWriteOptions,
  ): Promise<void> {
    await this.putBlob(this.reportObjectKey(reportId, relativePath), data, options);
  }

  async get(reportId: string, relativePath: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.getBlob(this.reportObjectKey(reportId, relativePath));
  }

  async exists(reportId: string, relativePath: string): Promise<boolean> {
    return runAzureOperation(() => this.client.getBlobClient(this.reportObjectKey(reportId, relativePath)).exists());
  }

  async list(reportId: string): Promise<string[]> {
    const prefix = this.reportPrefix(reportId);
    const keys = await this.listBlobKeys(prefix);

    return keys
      .map((key) => key.slice(prefix.length))
      .filter(Boolean)
      .sort();
  }

  async delete(reportId: string): Promise<void> {
    const keys = await this.listBlobKeys(this.reportPrefix(reportId));

    for (const key of keys) {
      await this.deleteBlob(key);
    }
  }

  async putHistory(reportId: string, data: StaticFileData): Promise<void> {
    await this.putBlob(this.historyObjectKey(reportId), data);
  }

  async getHistory(reportId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.getBlob(this.historyObjectKey(reportId));
  }

  async deleteHistory(reportId: string): Promise<void> {
    await this.deleteBlob(this.historyObjectKey(reportId));
  }

  async putAsset(relativePath: string, data: StaticFileData, options?: StaticFileWriteOptions): Promise<void> {
    await this.putBlob(this.assetObjectKey(relativePath), data, options);
  }

  async getAsset(relativePath: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.getBlob(this.assetObjectKey(relativePath));
  }

  private async putBlob(key: string, data: StaticFileData, options?: StaticFileWriteOptions): Promise<void> {
    const blockBlobClient = this.client.getBlockBlobClient(key);
    const blobHTTPHeaders = options?.contentType ? { blobContentType: options.contentType } : undefined;

    if (data instanceof Uint8Array) {
      await runAzureOperation(() => blockBlobClient.upload(data, data.byteLength, { blobHTTPHeaders }));
      return;
    }

    const stream = toReadable(data);

    if (!stream) {
      throw new TypeError("Unsupported storage payload type");
    }

    // The SDK pipes stream bodies without listening for their errors: a failed body stream
    // (e.g. the uploading client disconnects) would crash the process and leave the upload hanging.
    const abortController = new AbortController();
    let bodyError: unknown;

    stream.on("error", (error) => {
      bodyError = error;
      abortController.abort(error);
    });

    try {
      await runAzureOperation(() =>
        blockBlobClient.uploadStream(stream, undefined, undefined, {
          abortSignal: abortController.signal,
          blobHTTPHeaders,
        }),
      );
    } catch (error) {
      throw bodyError ?? error;
    }
  }

  private async getBlob(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      const buffer = await runAzureOperation(() => this.client.getBlobClient(key).downloadToBuffer());

      return new Uint8Array(buffer);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }

      throw error;
    }
  }

  private async deleteBlob(key: string): Promise<void> {
    await runAzureOperation(() => this.client.getBlobClient(key).deleteIfExists());
  }

  private async listBlobKeys(prefix: string): Promise<string[]> {
    return runAzureOperation(async () => {
      const keys: string[] = [];

      for await (const blob of this.client.listBlobsFlat({ prefix })) {
        keys.push(blob.name);
      }

      return keys;
    });
  }

  private reportPrefix(reportId: string): string {
    return `${joinKey(this.prefix, this.reportsPrefix, reportId)}/`;
  }

  private reportObjectKey(reportId: string, relativePath: string): string {
    return joinKey(this.reportPrefix(reportId), relativePath);
  }

  private assetObjectKey(relativePath: string): string {
    return joinKey(this.prefix, this.assetsPrefix, relativePath);
  }

  private historyObjectKey(reportId: string): string {
    return joinKey(this.prefix, this.historyPrefix, historyFileName(reportId));
  }
}
