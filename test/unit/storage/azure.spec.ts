import { Readable } from "node:stream";

import { type ContainerClient, RestError } from "@azure/storage-blob";
import { describe, expect, it } from "vitest";

import { AzureStore } from "../../../src/storage/azure.js";
import { StorageOperationError } from "../../../src/storage/errors.js";

class FakeContainer {
  readonly blobs = new Map<string, Buffer>();

  getBlobClient(name: string) {
    return {
      deleteIfExists: async () => {
        this.blobs.delete(name);

        return { succeeded: true };
      },
      downloadToBuffer: async () => {
        const blob = this.blobs.get(name);

        if (!blob) {
          throw new RestError("blob not found", { statusCode: 404 });
        }

        return blob;
      },
      exists: async () => this.blobs.has(name),
    };
  }

  getBlockBlobClient(name: string) {
    return {
      upload: async (body: Uint8Array) => {
        this.blobs.set(name, Buffer.from(body));
      },
      uploadStream: async (stream: Readable) => {
        const chunks: Buffer[] = [];

        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk));
        }

        this.blobs.set(name, Buffer.concat(chunks));
      },
    };
  }

  listBlobsFlat({ prefix = "" }: { prefix?: string } = {}) {
    const names = [...this.blobs.keys()].filter((name) => name.startsWith(prefix)).sort();

    return (async function* () {
      for (const name of names) {
        yield { name };
      }
    })();
  }
}

const createStore = (container: FakeContainer, prefix?: string) =>
  new AzureStore({ client: container as unknown as ContainerClient, prefix });

describe("AzureStore", () => {
  it("round-trips streamed report files under the configured prefix and deletes only the report", async () => {
    const container = new FakeContainer();
    const store = createStore(container, "tenant");

    await store.put("report-1", "index.html", Readable.from([Buffer.from("<html>")]));
    await store.put("report-1", "data/a.json", new Uint8Array([1, 2, 3]));
    await store.put("report-2", "index.html", new Uint8Array([9]));

    expect(await store.get("report-1", "index.html")).toEqual(new Uint8Array(Buffer.from("<html>")));
    expect(await store.exists("report-1", "data/a.json")).toBe(true);
    expect(await store.list("report-1")).toEqual(["data/a.json", "index.html"]);
    expect([...container.blobs.keys()]).toContain("tenant/files/report-1/index.html");

    await store.delete("report-1");

    expect(await store.list("report-1")).toEqual([]);
    expect(await store.get("report-2", "index.html")).toEqual(new Uint8Array([9]));
  });

  it("returns null for missing blobs instead of throwing", async () => {
    const store = createStore(new FakeContainer());

    expect(await store.get("missing", "index.html")).toBeNull();
    expect(await store.getHistory("missing")).toBeNull();
  });

  it("maps throttling and unavailable responses to StorageOperationError", async () => {
    const container = new FakeContainer();

    container.getBlobClient = () =>
      ({
        downloadToBuffer: async () => {
          throw new RestError("unavailable", { statusCode: 503 });
        },
      }) as unknown as ReturnType<FakeContainer["getBlobClient"]>;

    const store = createStore(container);
    const error = await store.get("report-1", "index.html").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StorageOperationError);
    expect(error).toMatchObject({ retryAfter: 1, status: 503 });
  });
});
