import { describe, expect, it } from "bun:test";
import { withFileMutationQueue } from "../src/utils/file-mutation-queue.js";
import { truncateHead, formatSize } from "../src/utils/truncate.js";

describe("Phase 1 Primitives: FileMutationQueue & Truncation", () => {
  it("serializes concurrent tasks targeting the same resource key", async () => {
    const order: number[] = [];
    const task = (id: number, delayMs: number) =>
      withFileMutationQueue("project1:fileA", async () => {
        order.push(id * 10);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        order.push(id * 10 + 1);
        return id;
      });

    // Run two tasks concurrently on the same key
    const p1 = task(1, 40);
    const p2 = task(2, 10);
    const results = await Promise.all([p1, p2]);

    expect(results).toEqual([1, 2]);
    // Task 1 must complete before task 2 starts
    expect(order).toEqual([10, 11, 20, 21]);
  });

  it("allows tasks on different keys to execute concurrently", async () => {
    const order: string[] = [];
    const taskA = withFileMutationQueue("project1:fileA", async () => {
      order.push("start-A");
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push("end-A");
    });

    const taskB = withFileMutationQueue("project1:fileB", async () => {
      order.push("start-B");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("end-B");
    });

    await Promise.all([taskA, taskB]);
    // Task B completes before Task A because it is on a different key with shorter delay
    expect(order).toEqual(["start-A", "start-B", "end-B", "end-A"]);
  });

  it("truncates content by line limit cleanly", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    const content = lines.join("\n");
    const result = truncateHead(content, { maxLines: 10, maxBytes: 10000 });

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("lines");
    expect(result.outputLines).toBe(10);
    expect(result.content.split("\n").length).toBe(10);
    expect(result.content).toContain("Line 1");
    expect(result.content).toContain("Line 10");
    expect(result.content).not.toContain("Line 11");
  });

  it("truncates content by byte limit without splitting lines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: ${"x".repeat(30)}`);
    const content = lines.join("\n");
    const result = truncateHead(content, { maxLines: 100, maxBytes: 150 });

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
    expect(result.outputBytes).toBeLessThanOrEqual(150);
    // Every line in content must be a complete line
    const outputLines = result.content.split("\n");
    for (const line of outputLines) {
      expect(line.startsWith("Line ")).toBe(true);
    }
  });

  it("formats byte sizes correctly", () => {
    expect(formatSize(500)).toBe("500B");
    expect(formatSize(2048)).toBe("2.0KB");
    expect(formatSize(1048576 * 2.5)).toBe("2.5MB");
  });
});
